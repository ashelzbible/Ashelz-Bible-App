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

from .profiles import DEFAULT_PROFILE, AssayProfile

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


def analyze_hormones(readings: list[HormoneReading], profile: AssayProfile = DEFAULT_PROFILE) -> HormoneResult:
    e3g, ex_e3g = _series(readings, Analyte.E3G)
    lh, ex_lh = _series(readings, Analyte.LH)
    pdg, ex_pdg = _series(readings, Analyte.PDG)

    e3g_base, e3g_window = _baseline(e3g, profile.baseline_readings)
    lh_base, lh_window = _baseline(lh, profile.baseline_readings)

    insufficient: list[Analyte] = []
    if e3g_base is None:
        insufficient.append(Analyte.E3G)
    if lh_base is None:
        insufficient.append(Analyte.LH)

    e3g_days = tuple(
        d for d in sorted(e3g)
        if e3g_base is not None and d not in e3g_window and e3g[d] >= profile.e3g_rise_factor * e3g_base
    )

    # The absolute LH criterion needs no baseline, so it applies to every
    # reading; the relative criterion applies once a baseline exists and only
    # to readings outside the baseline window.
    lh_days = tuple(
        d for d in sorted(lh)
        if lh[d] >= profile.lh_surge_absolute
        or (lh_base is not None and d not in lh_window and lh[d] >= profile.lh_surge_factor * lh_base)
    )

    # LH peak: highest value within the first surge episode (consecutive
    # surge days); earliest day wins ties.
    peak: date | None = None
    if lh_days:
        episode = _episode(list(lh_days))
        peak = max(episode, key=lambda d: (lh[d], -d.toordinal()))

    confirmed: date | None = None
    run: list[date] = []
    if peak is not None:
        after = [d for d in sorted(pdg) if d > peak and pdg[d] >= profile.pdg_confirm]
        found = _consecutive_run(after, profile.pdg_days)
        if found:
            run = found
            confirmed = found[-1]

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
