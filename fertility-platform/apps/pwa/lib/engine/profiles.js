// Assay profiles. Mirrors services/biochem-engine/core/profiles.py (checked against it by test/engine.test.mjs).
import { Q, q as qi } from './rational.js';

// q('3/2') -> exact 3/2; q(25) -> 25
const q = (x) => { if (typeof x === 'string' && x.includes('/')) { const [a, b] = x.split('/'); return new Q(BigInt(a), BigInt(b)); } return qi(x); };

export const PROFILES = {
  "spec-provisional-1": {
    name: "spec-provisional-1",
    evidence: "PdG >= 5.0 ug/mL on 3 consecutive first-morning days: supported by Ecochard 2013 (107 women, 283 ovulatory cycles, ultrasound reference; 3-day model specificity 1.00 / sensitivity 0.92 when counted after the end of fertile mucus, 0.986 / 0.72 after a first positive LH kit at 20 mIU/mL; the paper says '>' 5, has no validation set, European women only); a small pilot (Bouchard 2019) adds little (any-positive strip outcome, LH reference). E3G >= 1.5x follicular baseline, LH >= 2.5x baseline and LH >= 25 mIU/mL are PROVISIONAL specification values: no source uses them. Inito 2023 uses E3G >= 1.5x the PREVIOUS day and LH >= baseline + 5 mIU/mL; Ecochard used an LH kit threshold of 20 mIU/mL. All are assay-specific.",
    baselineReadings: 5,
    e3gRiseFactor: q('3/2'), e3gAbove: null,
    lhSurgeFactor: q('5/2'), lhSurgeAbsolute: q(25),
    lhPeakRule: null,
    fertileWindowDaysAfterPeak: null,
    pdgConfirm: q(5), pdgDays: 3,
  },
  "mira-marquette-2021-preliminary": {
    name: "mira-marquette-2021-preliminary",
    evidence: "PRELIMINARY - taken from the abstract and highlights of Bouchard, Fehring & Mu 2021 (Expert Rev Mol Diagn 21:1349), full text NOT read. Mira quantitative monitor vs Clearblue Fertility Monitor, 21 women x 3 cycles; reference was the Clearblue monitor, not ultrasound. Fertile window opens when E3G > 150 ng/mL; LH peak = highest LH (> 11 mIU/mL) followed by 2 days at least 50% lower; window closes 4 days after the peak. Unresolved: a 2023 case report quotes 100 ng/mL for the E3G cut-off; whether '> 11' is strict is ambiguous in the abstract. No Mira PdG rule is published there, so PdG confirmation is disabled (ovulation is confirmed by BBT only) until a Mira-specific PdG threshold is validated.",
    baselineReadings: 5,
    e3gRiseFactor: null, e3gAbove: q(150),
    lhSurgeFactor: null, lhSurgeAbsolute: null,
    lhPeakRule: { minAbove: q(11), declineDays: 2, declineFraction: q('1/2') },
    fertileWindowDaysAfterPeak: 4,
    pdgConfirm: null, pdgDays: 3,
  },
};

export const DEFAULT_PROFILE = PROFILES['spec-provisional-1'];
export const needsE3gBaseline = (p) => p.e3gRiseFactor !== null;
export const needsLhBaseline = (p) => p.lhSurgeFactor !== null;
export function getProfile(name) {
  const p = PROFILES[name];
  if (!p) throw new Error(`unknown assay profile '${name}'; available: ${Object.keys(PROFILES).sort().join(', ')}`);
  return p;
}
