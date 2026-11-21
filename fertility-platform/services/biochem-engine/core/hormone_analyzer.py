"""Urinary hormone (E3G / LH / PdG) threshold analysis.

Pure and deterministic. Thresholds come from an AssayProfile (core.profiles);
the default profile holds the specification values:
  * high fertility : E3G >= 1.5 x follicular baseline        (>= 50 % rise)
  * peak fertility : LH  >= 2.5 x follicular baseline  OR  LH >= 25 mIU/mL
  * ovulation      : PdG >= 5.0 ug/mL on 3 consecutive calendar days after
                     the LH peak day

The follicular baseline of an analyte is the mean of its first
`baseline_readings` valid readings; those readings are never themselves
evaluated against the baseline. Missing values are never imputed.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, timedelta
from enum import Enum
from fractions import Fraction

from .profiles import DEFAULT_PROFILE, AssayProfile, LhPeakRule

# Readings are converted from their shortest decimal representation to exact
# rationals (as are the profile thresholds), so comparisons such as
# ">= 1.5 x baseline" carry no binary floating-point error.


class Analyte(str, Enum):
    LH = "LH"
    E3G = "E3G"
    PDG = "PDG"


@dataclass(frozen=True)
class HormoneReading:
    day: date
    lh_miu_ml: float | None = None
    e3g_ng_ml: float | None = None
    pdg_ug_ml: float | None = None


@dataclass(frozen=True)
class HormoneResult:
    e3g_baseline: float | None
    lh_baseline: float | None
    e3g_rise_days: tuple[date, ...]
    lh_surge_days: tuple[date, ...]
    lh_peak_day: date | None
    ovulation_confirmed_day: date | None  # third consecutive PdG day
    pdg_run_days: tuple[date, ...]
    # Analytes for which a baseline could not be established.
    insufficient_baseline: tuple[Analyte, ...]
    # (day, analyte) pairs dropped as invalid or ambiguous.
    excluded: tuple[tuple[date, Analyte], ...]
    # Last day of the fertile window (confirmed LH peak + N days) when the profile defines one.
    fertile_window_end: date | None = None


def _series(readings: list[HormoneReading], analyte: Analyte) -> tuple[dict[date, Fraction], list[tuple[date, Analyte]]]:
    """Extract one analyte as {day: value}, dropping invalid/duplicate entries."""
    attr = {Analyte.LH: "lh_miu_ml", Analyte.E3G: "e3g_ng_ml", Analyte.PDG: "pdg_ug_ml"}[analyte]
    seen: dict[date, list[float]] = {}
    for r in readings:
        v = getattr(r, attr)
        if v is not None:
            seen.setdefault(r.day, []).append(v)
    out: dict[date, Fraction] = {}
    excluded: list[tuple[date, Analyte]] = []
    for day in sorted(seen):
        values = seen[day]
        if len(values) > 1 or not math.isfinite(values[0]) or values[0] < 0:
            excluded.append((day, analyte))
        else:
            out[day] = Fraction(str(values[0]))
    return out, excluded


def _baseline(series: dict[date, Fraction], n: int) -> tuple[Fraction | None, list[date]]:
    """Mean of the first n values; None unless there are n and the mean is positive."""
    days = sorted(series)
    if len(days) < n:
        return None, []
    window = days[:n]
    mean = sum((series[d] for d in window), Fraction(0)) / n
    return (mean if mean > 0 else None), window


def _consecutive_run(days: list[date], length: int) -> list[date] | None:
    """First run of `length` calendar-consecutive days in sorted `days`."""
    run: list[date] = []
    for d in days:
        if run and d - run[-1] == timedelta(days=1):
            run.append(d)
        else:
            run = [d]
        if len(run) == length:
            return run
    return None


def _confirmed_peak(lh: dict[date, Fraction], rule: LhPeakRule) -> date | None:
    """The cycle's highest LH value above rule.min_above, once it is followed by
    rule.decline_days consecutive days each at least rule.decline_fraction lower.
    Earliest day wins ties. None until the decline has been observed."""
    candidates = [d for d in lh if lh[d] > rule.min_above]
    if not candidates:
        return None
    peak = max(candidates, key=lambda d: (lh[d], -d.toordinal()))
    limit = (1 - rule.decline_fraction) * lh[peak]
    for k in range(1, rule.decline_days + 1):
        nxt = peak + timedelta(days=k)
        if nxt not in lh or lh[nxt] > limit:
            return None
    return peak


def analyze_hormones(readings: list[HormoneReading], profile: AssayProfile = DEFAULT_PROFILE) -> HormoneResult:
    e3g, ex_e3g = _series(readings, Analyte.E3G)
    lh, ex_lh = _series(readings, Analyte.LH)
    pdg, ex_pdg = _series(readings, Analyte.PDG)

    e3g_base, e3g_window = _baseline(e3g, profile.baseline_readings)
    lh_base, lh_window = _baseline(lh, profile.baseline_readings)

    # A baseline is only required (and only reported missing) when the profile
    # actually uses a baseline-relative rule for that analyte.
    insufficient: list[Analyte] = []
    if profile.needs_e3g_baseline and e3g_base is None:
        insufficient.append(Analyte.E3G)
    if profile.needs_lh_baseline and lh_base is None:
        insufficient.append(Analyte.LH)

    def e3g_hit(d: date) -> bool:
        v = e3g[d]
        if profile.e3g_above is not None and v > profile.e3g_above:
            return True  # absolute rule: needs no baseline
        return (
            profile.e3g_rise_factor is not None
            and e3g_base is not None
            and d not in e3g_window  # baseline readings are never judged against themselves
            and v >= profile.e3g_rise_factor * e3g_base
        )

    def lh_hit(d: date) -> bool:
        v = lh[d]
        if profile.lh_surge_absolute is not None and v >= profile.lh_surge_absolute:
            return True  # absolute rule: needs no baseline
        if profile.lh_peak_rule is not None and v > profile.lh_peak_rule.min_above:
            return True  # candidate peak; confirmed only after the decline
        return (
            profile.lh_surge_factor is not None
            and lh_base is not None
            and d not in lh_window
            and v >= profile.lh_surge_factor * lh_base
        )

    e3g_days = tuple(d for d in sorted(e3g) if e3g_hit(d))
    lh_days = tuple(d for d in sorted(lh) if lh_hit(d))

    peak: date | None = None
    if profile.lh_peak_rule is not None:
        peak = _confirmed_peak(lh, profile.lh_peak_rule)
    elif lh_days:
        # Highest value within the first surge episode (consecutive surge
        # days); earliest day wins ties.
        episode = _episode(list(lh_days))
        peak = max(episode, key=lambda d: (lh[d], -d.toordinal()))

    confirmed: date | None = None
    run: list[date] = []
    if peak is not None and profile.pdg_confirm is not None:
        after = [d for d in sorted(pdg) if d > peak and pdg[d] >= profile.pdg_confirm]
        found = _consecutive_run(after, profile.pdg_days)
        if found:
            run = found
            confirmed = found[-1]

    window_end: date | None = None
    if peak is not None and profile.fertile_window_days_after_peak is not None:
        window_end = peak + timedelta(days=profile.fertile_window_days_after_peak)

    return HormoneResult(
        e3g_baseline=None if e3g_base is None else float(e3g_base),
        lh_baseline=None if lh_base is None else float(lh_base),
        e3g_rise_days=e3g_days,
        lh_surge_days=lh_days,
        lh_peak_day=peak,
        ovulation_confirmed_day=confirmed,
        pdg_run_days=tuple(run),
        insufficient_baseline=tuple(insufficient),
        excluded=tuple(sorted(ex_e3g + ex_lh + ex_pdg, key=lambda t: (t[0], t[1].value))),
        fertile_window_end=window_end,
    )


def _episode(days: list[date]) -> list[date]:
    """The first run of calendar-consecutive days in a sorted list."""
    out = [days[0]]
    for d in days[1:]:
        if d - out[-1] == timedelta(days=1):
            out.append(d)
        else:
            break
    return out
