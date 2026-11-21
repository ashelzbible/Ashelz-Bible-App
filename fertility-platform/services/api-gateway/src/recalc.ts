import type { AnalyzeRequest, EngineClient } from './engine-client.js';
import { EngineRejectedError } from './engine-client.js';
import { insertAuditRows } from './audit.js';
import { withTx, type Pool } from './db.js';

export const DEFAULT_WINDOW_DAYS = 90; // when no cycle start has been logged
export const MAX_WINDOW_DAYS = 366; // the engine's hard span limit
const LOCK_MINUTES = 5;
const MAX_ATTEMPTS = 8;

export interface EffectiveRow {
  kind: 'BBT' | 'HORMONE' | 'MUCUS' | 'CYCLE';
  log_date: string; // YYYY-MM-DD
  payload: Record<string, unknown>;
}

function shiftDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Turn a subject's effective event state into one engine request covering the
 * current cycle: from the latest CYCLE start on/before the last datum (or the
 * last 90 days if none is logged), never longer than the engine's 366-day
 * limit. Returns null when the window holds no biomarker data, in which case
 * existing predictions are kept untouched.
 */
export function buildAnalyzeRequest(rows: readonly EffectiveRow[]): { request: AnalyzeRequest; windowStart: string } | null {
  const biomarker = rows.filter((r) => r.kind !== 'CYCLE');
  if (biomarker.length === 0) return null;

  const latest = rows.reduce((m, r) => (r.log_date > m ? r.log_date : m), '0000-00-00');
  const starts = rows.filter((r) => r.kind === 'CYCLE' && r.log_date <= latest).map((r) => r.log_date).sort();
  const cycleStart = starts[starts.length - 1] ?? shiftDays(latest, -(DEFAULT_WINDOW_DAYS - 1));
  const floor = shiftDays(latest, -(MAX_WINDOW_DAYS - 1));
  const windowStart = cycleStart > floor ? cycleStart : floor;

  const inWindow = biomarker.filter((r) => r.log_date >= windowStart);
  if (inWindow.length === 0) return null;

  const request: AnalyzeRequest = { bbt: [], hormones: [], mucus: [] };
  for (const r of inWindow) {
    const p = r.payload;
    if (r.kind === 'BBT') {
      request.bbt.push({ day: r.log_date, temp_c: Number(p.temp_c), sleep_disrupted: p.sleep_disrupted === true });
    } else if (r.kind === 'HORMONE') {
      const h: AnalyzeRequest['hormones'][number] = { day: r.log_date };
      if (typeof p.lh_miu_ml === 'number') h.lh_miu_ml = p.lh_miu_ml;
      if (typeof p.e3g_ng_ml === 'number') h.e3g_ng_ml = p.e3g_ng_ml;
      if (typeof p.pdg_ug_ml === 'number') h.pdg_ug_ml = p.pdg_ug_ml;
      request.hormones.push(h);
    } else {
      request.mucus.push({ day: r.log_date, score: Number(p.score) });
    }
  }
  return { request, windowStart };
}

interface Job {
  subjectId: string;
  requestedAt: string; // exact microsecond text from Postgres
  attempts: number;
}

/**
 * Asynchronous recalculation worker. It connects as `engine_worker`, which can
 * read events and write predictions but cannot alter events or their history.
 */
export class RecalcWorker {
  constructor(
    private readonly pool: Pool,
    private readonly engine: EngineClient,
    private readonly log: { info: (o: object, m?: string) => void; error: (o: object, m?: string) => void } = { info() {}, error() {} },
  ) {}

  /** Claim and process at most one job. Returns false when the queue is empty. */
  async runOnce(): Promise<boolean> {
    const job = await this.claim();
    if (!job) return false;
    try {
      await this.process(job);
      await this.complete(job);
    } catch (err) {
      await this.fail(job, err);
    }
    return true;
  }

  async drain(max = 1000): Promise<number> {
    let n = 0;
    while (n < max && (await this.runOnce())) n++;
    return n;
  }

  /** Poll until `signal` aborts. */
  async start(signal: AbortSignal, idleMs = 1000): Promise<void> {
    while (!signal.aborted) {
      let worked = false;
      try {
        worked = await this.runOnce();
      } catch (err) {
        this.log.error({ err: (err as Error).message }, 'recalc loop error');
      }
      if (!worked) await new Promise<void>((r) => { const t = setTimeout(r, idleMs); signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
    }
  }

  private async claim(): Promise<Job | null> {
    const res = await withTx(this.pool, {}, (c) =>
      c.query<{ subject_id: string; requested_at: string; attempts: number }>(
        `UPDATE clinical_data.recalc_jobs
            SET locked_until = now() + make_interval(mins => $1), attempts = attempts + 1
          WHERE subject_id = (
                  SELECT subject_id FROM clinical_data.recalc_jobs
                   WHERE locked_until IS NULL OR locked_until < now()
                   ORDER BY requested_at
                   LIMIT 1
                   FOR UPDATE SKIP LOCKED)
      RETURNING subject_id, requested_at::text AS requested_at, attempts`,
        [LOCK_MINUTES],
      ),
    );
    const r = res.rows[0];
    return r ? { subjectId: r.subject_id, requestedAt: r.requested_at, attempts: r.attempts } : null;
  }

  private async process(job: Job): Promise<void> {
    const rows = await withTx(this.pool, {}, async (c) => {
      const res = await c.query<EffectiveRow>(
        `SELECT kind, log_date::text AS log_date, payload, op FROM (
           SELECT DISTINCT ON (kind, log_date) kind, log_date, payload, op
             FROM clinical_data.biomarker_events
            WHERE subject_id = $1
            ORDER BY kind, log_date, lamport DESC, device_id DESC, event_id DESC) latest
          WHERE op = 'SET'`,
        [job.subjectId],
      );
      await insertAuditRows(c, [
        { actorId: null, actorRole: 'engine', ipHash: null, operation: 'READ', action: 'recalc.load_events', resourceType: 'biomarker_events', resourceId: null, subjectId: job.subjectId, requestId: null, outcome: 'SUCCESS' },
      ]);
      return res.rows;
    });

    const built = buildAnalyzeRequest(rows);
    if (!built) return;

    const result = await this.engine.analyze(built.request);

    await withTx(this.pool, {}, async (c) => {
      const run = await c.query<{ run_id: string; inserted: boolean }>(
        `INSERT INTO clinical_data.prediction_runs
           (subject_id, algorithm_version, input_hash, ovulation_confirmed_on, anovulatory_pattern_suspected)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (subject_id, algorithm_version, input_hash) DO UPDATE SET last_computed_at = now()
         RETURNING run_id::text AS run_id, (xmax = 0) AS inserted`,
        [job.subjectId, result.algorithm_version, result.input_hash, result.ovulation_confirmed_on, result.anovulatory_pattern_suspected],
      );
      const { run_id: runId, inserted } = run.rows[0]!;
      if (inserted && result.days.length > 0) {
        await c.query(
          `INSERT INTO clinical_data.predictions (run_id, subject_id, log_date, status, flags, reasoning)
           SELECT $1::uuid, $2, d.day, d.status, d.flags, d.reasoning
             FROM jsonb_to_recordset($3::jsonb) AS d(day date, status text, flags jsonb, reasoning jsonb)`,
          [runId, job.subjectId, JSON.stringify(result.days)],
        );
      }
      await insertAuditRows(c, [
        { actorId: null, actorRole: 'engine', ipHash: null, operation: 'WRITE', action: inserted ? 'recalc.store' : 'recalc.unchanged', resourceType: 'prediction_runs', resourceId: runId, subjectId: job.subjectId, requestId: null, outcome: 'SUCCESS' },
      ]);
    });
  }

  /** Delete the job unless new events arrived meanwhile; then release the lock so it re-runs. */
  private async complete(job: Job): Promise<void> {
    await withTx(this.pool, {}, async (c) => {
      const del = await c.query('DELETE FROM clinical_data.recalc_jobs WHERE subject_id = $1 AND requested_at = $2::timestamptz', [job.subjectId, job.requestedAt]);
      if ((del.rowCount ?? 0) === 0) {
        await c.query('UPDATE clinical_data.recalc_jobs SET locked_until = NULL, attempts = 0 WHERE subject_id = $1', [job.subjectId]);
      }
    });
  }

  private async fail(job: Job, err: unknown): Promise<void> {
    const permanent = err instanceof EngineRejectedError || job.attempts >= MAX_ATTEMPTS;
    // Never store err.message verbatim beyond a short code: it could echo PHI.
    const code = err instanceof EngineRejectedError ? 'ENGINE_REJECTED' : 'TRANSIENT_ERROR';
    this.log.error({ subject: job.subjectId.slice(0, 8), code, attempts: job.attempts, permanent }, 'recalculation failed');
    await withTx(this.pool, {}, async (c) => {
      await insertAuditRows(c, [
        { actorId: null, actorRole: 'engine', ipHash: null, operation: 'WRITE', action: 'recalc.store', resourceType: 'prediction_runs', resourceId: null, subjectId: job.subjectId, requestId: null, outcome: 'ERROR' },
      ]);
      if (permanent) {
        await c.query('DELETE FROM clinical_data.recalc_jobs WHERE subject_id = $1 AND requested_at = $2::timestamptz', [job.subjectId, job.requestedAt]);
      } else {
        await c.query(
          `UPDATE clinical_data.recalc_jobs SET last_error = $2, locked_until = now() + make_interval(mins => $3)
            WHERE subject_id = $1`,
          [job.subjectId, code, job.attempts * job.attempts],
        );
      }
    });
  }
}
