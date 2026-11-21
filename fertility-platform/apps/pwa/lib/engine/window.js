// Chooses which events feed the engine: the current cycle. Port of buildAnalyzeRequest in
// services/api-gateway/src/recalc.ts (parity-tested against it).
import { addDays } from './engine.js';

export const DEFAULT_WINDOW_DAYS = 90; // when no cycle start has been logged
export const MAX_WINDOW_DAYS = 366; // the engine's hard span limit

export const PERIOD_GAP_DAYS = 10; // a period day starts a new cycle unless another fell within this many days before it
const BIOMARKER = new Set(['BBT', 'HORMONE', 'MUCUS']);
const WINDOW_KINDS = new Set(['BBT', 'HORMONE', 'MUCUS', 'CYCLE', 'PERIOD']);

/** Cycle starts: explicit CYCLE dates plus the first day of each run of PERIOD days. */
export function cycleStartDates(rows) {
  const period = new Set(rows.filter((r) => r.kind === 'PERIOD').map((r) => r.log_date));
  const starts = new Set(rows.filter((r) => r.kind === 'CYCLE').map((r) => r.log_date));
  for (const d of period) {
    let recent = false;
    for (let k = 1; k <= PERIOD_GAP_DAYS && !recent; k++) recent = period.has(addDays(d, -k));
    if (!recent) starts.add(d);
  }
  return [...starts].sort();
}

/** rows: [{ kind, log_date, payload }] effective state. Returns { request, windowStart } or null when no biomarker data. */
export function buildWindow(allRows) {
  const rows = allRows.filter((r) => WINDOW_KINDS.has(r.kind));
  const biomarker = rows.filter((r) => BIOMARKER.has(r.kind));
  if (!biomarker.length) return null;
  const latest = rows.reduce((m, r) => (r.log_date > m ? r.log_date : m), '0000-00-00');
  const starts = cycleStartDates(rows).filter((d) => d <= latest);
  const cycleStart = starts.length ? starts[starts.length - 1] : addDays(latest, -(DEFAULT_WINDOW_DAYS - 1));
  const floor = addDays(latest, -(MAX_WINDOW_DAYS - 1));
  const windowStart = cycleStart > floor ? cycleStart : floor;
  const inWindow = biomarker.filter((r) => r.log_date >= windowStart);
  if (!inWindow.length) return null;

  const request = { bbt: [], hormones: [], mucus: [] };
  for (const r of inWindow) {
    const p = r.payload;
    if (r.kind === 'BBT') request.bbt.push({ day: r.log_date, temp_c: Number(p.temp_c), sleep_disrupted: p.sleep_disrupted === true });
    else if (r.kind === 'HORMONE') {
      const h = { day: r.log_date };
      for (const k of ['lh_miu_ml', 'e3g_ng_ml', 'pdg_ug_ml']) if (typeof p[k] === 'number') h[k] = p[k];
      request.hormones.push(h);
    } else request.mucus.push({ day: r.log_date, score: Number(p.score) });
  }
  return { request, windowStart };
}
