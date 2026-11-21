import { createHash } from 'node:crypto';
import { canonicalJson, type PredictionSnapshot, type PullResponse, type PushResponse, type ServerEvent, type SyncEvent } from '@fertility/sync-protocol';
import { insertAuditRows, type AuditRow } from './audit.js';
import { withTx, type Pool } from './db.js';
import type { AccessContext } from './types.js';

export type ConsentResult = 'granted' | 'already_active';
export type RevokeResult = 'revoked' | 'not_found';

/** Everything the HTTP layer needs from the PHI database. */
export interface PhiStore {
  pushEvents(ctx: AccessContext, subjectId: string, events: SyncEvent[]): Promise<PushResponse>;
  /** Returns null when a clinician has no active consent for the subject. */
  pullEvents(ctx: AccessContext, subjectId: string, cursor: number, limit: number): Promise<PullResponse | null>;
  grantConsent(ctx: AccessContext, subjectId: string, clinicianId: string): Promise<ConsentResult>;
  revokeConsent(ctx: AccessContext, subjectId: string, clinicianId: string): Promise<RevokeResult>;
  /** Audit a refused request (committed on its own; there is no PHI transaction). */
  recordDenied(ctx: AccessContext, action: string, resourceType: string, subjectId: string | null): Promise<void>;
  ping(): Promise<void>;
}

/** SHA-256 over the full canonical content of an event, so a reused event_id with any change is detectable. */
export function eventHash(ev: SyncEvent): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        event_id: ev.event_id,
        device_id: ev.device_id,
        lamport: ev.lamport,
        client_ts: ev.client_ts,
        kind: ev.kind,
        op: ev.op,
        log_date: ev.log_date,
        payload: 'payload' in ev ? ev.payload : {},
      }),
    )
    .digest('hex');
}

function sessionFor(ctx: AccessContext, ownSubject: string | null): Record<string, string> {
  return {
    'app.role': ctx.actor.role,
    'app.actor_id': ctx.actor.id,
    'app.subject_id': ctx.actor.role === 'patient' && ownSubject ? ownSubject : '',
  };
}

function auditRow(ctx: AccessContext, p: Pick<AuditRow, 'operation' | 'action' | 'resourceType' | 'resourceId' | 'subjectId' | 'outcome'>): AuditRow {
  return { actorId: ctx.actor.id, actorRole: ctx.actor.role, ipHash: ctx.meta.ipHash, requestId: ctx.meta.requestId, ...p };
}

export class PgPhiStore implements PhiStore {
  constructor(private readonly pool: Pool) {}

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async pushEvents(ctx: AccessContext, subjectId: string, events: SyncEvent[]): Promise<PushResponse> {
    const hashes = events.map(eventHash);
    const rows = events.map((ev, i) => ({
      event_id: ev.event_id,
      device_id: ev.device_id,
      lamport: ev.lamport,
      client_ts: ev.client_ts,
      kind: ev.kind,
      op: ev.op,
      log_date: ev.log_date,
      payload: 'payload' in ev ? ev.payload : {},
      payload_hash: hashes[i],
    }));

    return withTx(this.pool, sessionFor(ctx, subjectId), async (c) => {
      // Serialise pushes per subject so server_seq order equals commit order;
      // otherwise a pull cursor could skip an event that commits late.
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [subjectId]);

      const inserted = await c.query<{ event_id: string }>(
        `INSERT INTO clinical_data.biomarker_events
           (subject_id, event_id, device_id, lamport, client_ts, kind, op, log_date, payload, payload_hash)
         SELECT $1, e.event_id, e.device_id, e.lamport, e.client_ts, e.kind, e.op, e.log_date, e.payload, e.payload_hash
           FROM jsonb_to_recordset($2::jsonb) AS e(event_id uuid, device_id uuid, lamport bigint, client_ts timestamptz,
                                                    kind text, op text, log_date date, payload jsonb, payload_hash text)
         ON CONFLICT (subject_id, event_id) DO NOTHING
         RETURNING event_id::text AS event_id`,
        [subjectId, JSON.stringify(rows)],
      );
      const insertedIds = new Set(inserted.rows.map((r) => r.event_id));

      const existing = new Map<string, string>();
      if (insertedIds.size < events.length) {
        const res = await c.query<{ event_id: string; payload_hash: string }>(
          `SELECT event_id::text AS event_id, payload_hash FROM clinical_data.biomarker_events
            WHERE subject_id = $1 AND event_id = ANY($2::uuid[])`,
          [subjectId, events.map((e) => e.event_id)],
        );
        for (const r of res.rows) existing.set(r.event_id, r.payload_hash);
      }

      const accepted: string[] = [];
      const duplicates: string[] = [];
      const conflicts: PushResponse['conflicts'] = [];
      const seen = new Set<string>();
      const audits: AuditRow[] = [];
      events.forEach((ev, i) => {
        const id = ev.event_id.toLowerCase();
        const first = !seen.has(id);
        seen.add(id);
        const base = { operation: 'WRITE' as const, resourceType: 'biomarker_events', resourceId: id, subjectId };
        if (first && insertedIds.has(id)) {
          accepted.push(id);
          audits.push(auditRow(ctx, { ...base, action: 'sync.push', outcome: 'SUCCESS' }));
        } else if (existing.get(id) === hashes[i]) {
          duplicates.push(id);
          audits.push(auditRow(ctx, { ...base, action: 'sync.push.duplicate', outcome: 'SUCCESS' }));
        } else {
          conflicts.push({ event_id: id, reason: 'EVENT_ID_REUSED_WITH_DIFFERENT_CONTENT' });
          audits.push(auditRow(ctx, { ...base, action: 'sync.push.conflict', outcome: 'DENIED' }));
        }
      });

      if (accepted.length > 0) {
        await c.query(
          `INSERT INTO clinical_data.recalc_jobs (subject_id) VALUES ($1)
           ON CONFLICT (subject_id) DO UPDATE SET requested_at = now()`,
          [subjectId],
        );
      }
      const lam = await c.query<{ m: string }>(
        'SELECT coalesce(max(lamport), 0)::text AS m FROM clinical_data.biomarker_events WHERE subject_id = $1',
        [subjectId],
      );
      await insertAuditRows(c, audits);

      return {
        accepted,
        duplicates,
        conflicts,
        server_lamport: Number(lam.rows[0]?.m ?? 0),
        recalculation: accepted.length > 0 ? 'queued' : 'none',
      } satisfies PushResponse;
    });
  }

  async pullEvents(ctx: AccessContext, subjectId: string, cursor: number, limit: number): Promise<PullResponse | null> {
    const isPatient = ctx.actor.role === 'patient';
    return withTx(this.pool, sessionFor(ctx, isPatient ? subjectId : null), async (c) => {
      const base = { operation: 'READ' as const, resourceType: 'biomarker_events', subjectId };

      if (!isPatient) {
        const consent = await c.query(
          `SELECT 1 FROM clinical_data.care_relationships
            WHERE clinician_id = $1 AND subject_id = $2 AND revoked_at IS NULL`,
          [ctx.actor.id, subjectId],
        );
        if (consent.rowCount === 0) {
          await insertAuditRows(c, [auditRow(ctx, { ...base, action: 'sync.pull', resourceId: null, outcome: 'DENIED' })]);
          return null;
        }
      }

      const res = await c.query<{
        server_seq: string; event_id: string; device_id: string; lamport: string; client_ts: string;
        kind: ServerEvent['kind']; op: ServerEvent['op']; log_date: string; payload: Record<string, unknown>;
      }>(
        // Columns are qualified (e.*) in WHERE/ORDER BY on purpose: an unqualified
        // `ORDER BY server_seq` would bind to the text-cast output column and sort
        // lexicographically (1, 10, 11, ..., 2), breaking cursor pagination.
        `SELECT e.server_seq::text AS server_seq, e.event_id::text AS event_id, e.device_id::text AS device_id,
                e.lamport::text AS lamport,
                to_char(e.client_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS client_ts,
                e.kind, e.op, e.log_date::text AS log_date, e.payload
           FROM clinical_data.biomarker_events e
          WHERE e.subject_id = $1 AND e.server_seq > $2
          ORDER BY e.server_seq
          LIMIT $3`,
        [subjectId, cursor, limit + 1],
      );
      const hasMore = res.rows.length > limit;
      const page = res.rows.slice(0, limit);
      const events: ServerEvent[] = page.map((r) => ({
        server_seq: Number(r.server_seq),
        event_id: r.event_id,
        device_id: r.device_id,
        lamport: Number(r.lamport),
        client_ts: r.client_ts,
        kind: r.kind,
        op: r.op,
        log_date: r.log_date,
        payload: r.payload,
      }));

      const lam = await c.query<{ m: string }>(
        'SELECT coalesce(max(lamport), 0)::text AS m FROM clinical_data.biomarker_events WHERE subject_id = $1',
        [subjectId],
      );
      const predictions = hasMore ? null : await this.latestPredictions(c, subjectId);

      await insertAuditRows(c, [
        auditRow(ctx, {
          ...base,
          action: 'sync.pull',
          resourceId: events.length ? `server_seq:${events[0]!.server_seq}-${events[events.length - 1]!.server_seq}` : `server_seq:>${cursor}`,
          outcome: 'SUCCESS',
        }),
      ]);

      return {
        events,
        next_cursor: events.length ? events[events.length - 1]!.server_seq : cursor,
        has_more: hasMore,
        server_lamport: Number(lam.rows[0]?.m ?? 0),
        predictions,
      };
    });
  }

  private async latestPredictions(c: import('pg').PoolClient, subjectId: string): Promise<PredictionSnapshot | null> {
    const run = await c.query<{
      run_id: string; algorithm_version: string; computed_at: string;
      ovulation_confirmed_on: string | null; anovulatory_pattern_suspected: boolean;
    }>(
      `SELECT run_id::text, algorithm_version,
              to_char(last_computed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS computed_at,
              ovulation_confirmed_on::text AS ovulation_confirmed_on, anovulatory_pattern_suspected
         FROM clinical_data.prediction_runs
        WHERE subject_id = $1
        ORDER BY last_computed_at DESC, run_id
        LIMIT 1`,
      [subjectId],
    );
    const r = run.rows[0];
    if (!r) return null;
    const days = await c.query<{ log_date: string; status: PredictionSnapshot['days'][number]['status']; flags: string[]; reasoning: string[] }>(
      `SELECT p.log_date::text AS log_date, p.status, p.flags, p.reasoning
         FROM clinical_data.predictions p WHERE p.run_id = $1 ORDER BY p.log_date`,
      [r.run_id],
    );
    return {
      algorithm_version: r.algorithm_version,
      computed_at: r.computed_at,
      ovulation_confirmed_on: r.ovulation_confirmed_on,
      anovulatory_pattern_suspected: r.anovulatory_pattern_suspected,
      days: days.rows,
    };
  }

  async grantConsent(ctx: AccessContext, subjectId: string, clinicianId: string): Promise<ConsentResult> {
    return withTx(this.pool, sessionFor(ctx, subjectId), async (c) => {
      const res = await c.query(
        `INSERT INTO clinical_data.care_relationships (clinician_id, subject_id) VALUES ($1, $2)
         ON CONFLICT (clinician_id, subject_id) WHERE revoked_at IS NULL DO NOTHING`,
        [clinicianId, subjectId],
      );
      const granted = (res.rowCount ?? 0) > 0;
      await insertAuditRows(c, [
        auditRow(ctx, { operation: 'WRITE', action: 'consent.grant', resourceType: 'care_relationships', resourceId: clinicianId, subjectId, outcome: 'SUCCESS' }),
      ]);
      return granted ? 'granted' : 'already_active';
    });
  }

  async revokeConsent(ctx: AccessContext, subjectId: string, clinicianId: string): Promise<RevokeResult> {
    return withTx(this.pool, sessionFor(ctx, subjectId), async (c) => {
      const res = await c.query(
        `UPDATE clinical_data.care_relationships SET revoked_at = now()
          WHERE clinician_id = $1 AND subject_id = $2 AND revoked_at IS NULL`,
        [clinicianId, subjectId],
      );
      await insertAuditRows(c, [
        auditRow(ctx, { operation: 'WRITE', action: 'consent.revoke', resourceType: 'care_relationships', resourceId: clinicianId, subjectId, outcome: 'SUCCESS' }),
      ]);
      return (res.rowCount ?? 0) > 0 ? 'revoked' : 'not_found';
    });
  }

  async recordDenied(ctx: AccessContext, action: string, resourceType: string, subjectId: string | null): Promise<void> {
    await withTx(this.pool, {}, (c) =>
      insertAuditRows(c, [auditRow(ctx, { operation: 'WRITE', action, resourceType, resourceId: null, subjectId, outcome: 'DENIED' })]),
    );
  }
}
