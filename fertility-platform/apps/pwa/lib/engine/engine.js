// On-device fertility calculation: a line-for-line port of services/biochem-engine/core (bbt_analyzer,
// hormone_analyzer, cycle_synthesizer). Pure and deterministic. test/engine.test.mjs proves it returns exactly the
// same days, flags and reasoning as the Python engine on hundreds of generated cases.
import { Q, q } from './rational.js';
import { DEFAULT_PROFILE, needsE3gBaseline, needsLhBaseline } from './profiles.js';

export const ALGORITHM_VERSION = 'biochem-1.0.0';

// ---- dates (ISO "YYYY-MM-DD" strings) ------------------------------------------------------------
export const ord = (s) => { const [y, m, d] = s.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };
const fromOrd = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
export const addDays = (s, n) => fromOrd(ord(s) + n);
const lt = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---- BBT 3-over-6 -----------------------------------------------------------------------------------
const FEVER = 3780, PLAUSIBLE_MIN = 3400, PLAUSIBLE_MAX = 4200, BASELINE_DAYS = 6, POST_DAYS = 3, MIN_RISE = 20;
const centi = (t) => Math.floor(t * 100 + 0.5); // integer hundredths of a degree: exact threshold comparisons

function classify(readings) {
  const counts = new Map();
  for (const r of readings) counts.set(r.day, (counts.get(r.day) ?? 0) + 1);
  const sorted = [...readings].sort((a, b) => lt(a.day, b.day) || a.temp_c - b.temp_c || Number(!!a.sleep_disrupted) - Number(!!b.sleep_disrupted));
  const valid = new Map();
  const excluded = [];
  for (const r of sorted) {
    if (counts.get(r.day) > 1) {
      if (!excluded.some((e) => e.day === r.day)) excluded.push({ day: r.day, reason: 'DUPLICATE_DATE' });
      continue;
    }
    if (!Number.isFinite(r.temp_c)) { excluded.push({ day: r.day, reason: 'IMPLAUSIBLE_VALUE' }); continue; }
    const c = centi(r.temp_c);
    if (c < PLAUSIBLE_MIN || c > PLAUSIBLE_MAX) excluded.push({ day: r.day, reason: 'IMPLAUSIBLE_VALUE' });
    else if (c > FEVER) excluded.push({ day: r.day, reason: 'FEVER_SPIKE' });
    else if (r.sleep_disrupted) excluded.push({ day: r.day, reason: 'SLEEP_DISRUPTION' });
    else valid.set(r.day, c);
  }
  return { valid, excluded };
}

function longestRun(valid) {
  let best = 0, run = 0, prev = null;
  for (const d of [...valid.keys()].sort()) {
    run = prev !== null && ord(d) - ord(prev) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

export function analyzeBbt(readings) {
  const { valid, excluded } = classify(readings);
  const none = (status) => ({ status, coverline_c: null, shift_start: null, confirmation_date: null, ovulation_window: null, excluded, valid_count: valid.size });
  if (longestRun(valid) < BASELINE_DAYS + POST_DAYS) return none('INSUFFICIENT_DATA');
  for (const d1 of [...valid.keys()].sort()) {
    const base = Array.from({ length: BASELINE_DAYS }, (_, i) => addDays(d1, i - BASELINE_DAYS));
    const post = Array.from({ length: POST_DAYS }, (_, i) => addDays(d1, i));
    if (![...base, ...post].every((d) => valid.has(d))) continue;
    const cover = Math.max(...base.map((d) => valid.get(d)));
    const temps = post.map((d) => valid.get(d));
    if (temps.every((t) => t > cover) && temps[temps.length - 1] - cover >= MIN_RISE) {
      return { status: 'SHIFT_CONFIRMED', coverline_c: cover / 100, shift_start: d1, confirmation_date: post[post.length - 1],
        ovulation_window: [addDays(d1, -2), addDays(d1, -1)], excluded, valid_count: valid.size };
    }
  }
  return none('NO_SHIFT');
}

// ---- urinary hormones -----------------------------------------------------------------------------------
const ATTR = { LH: 'lh_miu_ml', E3G: 'e3g_ng_ml', PDG: 'pdg_ug_ml' };

function series(readings, analyte) {
  const seen = new Map();
  for (const r of readings) { const v = r[ATTR[analyte]]; if (v !== undefined && v !== null) { if (!seen.has(r.day)) seen.set(r.day, []); seen.get(r.day).push(v); } }
  const out = new Map();
  for (const day of [...seen.keys()].sort()) {
    const vals = seen.get(day);
    if (vals.length > 1 || !Number.isFinite(vals[0]) || vals[0] < 0) continue; // invalid or ambiguous: dropped, never guessed
    out.set(day, Q.parse(String(vals[0])));
  }
  return out;
}

function baseline(map, n) {
  const days = [...map.keys()].sort();
  if (days.length < n) return { value: null, window: new Set() };
  const window = days.slice(0, n);
  const mean = window.reduce((s, d) => s.add(map.get(d)), q(0)).divInt(n);
  return { value: mean.isPositive() ? mean : null, window: new Set(window) };
}

function consecutiveRun(days, length) {
  let run = [];
  for (const d of days) {
    run = run.length && ord(d) - ord(run[run.length - 1]) === 1 ? [...run, d] : [d];
    if (run.length === length) return run;
  }
  return null;
}

function confirmedPeak(lh, rule) {
  const candidates = [...lh.keys()].filter((d) => lh.get(d).gt(rule.minAbove));
  if (!candidates.length) return null;
  let peak = candidates[0];
  for (const d of candidates) { const c = lh.get(d).cmp(lh.get(peak)); if (c > 0 || (c === 0 && ord(d) < ord(peak))) peak = d; }
  const limit = q(1).add(rule.declineFraction.mul(q(-1))).mul(lh.get(peak));
  for (let k = 1; k <= rule.declineDays; k++) {
    const nxt = addDays(peak, k);
    if (!lh.has(nxt) || lh.get(nxt).gt(limit)) return null;
  }
  return peak;
}

export function analyzeHormones(readings, profile = DEFAULT_PROFILE) {
  const e3g = series(readings, 'E3G'), lh = series(readings, 'LH'), pdg = series(readings, 'PDG');
  const e3gBase = baseline(e3g, profile.baselineReadings), lhBase = baseline(lh, profile.baselineReadings);
  const insufficient = [];
  if (needsE3gBaseline(profile) && e3gBase.value === null) insufficient.push('E3G');
  if (needsLhBaseline(profile) && lhBase.value === null) insufficient.push('LH');

  const e3gHit = (d) => {
    const v = e3g.get(d);
    if (profile.e3gAbove !== null && v.gt(profile.e3gAbove)) return true;
    return profile.e3gRiseFactor !== null && e3gBase.value !== null && !e3gBase.window.has(d) && v.ge(profile.e3gRiseFactor.mul(e3gBase.value));
  };
  const lhHit = (d) => {
    const v = lh.get(d);
    if (profile.lhSurgeAbsolute !== null && v.ge(profile.lhSurgeAbsolute)) return true;
    if (profile.lhPeakRule !== null && v.gt(profile.lhPeakRule.minAbove)) return true;
    return profile.lhSurgeFactor !== null && lhBase.value !== null && !lhBase.window.has(d) && v.ge(profile.lhSurgeFactor.mul(lhBase.value));
  };
  const e3gDays = [...e3g.keys()].sort().filter(e3gHit);
  const lhDays = [...lh.keys()].sort().filter(lhHit);

  let peak = null;
  if (profile.lhPeakRule !== null) {
    peak = confirmedPeak(lh, profile.lhPeakRule);
  } else if (lhDays.length) {
    const episode = [lhDays[0]];
    for (const d of lhDays.slice(1)) { if (ord(d) - ord(episode[episode.length - 1]) === 1) episode.push(d); else break; }
    peak = episode[0];
    for (const d of episode) { const c = lh.get(d).cmp(lh.get(peak)); if (c > 0 || (c === 0 && ord(d) < ord(peak))) peak = d; }
  }

  let confirmed = null;
  if (peak !== null && profile.pdgConfirm !== null) {
    const after = [...pdg.keys()].sort().filter((d) => d > peak && pdg.get(d).ge(profile.pdgConfirm));
    const run = consecutiveRun(after, profile.pdgDays);
    if (run) confirmed = run[run.length - 1];
  }
  const windowEnd = peak !== null && profile.fertileWindowDaysAfterPeak !== null ? addDays(peak, profile.fertileWindowDaysAfterPeak) : null;
  return { e3g_rise_days: e3gDays, lh_surge_days: lhDays, lh_peak_day: peak, ovulation_confirmed_day: confirmed,
    insufficient_baseline: insufficient, fertile_window_end: windowEnd };
}

// ---- daily synthesis -------------------------------------------------------------------------------------
const PEAK_DAYS_AFTER_SURGE = 1, ANOVULATORY_MIN_SPAN_DAYS = 35, MUCUS_MAX = 4, MUCUS_FERTILE_MIN = 3, MUCUS_DISCORDANT_MAX = 1, MAX_SPAN_DAYS = 366;

const g = (qv) => String(Number(qv.toNumber().toPrecision(6))); // Python's {:g} for the small values thresholds take
const pct = (qv) => `${Math.round(qv.toNumber() * 100)}%`;

function lhRuleText(p) {
  const parts = [];
  if (p.lhSurgeFactor !== null) parts.push(`>= ${g(p.lhSurgeFactor)}x baseline`);
  if (p.lhSurgeAbsolute !== null) parts.push(`>= ${g(p.lhSurgeAbsolute)} mIU/mL`);
  if (p.lhPeakRule !== null) {
    const r = p.lhPeakRule;
    parts.push(`> ${g(r.minAbove)} mIU/mL, a candidate peak confirmed when ${r.declineDays} consecutive days follow at least ${pct(r.declineFraction)} lower`);
  }
  return parts.join(' or ');
}

function e3gRuleText(p) {
  const parts = [];
  if (p.e3gRiseFactor !== null) parts.push(`>= ${g(p.e3gRiseFactor)}x follicular baseline`);
  if (p.e3gAbove !== null) parts.push(`> ${g(p.e3gAbove)} ng/mL`);
  return parts.join(' or ');
}

function validMucus(readings) {
  const seen = new Map();
  for (const m of readings) { if (!seen.has(m.day)) seen.set(m.day, []); seen.get(m.day).push(m.score); }
  const valid = new Map(), invalid = new Set();
  for (const [day, scores] of seen) {
    if (scores.length > 1 || !(scores[0] >= 0 && scores[0] <= MUCUS_MAX)) invalid.add(day); else valid.set(day, scores[0]);
  }
  return { valid, invalid };
}

function statusForDay(day, bbt, hormones, mucus, profile) {
  const bbtRes = analyzeBbt(bbt), horm = analyzeHormones(hormones, profile);
  const { valid: mucusValid, invalid: mucusInvalid } = validMucus(mucus);
  const flags = [], why = [];
  const done = (status) => ({ day, status, flags, reasoning: why });

  if (mucusInvalid.has(day)) { flags.push('INVALID_MUCUS_SCORE'); why.push('Mucus entry for this day was invalid or duplicated and was ignored.'); }
  const today = hormones.filter((r) => r.day === day);
  const unjudged = horm.insufficient_baseline.filter((a) => today.some((r) => (a === 'E3G' ? r.e3g_ng_ml : r.lh_miu_ml) != null));
  if (unjudged.length) {
    flags.push('HORMONE_BASELINE_INSUFFICIENT');
    why.push(`${unjudged.join('/')} follicular baseline not yet established (needs ${profile.baselineReadings} readings).`);
  }

  const pdgOn = horm.ovulation_confirmed_day;
  const bbtOn = bbtRes.status === 'SHIFT_CONFIRMED' ? bbtRes.confirmation_date : null;
  if (pdgOn !== null || bbtOn !== null) {
    if (pdgOn !== null) {
      flags.push('PDG_OVULATION_CONFIRMED');
      why.push(`PdG >= ${g(profile.pdgConfirm)} ug/mL on ${profile.pdgDays} consecutive days after the LH peak (${horm.lh_peak_day}); confirmed on ${pdgOn}.`);
    }
    if (bbtOn !== null) {
      flags.push('BBT_SHIFT_CONFIRMED');
      why.push(`Sustained thermal shift (3-over-6, coverline ${bbtRes.coverline_c.toFixed(2)} C) began ${bbtRes.shift_start}; confirmed on ${bbtOn}.`);
    }
    if (pdgOn === null) { flags.push('BBT_ONLY_CONFIRMATION'); why.push('Confirmation rests on BBT alone; no PdG confirmation available.'); }
    else if (bbtOn === null && bbtRes.status === 'NO_SHIFT') { flags.push('PDG_BBT_DISCORDANT'); why.push('PdG confirms ovulation but BBT shows no qualifying shift.'); }
    return done('OVULATION_CONFIRMED');
  }

  const surgeToday = horm.lh_surge_days.includes(day);
  const surgeRecent = horm.lh_surge_days.some((s) => { const dd = ord(day) - ord(s); return dd > 0 && dd <= PEAK_DAYS_AFTER_SURGE; });
  const e3gToday = horm.e3g_rise_days.includes(day);
  const mucusToday = mucusValid.has(day) ? mucusValid.get(day) : null;

  if (surgeToday) { flags.push('LH_SURGE'); why.push(`LH surge (${lhRuleText(profile)}).`); }
  else if (surgeRecent) { flags.push('LH_SURGE_RECENT'); why.push('Within 1 day after an LH surge; ovulation is imminent.'); }
  if (e3gToday) { flags.push('E3G_RISE'); why.push(`E3G rise (${e3gRuleText(profile)}).`); }
  if (mucusToday !== null && mucusToday >= MUCUS_FERTILE_MIN) { flags.push('MUCUS_FERTILE'); why.push(`Fertile-quality cervical mucus (score ${mucusToday}).`); }
  if (mucusToday === MUCUS_MAX) flags.push('MUCUS_PEAK_QUALITY');
  if (surgeToday || surgeRecent || (mucusToday === MUCUS_MAX && e3gToday)) return done('PEAK');

  const inTail = horm.fertile_window_end !== null && horm.lh_peak_day !== null && horm.lh_peak_day < day && day <= horm.fertile_window_end;
  if (inTail) { flags.push('FERTILE_WINDOW_AFTER_PEAK'); why.push(`Within the fertile window, which closes ${horm.fertile_window_end} (confirmed LH peak ${horm.lh_peak_day}).`); }
  if (inTail || e3gToday || (mucusToday !== null && mucusToday >= MUCUS_FERTILE_MIN)) {
    if (mucusToday === MUCUS_MAX) { flags.push('MUCUS_PEAK_WITHOUT_HORMONE_SUPPORT'); why.push('Egg-white mucus without E3G rise or LH surge; not escalated to PEAK.'); }
    if (e3gToday && mucusToday !== null && mucusToday <= MUCUS_DISCORDANT_MAX) { flags.push('MUCUS_HORMONE_DISCORDANT'); why.push('E3G is elevated but mucus is not fertile; hormone value takes precedence.'); }
    return done('HIGH');
  }

  const e3gEvaluable = !horm.insufficient_baseline.includes('E3G') && hormones.some((r) => r.day === day && r.e3g_ng_ml != null);
  if (mucusToday !== null) { why.push(`Non-fertile cervical mucus (score ${mucusToday}) and no hormone trigger.`); return done('LOW'); }
  if (e3gEvaluable) { why.push('E3G within follicular baseline range and no LH surge.'); return done('LOW'); }
  if (bbt.some((r) => r.day === day)) {
    flags.push('BBT_ONLY_PRE_OVULATION');
    why.push('Only a temperature was logged and no shift is confirmed; BBT cannot rule out fertility before ovulation.');
  } else { flags.push('NO_OBSERVATIONS'); why.push('No usable observations on this day.'); }
  return done('INSUFFICIENT_DATA');
}

/** One status per calendar day from the first to the last datum; each day sees only data up to that day. */
export function analyzeCycle(bbt, hormones, mucus, profile = DEFAULT_PROFILE) {
  const allDays = [...bbt, ...hormones, ...mucus].map((r) => r.day);
  if (!allDays.length) return { days: [], ovulation_confirmed_on: null, anovulatory_pattern_suspected: false };
  const start = allDays.reduce((a, b) => (b < a ? b : a)), end = allDays.reduce((a, b) => (b > a ? b : a));
  const span = ord(end) - ord(start) + 1;
  if (span > MAX_SPAN_DAYS) throw new Error(`data span exceeds ${MAX_SPAN_DAYS} days; split into separate cycles`);

  const days = [];
  for (let off = 0; off < span; off++) {
    const d = addDays(start, off);
    days.push(statusForDay(d, bbt.filter((r) => r.day <= d), hormones.filter((r) => r.day <= d), mucus.filter((r) => r.day <= d), profile));
  }
  const confirmedOn = days.find((s) => s.status === 'OVULATION_CONFIRMED')?.day ?? null;
  const finalHorm = analyzeHormones(hormones, profile), finalBbt = analyzeBbt(bbt);
  const anovulatory = confirmedOn === null && span >= ANOVULATORY_MIN_SPAN_DAYS && finalHorm.lh_surge_days.length === 0 && finalBbt.status !== 'SHIFT_CONFIRMED';
  return { days, ovulation_confirmed_on: confirmedOn, anovulatory_pattern_suspected: anovulatory };
}
