import { describe, expect, it } from 'vitest';
import { buildAnalyzeRequest, cycleStartDates, type EffectiveRow } from '../src/recalc.js';

const bbt = (d: string, t = 36.5, extra = {}): EffectiveRow => ({ kind: 'BBT', log_date: d, payload: { temp_c: t, ...extra } });
const cycle = (d: string): EffectiveRow => ({ kind: 'CYCLE', log_date: d, payload: {} });

describe('buildAnalyzeRequest', () => {
  it('returns null when there is no biomarker data', () => {
    expect(buildAnalyzeRequest([])).toBeNull();
    expect(buildAnalyzeRequest([cycle('2025-03-01')])).toBeNull();
  });

  it('maps each kind to the engine schema', () => {
    const r = buildAnalyzeRequest([
      cycle('2025-03-01'),
      bbt('2025-03-02', 36.4, { sleep_disrupted: true }),
      { kind: 'HORMONE', log_date: '2025-03-02', payload: { lh_miu_ml: 4, pdg_ug_ml: 1.5 } },
      { kind: 'MUCUS', log_date: '2025-03-03', payload: { score: 3 } },
    ])!;
    expect(r.windowStart).toBe('2025-03-01');
    expect(r.request.bbt).toEqual([{ day: '2025-03-02', temp_c: 36.4, sleep_disrupted: true }]);
    expect(r.request.hormones).toEqual([{ day: '2025-03-02', lh_miu_ml: 4, pdg_ug_ml: 1.5 }]);
    expect(r.request.mucus).toEqual([{ day: '2025-03-03', score: 3 }]);
  });

  it('window starts at the latest cycle start and excludes the previous cycle', () => {
    const r = buildAnalyzeRequest([cycle('2025-02-01'), bbt('2025-02-10'), cycle('2025-03-01'), bbt('2025-03-05')])!;
    expect(r.windowStart).toBe('2025-03-01');
    expect(r.request.bbt.map((b) => b.day)).toEqual(['2025-03-05']);
  });

  it('defaults to the last 90 days when no cycle start was logged', () => {
    const r = buildAnalyzeRequest([bbt('2024-12-01'), bbt('2025-03-31')])!;
    expect(r.windowStart).toBe('2025-01-01'); // 90 days ending 2025-03-31 inclusive
    expect(r.request.bbt.map((b) => b.day)).toEqual(['2025-03-31']);
  });

  it('never exceeds the engine span limit (366 days) even for a very old cycle start', () => {
    const r = buildAnalyzeRequest([cycle('2023-01-01'), bbt('2023-06-01'), bbt('2025-03-31')])!;
    expect(r.windowStart).toBe('2024-03-31');
    expect(r.request.bbt).toHaveLength(1);
  });

  it('keeps the previous predictions when a new cycle has started but has no data yet', () => {
    expect(buildAnalyzeRequest([bbt('2025-02-10'), cycle('2025-03-01')])).toBeNull();
  });

  it('ignores a cycle start dated after all data only through the null rule above, not by crashing', () => {
    expect(() => buildAnalyzeRequest([bbt('2025-03-01'), cycle('2025-04-01')])).not.toThrow();
  });

  it('derives cycle starts from runs of period days and ignores symptoms', () => {
    const period = (d: string): EffectiveRow => ({ kind: 'PERIOD', log_date: d, payload: {} });
    const sym = (d: string): EffectiveRow => ({ kind: 'SYMPTOMS', log_date: d, payload: { tags: ['cramps'] } });
    const rows = [period('2025-03-01'), period('2025-03-02'), period('2025-03-03'), period('2025-03-05'), period('2025-03-28'), period('2025-03-29'), sym('2025-03-30')];
    expect(cycleStartDates(rows)).toEqual(['2025-03-01', '2025-03-28']); // 03-05 belongs to the first bleed (gap of 1 day)
    const r = buildAnalyzeRequest([...rows, bbt('2025-03-10'), bbt('2025-03-30', 36.6)])!;
    expect(r.windowStart).toBe('2025-03-28');
    expect(r.request.bbt.map((b) => b.day)).toEqual(['2025-03-30']);
    expect(r.request.mucus).toEqual([]); // symptoms are never mistaken for mucus
    expect(buildAnalyzeRequest([sym('2025-03-30'), period('2025-03-01')])).toBeNull();
  });

  it('a CYCLE event and a period run on the same day give one start', () => {
    expect(cycleStartDates([cycle('2025-03-01'), { kind: 'PERIOD', log_date: '2025-03-01', payload: {} }])).toEqual(['2025-03-01']);
  });
});
