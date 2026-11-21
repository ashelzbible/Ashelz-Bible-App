// Proves the on-device JavaScript engine matches the Python engine exactly (statuses, flags, reasoning text) on
// generated cases, and that the cycle-window logic matches the gateway's TypeScript version.
//   node --test apps/pwa/test/        (needs python3; the gateway must be built for the window comparison)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Q, q } from '../lib/engine/rational.js';
import { analyzeCycle } from '../lib/engine/engine.js';
import { PROFILES, getProfile } from '../lib/engine/profiles.js';
import { buildWindow } from '../lib/engine/window.js';
import { computePredictions } from '../lib/engine/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

test('rational arithmetic is exact', () => {
  assert.equal(Q.parse('0.1').add(Q.parse('0.2')).cmp(Q.parse('0.3')), 0); // 0.1 + 0.2 === 0.3 exactly (not in floats)
  assert.ok(Q.parse('15').ge(Q.parse('1.5').mul(q(10))));
  assert.ok(!Q.parse('14.999999999999999').ge(Q.parse('15')));
  assert.equal(Q.parse('1e-07').cmp(Q.parse('0.0000001')), 0);
  assert.equal(Q.parse('1E+3').cmp(q(1000)), 0);
  assert.equal(Q.parse('-2.50').cmp(new Q(-5n, 2n)), 0);
  assert.equal(q(30).divInt(4).cmp(Q.parse('7.5')), 0);
  assert.throws(() => Q.parse('abc'));
  assert.throws(() => Q.parse(''));
});

const tmp = mkdtempSync(join(tmpdir(), 'golden-'));
const goldenPath = join(tmp, 'golden.json');
execFileSync('python3', [join(root, 'services/biochem-engine/tools/make_golden.py'), goldenPath], { stdio: 'pipe' });
const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));

test('profiles match the Python source of truth', () => {
  for (const [name, g] of Object.entries(golden.profiles)) {
    const p = getProfile(name);
    const f = (x) => (x === null ? null : Q.parse(x.includes('/') ? '0' : x));
    const frac = (x) => { if (x === null) return null; const [a, b = '1'] = x.split('/'); return new Q(BigInt(a), BigInt(b)); };
    assert.equal(p.evidence, g.evidence, `${name} evidence`);
    assert.equal(p.baselineReadings, g.baselineReadings);
    for (const [k, pk] of [['e3gRiseFactor', 'e3gRiseFactor'], ['e3gAbove', 'e3gAbove'], ['lhSurgeFactor', 'lhSurgeFactor'], ['lhSurgeAbsolute', 'lhSurgeAbsolute'], ['pdgConfirm', 'pdgConfirm']]) {
      assert.equal(p[pk] === null ? null : p[pk].cmp(frac(g[k])), g[k] === null ? null : 0, `${name}.${k}`);
    }
    assert.equal(p.fertileWindowDaysAfterPeak, g.fertileWindowDaysAfterPeak);
    assert.equal(p.pdgDays, g.pdgDays);
    if (g.lhPeakRule === null) assert.equal(p.lhPeakRule, null);
    else {
      assert.equal(p.lhPeakRule.minAbove.cmp(frac(g.lhPeakRule[0])), 0);
      assert.equal(p.lhPeakRule.declineDays, g.lhPeakRule[1]);
      assert.equal(p.lhPeakRule.declineFraction.cmp(frac(g.lhPeakRule[2])), 0);
    }
    void f;
  }
  assert.deepEqual(Object.keys(PROFILES).sort(), Object.keys(golden.profiles).sort());
  assert.throws(() => getProfile('nope'), /unknown assay profile/);
});

test(`JavaScript engine equals the Python engine on ${golden.cases.length} generated cases`, () => {
  const seen = new Set();
  for (const c of golden.cases) {
    let actual;
    try {
      const r = analyzeCycle(c.input.bbt, c.input.hormones, c.input.mucus, getProfile(c.profile));
      actual = { days: r.days, ovulation_confirmed_on: r.ovulation_confirmed_on, anovulatory_pattern_suspected: r.anovulatory_pattern_suspected };
    } catch (e) { actual = { error: e.message }; }
    assert.deepEqual(actual, c.expected, `case ${c.id}`);
    for (const d of c.expected.days ?? []) { seen.add(d.status); for (const f of d.flags) seen.add(f); }
  }
  // the generated cases must actually exercise the interesting paths, or this proves little
  for (const must of ['LOW', 'HIGH', 'PEAK', 'OVULATION_CONFIRMED', 'INSUFFICIENT_DATA', 'LH_SURGE', 'LH_SURGE_RECENT', 'E3G_RISE', 'MUCUS_FERTILE',
    'PDG_OVULATION_CONFIRMED', 'BBT_SHIFT_CONFIRMED', 'BBT_ONLY_CONFIRMATION', 'HORMONE_BASELINE_INSUFFICIENT', 'INVALID_MUCUS_SCORE', 'FERTILE_WINDOW_AFTER_PEAK', 'NO_OBSERVATIONS']) {
    assert.ok(seen.has(must), `generated cases never produce ${must}`);
  }
  assert.ok(golden.cases.some((c) => c.expected.error), 'the over-long span error case is covered');
  assert.ok(golden.cases.some((c) => c.expected.anovulatory_pattern_suspected), 'anovulatory flag is covered');
});

// ---- window selection vs the gateway's TypeScript implementation --------------------------------------------------
const tsRecalc = join(root, 'services/api-gateway/dist/recalc.js');
test('cycle-window selection equals the gateway implementation', { skip: !existsSync(tsRecalc) && 'build the gateway first (npm run build)' }, async () => {
  const { buildAnalyzeRequest } = await import(pathToFileURL(tsRecalc).href);
  let s = 12345;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const dateOf = (off) => new Date(Date.UTC(2025, 0, 1 + off)).toISOString().slice(0, 10);
  for (let n = 0; n < 400; n++) {
    const rows = [];
    const count = Math.floor(rnd() * 25);
    for (let i = 0; i < count; i++) {
      const kind = pick(['BBT', 'HORMONE', 'MUCUS', 'CYCLE', 'BBT', 'MUCUS']);
      const log_date = dateOf(Math.floor(rnd() * pick([30, 120, 500])));
      const payload = kind === 'BBT' ? { temp_c: 36.4 + rnd(), sleep_disrupted: rnd() < 0.2 }
        : kind === 'HORMONE' ? { ...(rnd() < 0.8 && { lh_miu_ml: rnd() * 30 }), ...(rnd() < 0.8 && { e3g_ng_ml: rnd() * 200 }), ...(rnd() < 0.5 && { pdg_ug_ml: rnd() * 9 }) }
        : kind === 'MUCUS' ? { score: Math.floor(rnd() * 5) } : {};
      rows.push({ kind, log_date, payload });
    }
    assert.deepEqual(buildWindow(rows), buildAnalyzeRequest(rows), `rows case ${n}`);
  }
});

test('computePredictions works from raw events and keeps the version tag', () => {
  const ev = (kind, log_date, payload, lamport, op = 'SET') => ({ event_id: `${lamport}`, device_id: 'd', lamport, kind, op, log_date, ...(op === 'SET' ? { payload } : {}) });
  const events = [ev('CYCLE', '2025-03-01', {}, 1), ev('HORMONE', '2025-03-05', { lh_miu_ml: 30 }, 2), ev('MUCUS', '2025-03-05', { score: 0 }, 3), ev('MUCUS', '2025-03-05', { score: 4 }, 9)];
  const p = computePredictions(events);
  assert.equal(p.algorithm_version, 'biochem-1.0.0+spec-provisional-1');
  assert.equal(p.computed_on, 'device');
  const day = p.days.find((d) => d.log_date === '2025-03-05');
  assert.equal(day.status, 'PEAK');
  assert.ok(day.flags.includes('MUCUS_PEAK_QUALITY')); // the later (lamport 9) mucus edit won
  assert.equal(computePredictions([]), null);
  assert.equal(computePredictions([ev('CYCLE', '2025-03-01', {}, 1)]), null);
  assert.equal(computePredictions([ev('MUCUS', '2025-03-05', null, 4, 'RETRACT')]), null);
  assert.equal(computePredictions(events, 'mira-marquette-2021-preliminary').algorithm_version, 'biochem-1.0.0+mira-marquette-2021-preliminary');
});
