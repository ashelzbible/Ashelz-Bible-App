"""Assay profiles: the numeric thresholds used to interpret urinary hormones.

Thresholds are properties of an assay/device and of the evidence behind them,
not universal constants. Every profile therefore carries its name and an
evidence note, and the name is stamped into the algorithm version of each
stored prediction so results are always traceable to the thresholds used.

Every rule is optional; a profile only enables the rules its source defines.
"""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction


@dataclass(frozen=True)
class LhPeakRule:
    """Marquette/Mira style LH peak: the cycle's highest LH value, which must be
    strictly above `min_above` mIU/mL and followed by `decline_days` consecutive
    days each at least `decline_fraction` lower (value <= (1 - fraction) x peak).
    The peak is only known once those days have been observed."""

    min_above: Fraction
    decline_days: int
    decline_fraction: Fraction

    def __post_init__(self) -> None:
        if self.min_above <= 0 or self.decline_days < 1 or not 0 < self.decline_fraction < 1:
            raise ValueError("invalid LH peak rule")


@dataclass(frozen=True)
class AssayProfile:
    name: str
    evidence: str
    baseline_readings: int
    # E3G ("high fertility") rules, either or both; None disables the rule
    e3g_rise_factor: Fraction | None  # E3G >= factor x follicular baseline
    e3g_above: Fraction | None  # E3G strictly above value (ng/mL); needs no baseline
    # LH rules, any combination; None disables the rule
    lh_surge_factor: Fraction | None  # LH >= factor x follicular baseline
    lh_surge_absolute: Fraction | None  # LH >= value (mIU/mL); needs no baseline
    lh_peak_rule: LhPeakRule | None  # replaces "first surge episode" peak selection
    # Days after a confirmed LH peak that the fertile window stays open
    fertile_window_days_after_peak: int | None
    # Ovulation confirmation by PdG; None = this profile does not confirm via PdG
    pdg_confirm: Fraction | None  # PdG >= value (ug/mL) counts as a positive day
    pdg_days: int  # consecutive positive days after the LH peak

    def __post_init__(self) -> None:
        if not self.name or "/" in self.name or "+" in self.name:
            raise ValueError("profile name must be non-empty and contain no '/' or '+'")
        if self.baseline_readings < 1 or self.pdg_days < 1:
            raise ValueError("baseline_readings and pdg_days must be >= 1")
        thresholds = (self.e3g_rise_factor, self.e3g_above, self.lh_surge_factor, self.lh_surge_absolute, self.pdg_confirm)
        if any(t is not None and t <= 0 for t in thresholds):
            raise ValueError("thresholds must be positive")
        if self.fertile_window_days_after_peak is not None and self.fertile_window_days_after_peak < 0:
            raise ValueError("fertile_window_days_after_peak must be >= 0")

    @property
    def needs_e3g_baseline(self) -> bool:
        return self.e3g_rise_factor is not None

    @property
    def needs_lh_baseline(self) -> bool:
        return self.lh_surge_factor is not None


SPEC_PROVISIONAL = AssayProfile(
    name="spec-provisional-1",
    evidence=(
        "PdG >= 5.0 ug/mL on 3 consecutive first-morning days: supported by Ecochard 2013 (107 women, 283 ovulatory "
        "cycles, ultrasound reference; 3-day model specificity 1.00 / sensitivity 0.92 when counted after the end of "
        "fertile mucus, 0.986 / 0.72 after a first positive LH kit at 20 mIU/mL; the paper says '>' 5, has no "
        "validation set, European women only) and a small pilot (Bouchard 2019). "
        "E3G >= 1.5x follicular baseline, LH >= 2.5x baseline and LH >= 25 mIU/mL are PROVISIONAL specification "
        "values: no source uses them. Inito 2023 uses E3G >= 1.5x the PREVIOUS day and LH >= baseline + 5 mIU/mL; "
        "Ecochard used an LH kit threshold of 20 mIU/mL. All are assay-specific."
    ),
    baseline_readings=5,
    e3g_rise_factor=Fraction(3, 2),
    e3g_above=None,
    lh_surge_factor=Fraction(5, 2),
    lh_surge_absolute=Fraction(25),
    lh_peak_rule=None,
    fertile_window_days_after_peak=None,
    pdg_confirm=Fraction(5),
    pdg_days=3,
)

MIRA_MARQUETTE_PRELIMINARY = AssayProfile(
    name="mira-marquette-2021-preliminary",
    evidence=(
        "PRELIMINARY - taken from the abstract and highlights of Bouchard, Fehring & Mu 2021 (Expert Rev Mol "
        "Diagn 21:1349), full text NOT read. Mira quantitative monitor vs Clearblue Fertility Monitor, 21 women x 3 "
        "cycles; reference was the Clearblue monitor, not ultrasound. Fertile window opens when E3G > 150 ng/mL; "
        "LH peak = highest LH (> 11 mIU/mL) followed by 2 days at least 50% lower; window closes 4 days after the "
        "peak. Unresolved: a 2023 case report quotes 100 ng/mL for the E3G cut-off; whether '> 11' is strict is "
        "ambiguous in the abstract. No Mira PdG rule is published there, so PdG confirmation is disabled "
        "(ovulation is confirmed by BBT only) until a Mira-specific PdG threshold is validated."
    ),
    baseline_readings=5,
    e3g_rise_factor=None,
    e3g_above=Fraction(150),
    lh_surge_factor=None,
    lh_surge_absolute=None,
    lh_peak_rule=LhPeakRule(min_above=Fraction(11), decline_days=2, decline_fraction=Fraction(1, 2)),
    fertile_window_days_after_peak=4,
    pdg_confirm=None,
    pdg_days=3,
)

DEFAULT_PROFILE = SPEC_PROVISIONAL

# Only profiles whose thresholds come from the specification or a cited source are registered.
PROFILES: dict[str, AssayProfile] = {p.name: p for p in (SPEC_PROVISIONAL, MIRA_MARQUETTE_PRELIMINARY)}


def get_profile(name: str) -> AssayProfile:
    try:
        return PROFILES[name]
    except KeyError:
        raise ValueError(f"unknown assay profile {name!r}; available: {sorted(PROFILES)}") from None
