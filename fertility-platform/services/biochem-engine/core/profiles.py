"""Assay profiles: the numeric thresholds used to interpret urinary hormones.

Thresholds are properties of an assay/device and of the evidence behind them,
not universal constants. Every profile therefore carries its name and an
evidence note, and the name is stamped into the algorithm version of each
stored prediction so results are always traceable to the thresholds used.
"""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction


@dataclass(frozen=True)
class AssayProfile:
    name: str
    evidence: str
    baseline_readings: int
    e3g_rise_factor: Fraction  # E3G >= factor x baseline -> rise
    lh_surge_factor: Fraction  # LH  >= factor x baseline -> surge
    lh_surge_absolute: Fraction  # LH >= value (mIU/mL) -> surge, needs no baseline
    pdg_confirm: Fraction  # PdG >= value (ug/mL) counts as a positive day
    pdg_days: int  # consecutive positive days after the LH peak

    def __post_init__(self) -> None:
        if not self.name or "/" in self.name or "+" in self.name:
            raise ValueError("profile name must be non-empty and contain no '/' or '+'")
        if self.baseline_readings < 1 or self.pdg_days < 1:
            raise ValueError("baseline_readings and pdg_days must be >= 1")
        if min(self.e3g_rise_factor, self.lh_surge_factor, self.lh_surge_absolute, self.pdg_confirm) <= 0:
            raise ValueError("thresholds must be positive")


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
    lh_surge_factor=Fraction(5, 2),
    lh_surge_absolute=Fraction(25),
    pdg_confirm=Fraction(5),
    pdg_days=3,
)

DEFAULT_PROFILE = SPEC_PROVISIONAL

# Only the profile the specification defines is registered. Device-specific
# profiles are added here once their thresholds are verified against a source.
PROFILES: dict[str, AssayProfile] = {SPEC_PROVISIONAL.name: SPEC_PROVISIONAL}


def get_profile(name: str) -> AssayProfile:
    try:
        return PROFILES[name]
    except KeyError:
        raise ValueError(f"unknown assay profile {name!r}; available: {sorted(PROFILES)}") from None
