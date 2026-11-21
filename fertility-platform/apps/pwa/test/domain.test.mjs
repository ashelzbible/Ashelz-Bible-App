import test from 'node:test';
import assert from 'node:assert/strict';
import { cycleList, effective, lengthStats, ovulationCycleDays, periodDays, periodEnd } from '../lib/domain/cycles.js';
import { forecast, markersFor } from '../lib/domain/forecast.js';
import { addDays, diffDays, fmtLong, fmtShort, monthTitle, daysInMonth } from '../lib/domain/dates.js';
import { cToF, decimalsFor, fromDisplay, normalText, stepFor, toDisplay } from '../lib/domain/units.js';

let lam = 0;
const ev = (kind, log_date, payload = {}) => ({ event_id: String(++lam), device_id: 'd', lamport: lam, kind, op: 'SET', log_date, payload });
const bleed = (start, n) => Array.from({ length: n }, (_, i) => ev('PERIOD', addDays(start, i)));

test('dates and formatting', () => {
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(diffDays('2026-12-09', '2026-11-23'), 16);
  assert.equal(fmtLong('2026-12-09'), 'Wed, 09 Dec 2026');
  assert.equal(fmtShort('2026-12-05'), '05 Dec');
  assert.equal(monthTitle(2026, 10), 'November 2026');
  assert.equal(daysInMonth(2028, 1), 29);
});

test('temperature units convert both ways and display sensibly', () => {
  assert.equal(toDisplay(36.6, 'C'), 36.6);
  assert.equal(toDisplay(36.6, 'F'), 97.9);
  assert.equal(fromDisplay(97.9, 'F'), 36.61);
  assert.equal(fromDisplay(36.55, 'C'), 36.55);
  assert.ok(Math.abs(cToF(37) - 98.6) < 1e-9);
  assert.equal(normalText('C'), 'Normal: 36.3 – 37.2 °C');
  assert.equal(normalText('F'), 'Normal: 97.3 – 99.0 °F');
  assert.deepEqual([stepFor('C'), stepFor('F'), decimalsFor('C'), decimalsFor('F')], [0.05, 0.1, 2, 1]);
});

test('period runs become cycles; a one-day gap stays in the same bleed', () => {
  const eff = effective([...bleed('2026-09-13', 5), ...bleed('2026-10-13', 4), ev('PERIOD', '2026-10-18'), ...bleed('2026-11-10', 5)]);
  const cycles = cycleList(eff, '2026-11-23');
  assert.deepEqual(cycles.map((c) => [c.start, c.length, c.periodLength]), [['2026-09-13', 30, 5], ['2026-10-13', 28, 6], ['2026-11-10', null, 5]]);
  assert.equal(cycles[2].current, true);
  assert.equal(periodEnd('2026-10-13', periodDays(eff)), '2026-10-18');
  assert.equal(periodEnd('2026-10-14', periodDays(eff)), '2026-10-18'); // any logged day: chain forward
  assert.equal(periodEnd('2026-12-01', periodDays(eff)), null);
});

test('an explicit cycle-start entry still counts', () => {
  const eff = effective([ev('CYCLE', '2026-10-01'), ...bleed('2026-10-29', 3)]);
  assert.deepEqual(cycleList(eff, '2026-11-23').map((c) => c.start), ['2026-10-01', '2026-10-29']);
});

test('length statistics ignore implausible gaps and judge consistency', () => {
  const mk = (...lens) => lens.map((length) => ({ length }));
  assert.deepEqual(lengthStats([]), { n: 0, avg: null, min: null, max: null, consistent: null });
  assert.deepEqual(lengthStats(mk(28)), { n: 1, avg: 28, min: 28, max: 28, consistent: null });
  assert.deepEqual(lengthStats(mk(27, 30, 29)), { n: 3, avg: 29, min: 27, max: 30, consistent: true });
  assert.equal(lengthStats(mk(24, 35)).consistent, false);
  assert.equal(lengthStats(mk(28, 200, 29)).n, 2); // 200 days is a forgotten month, not a cycle
  assert.equal(lengthStats([{ length: null }, { length: 28 }]).n, 1);
  assert.equal(lengthStats(mk(20, 20, 20, 20, 20, 20, 40)).avg, 23); // average of the last six only
});

const prefs = { cycleLength: 28, periodLength: 5, lutealLength: 14 };

test('forecast from history: next period, ovulation and fertile window', () => {
  const eff = effective([...bleed('2026-09-13', 5), ...bleed('2026-10-13', 5), ...bleed('2026-11-11', 5)]);
  const cycles = cycleList(eff, '2026-11-23'); // lengths 30 and 29 -> average 30 (rounded 29.5)
  const fc = forecast(cycles, prefs, '2026-11-23');
  assert.equal(fc.cycleDay, 13);
  assert.equal(fc.cycleLength, 30);
  assert.deepEqual(fc.basis, { kind: 'history', cycles: 2 });
  assert.equal(fc.nextPeriod, '2026-12-11');
  assert.equal(fc.daysToPeriod, 18);
  assert.equal(fc.thisCycle.ovulation, '2026-11-27'); // 14 days before the next period
  assert.equal(fc.thisCycle.fertileStart, '2026-11-22');
  assert.equal(fc.daysToOvulation, 4);
  assert.equal(fc.inEstimatedWindow, true);
  assert.equal(fc.projected.length, 3);
  assert.equal(fc.projected[1].periodStart, '2027-01-10');
});

test('forecast falls back to the typical length with fewer than two cycles, and handles a late period', () => {
  const one = forecast(cycleList(effective(bleed('2026-11-01', 4)), '2026-11-30'), prefs, '2026-11-30');
  assert.deepEqual(one.basis, { kind: 'typical' });
  assert.equal(one.nextPeriod, '2026-11-29');
  assert.equal(one.daysToPeriod, -1); // one day late
  assert.equal(forecast([], prefs, '2026-11-30'), null);
});

test('calendar markers combine logged days, measured fertility and estimates', () => {
  const eff = effective([...bleed('2026-11-11', 5)]);
  const fc = forecast(cycleList(eff, '2026-11-23'), prefs, '2026-11-23');
  const ctx = { period: periodDays(eff), engineDays: new Map([['2026-11-20', { status: 'PEAK' }], ['2026-11-21', { status: 'LOW' }], ['2026-11-22', { status: 'OVULATION_CONFIRMED' }]]), fc, ovulationConfirmed: '2026-11-22' };
  assert.equal(markersFor('2026-11-12', ctx).period, true);
  assert.equal(markersFor('2026-11-20', ctx).measuredFertile, true);
  assert.equal(markersFor('2026-11-21', ctx).measuredFertile, false);
  assert.equal(markersFor('2026-11-22', ctx).ovulation, true);
  assert.equal(markersFor('2026-12-09', ctx).estPeriod, true); // 11 Nov + 28 days
  assert.equal(markersFor(fc.thisCycle.ovulation, ctx).ovulationEstimated, true);
  assert.equal(markersFor('2026-11-30', { period: new Set(), engineDays: null, fc: null }).estFertile, false);
});

test('typical ovulation days come from temperature shifts across cycles', () => {
  const temps = (start, shiftOn) => Array.from({ length: 24 }, (_, i) => ev('BBT', addDays(start, i), { temp_c: i >= shiftOn ? 36.8 + (i === shiftOn + 2 ? 0.1 : 0) : 36.4 + (i % 3) * 0.01 }));
  const eff = effective([...bleed('2026-09-01', 3), ...temps('2026-09-01', 14), ...bleed('2026-09-29', 3), ...temps('2026-09-29', 15), ...bleed('2026-10-28', 3)]);
  const cycles = cycleList(eff, '2026-11-05');
  const ov = ovulationCycleDays(eff, cycles);
  assert.equal(ov.cycles, 2);
  assert.ok(ov.from <= ov.to && ov.from >= 12 && ov.to <= 16, JSON.stringify(ov));
  assert.equal(ovulationCycleDays(effective([...bleed('2026-09-01', 3)]), cycleList(effective([...bleed('2026-09-01', 3)]), '2026-11-05')), null);
});
