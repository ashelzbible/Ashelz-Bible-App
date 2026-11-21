// Calendar-method ESTIMATES of the next period, ovulation and fertile window. These are statistics from past cycle
// lengths, not measurements, and are always shown as estimates. (Measured results come from the engine.)
import { addDays, diffDays } from './dates.js';
import { lengthStats } from './cycles.js';

export const DEFAULTS = { cycleLength: 28, periodLength: 5, lutealLength: 14, goal: 'track' };
export const FERTILE_DAYS_BEFORE_OVULATION = 5; // the six-day window: five days before ovulation plus ovulation day

/**
 * cycles: from cycleList(). prefs: { cycleLength, periodLength, lutealLength }. Returns null before any cycle start is logged.
 * Projects `ahead` future cycles so the calendar can show them.
 */
export function forecast(cycles, prefs, today, ahead = 3) {
  const cur = cycles[cycles.length - 1];
  if (!cur) return null;
  const stats = lengthStats(cycles);
  const length = stats.avg ?? prefs.cycleLength;
  const projected = [];
  for (let k = 1; k <= ahead; k++) {
    const periodStart = addDays(cur.start, length * k);
    const ovulation = addDays(periodStart, -prefs.lutealLength);
    projected.push({
      periodStart, periodEnd: addDays(periodStart, prefs.periodLength - 1),
      ovulation, fertileStart: addDays(ovulation, -FERTILE_DAYS_BEFORE_OVULATION), fertileEnd: ovulation,
    });
  }
  // The window around this cycle's own ovulation (it may already be behind us)
  const ovulation = addDays(cur.start, length - prefs.lutealLength);
  const thisCycle = { ovulation, fertileStart: addDays(ovulation, -FERTILE_DAYS_BEFORE_OVULATION), fertileEnd: ovulation };
  const next = projected[0];
  const cycleDay = diffDays(today, cur.start) + 1;
  return {
    start: cur.start, cycleDay, cycleLength: length,
    basis: stats.avg ? { kind: 'history', cycles: stats.n } : { kind: 'typical' },
    nextPeriod: next.periodStart, daysToPeriod: diffDays(next.periodStart, today),
    thisCycle, daysToOvulation: diffDays(ovulation, today), inEstimatedWindow: today >= thisCycle.fertileStart && today <= thisCycle.fertileEnd,
    projected,
  };
}

/** Calendar markers for one date from logged data and the estimates. */
export function markersFor(date, { period, engineDays, fc, ovulationConfirmed }) {
  const m = { period: period.has(date), measuredFertile: false, estFertile: false, estPeriod: false, ovulation: false, ovulationEstimated: false };
  const e = engineDays?.get(date);
  if (e && (e.status === 'HIGH' || e.status === 'PEAK')) m.measuredFertile = true;
  if (ovulationConfirmed === date) m.ovulation = true;
  if (fc) {
    for (const c of [fc.thisCycle, ...fc.projected]) if (date >= c.fertileStart && date <= c.fertileEnd) m.estFertile = true;
    for (const c of [fc.thisCycle, ...fc.projected]) if (date === c.ovulation) m.ovulationEstimated = true;
    for (const p of fc.projected) if (date >= p.periodStart && date <= p.periodEnd) m.estPeriod = true;
  }
  return m;
}
