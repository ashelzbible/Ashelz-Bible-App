// Cycle history derived from the device's own entries (period days, temperature shifts).
import { effectiveEvents } from '../../vendor/sync-protocol/order.js';
import { analyzeBbt } from '../engine/engine.js';
import { cycleStartDates } from '../engine/window.js';
import { addDays, diffDays } from './dates.js';

export const MIN_PLAUSIBLE_CYCLE = 15;
export const MAX_PLAUSIBLE_CYCLE = 60;

export const effective = (events) => effectiveEvents(events);
export const byKind = (eff, kind) => eff.filter((e) => e.kind === kind);
export const periodDays = (eff) => new Set(byKind(eff, 'PERIOD').map((e) => e.log_date));

/** Last day of the bleed that began at `start`: the chain of period days with gaps of at most 2 days. */
export function periodEnd(start, period) {
  let end = start;
  for (let d = addDays(start, 1), gap = 0; gap <= 2; d = addDays(d, 1)) {
    if (period.has(d)) { end = d; gap = 0; } else gap++;
  }
  return period.has(start) ? end : null;
}

/** Every cycle from the first logged start to today. The last one is the current (incomplete) cycle. */
export function cycleList(eff, today) {
  const starts = cycleStartDates(eff).filter((d) => d <= today);
  const period = periodDays(eff);
  return starts.map((start, i) => {
    const next = starts[i + 1] ?? null;
    const end = periodEnd(start, period);
    return {
      start, next, current: next === null,
      length: next ? diffDays(next, start) : null,
      periodEnd: end, periodLength: end ? diffDays(end, start) + 1 : null,
    };
  });
}

export const plausible = (n) => n >= MIN_PLAUSIBLE_CYCLE && n <= MAX_PLAUSIBLE_CYCLE;

/** Summary of completed cycle lengths (implausible ones, e.g. a forgotten month, are ignored). */
export function lengthStats(cycles) {
  const lens = cycles.filter((c) => c.length !== null && plausible(c.length)).map((c) => c.length);
  if (!lens.length) return { n: 0, avg: null, min: null, max: null, consistent: null };
  const recent = lens.slice(-6);
  const avg = Math.round(recent.reduce((a, b) => a + b, 0) / recent.length);
  const min = Math.min(...lens), max = Math.max(...lens);
  return { n: lens.length, avg, min, max, consistent: lens.length >= 2 ? max - min <= 7 : null };
}

/** Days of the cycle on which temperature shifts showed ovulation likely occurred, across logged cycles. */
export function ovulationCycleDays(eff, cycles) {
  const found = [];
  for (const c of cycles) {
    const end = c.next ? addDays(c.next, -1) : '9999-12-31';
    const bbt = byKind(eff, 'BBT')
      .filter((e) => e.log_date >= c.start && e.log_date <= end && e.payload?.temp_c !== undefined)
      .map((e) => ({ day: e.log_date, temp_c: Number(e.payload.temp_c), sleep_disrupted: e.payload.sleep_disrupted === true }));
    const r = analyzeBbt(bbt);
    if (r.status === 'SHIFT_CONFIRMED') found.push([diffDays(r.ovulation_window[0], c.start) + 1, diffDays(r.ovulation_window[1], c.start) + 1]);
  }
  if (!found.length) return null;
  return { from: Math.min(...found.map((f) => f[0])), to: Math.max(...found.map((f) => f[1])), cycles: found.length };
}
