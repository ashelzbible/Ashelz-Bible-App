"""Basal body temperature thermal-shift detection (3-over-6 coverline rule).

Pure and deterministic: no I/O, no clock, no randomness, no imputation.
All comparisons are made on integer hundredths of a degree Celsius so that
thresholds such as ">= 0.20 C above the coverline" are exact and are never
subject to binary floating-point error.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, timedelta
from enum import Enum

FEVER_THRESHOLD_CDEG = 3780  # > 37.8 C is excluded as a fever spike
PLAUSIBLE_MIN_CDEG = 3400  # below 34.00 C is a sensor/entry error
PLAUSIBLE_MAX_CDEG = 4200  # above 42.00 C is a sensor/entry error
BASELINE_DAYS = 6
POST_SHIFT_DAYS = 3
MIN_RISE_CDEG = 20  # third post-shift reading >= coverline + 0.20 C


class ExclusionReason(str, Enum):
    FEVER_SPIKE = "FEVER_SPIKE"
    SLEEP_DISRUPTION = "SLEEP_DISRUPTION"
    IMPLAUSIBLE_VALUE = "IMPLAUSIBLE_VALUE"
    DUPLICATE_DATE = "DUPLICATE_DATE"


class BbtStatus(str, Enum):
    SHIFT_CONFIRMED = "SHIFT_CONFIRMED"
    NO_SHIFT = "NO_SHIFT"
    INSUFFICIENT_DATA = "INSUFFICIENT_DATA"


@dataclass(frozen=True)
class BbtReading:
    day: date
    temp_c: float
    sleep_disrupted: bool = False


@dataclass(frozen=True)
class ExcludedReading:
    day: date
    reason: ExclusionReason


@dataclass(frozen=True)
class BbtResult:
    status: BbtStatus
    coverline_c: float | None
    shift_start: date | None
    confirmation_date: date | None
    # Conventional window in which ovulation most likely occurred: the one or
    # two days before the first sustained high reading. It is a window, not a
    # point estimate.
    ovulation_window: tuple[date, date] | None
    excluded: tuple[ExcludedReading, ...]
    valid_count: int


def to_centidegrees(temp_c: float) -> int:
    """Round to the nearest 0.01 C (half away from zero) as an exact integer."""
    return int(math.floor(temp_c * 100 + 0.5))


def _classify(readings: list[BbtReading]) -> tuple[dict[date, int], list[ExcludedReading]]:
    """Split readings into valid {day: centidegrees} and excluded (with reason).

    A date that appears more than once is ambiguous; we do not guess which
    value is right, so the date is excluded entirely.
    """
    counts: dict[date, int] = {}
    for r in readings:
        counts[r.day] = counts.get(r.day, 0) + 1

    valid: dict[date, int] = {}
    excluded: list[ExcludedReading] = []
    for r in sorted(readings, key=lambda x: (x.day, x.temp_c, x.sleep_disrupted)):
        if counts[r.day] > 1:
            if not any(e.day == r.day for e in excluded):
                excluded.append(ExcludedReading(r.day, ExclusionReason.DUPLICATE_DATE))
            continue
        if not math.isfinite(r.temp_c):
            excluded.append(ExcludedReading(r.day, ExclusionReason.IMPLAUSIBLE_VALUE))
            continue
        cdeg = to_centidegrees(r.temp_c)
        if cdeg < PLAUSIBLE_MIN_CDEG or cdeg > PLAUSIBLE_MAX_CDEG:
            excluded.append(ExcludedReading(r.day, ExclusionReason.IMPLAUSIBLE_VALUE))
        elif cdeg > FEVER_THRESHOLD_CDEG:
            excluded.append(ExcludedReading(r.day, ExclusionReason.FEVER_SPIKE))
        elif r.sleep_disrupted:
            excluded.append(ExcludedReading(r.day, ExclusionReason.SLEEP_DISRUPTION))
        else:
            valid[r.day] = cdeg
    return valid, excluded


def _longest_run(valid: dict[date, int]) -> int:
    """Length of the longest run of calendar-consecutive valid days."""
    best = run = 0
    prev: date | None = None
    for d in sorted(valid):
        run = run + 1 if prev is not None and d - prev == timedelta(days=1) else 1
        best = max(best, run)
        prev = d
    return best


def analyze_bbt(readings: list[BbtReading]) -> BbtResult:
    """Detect the earliest sustained thermal shift using the 3-over-6 rule.

    For a candidate first-high day D1 the rule requires, all on consecutive
    calendar days with valid readings (nothing is interpolated):
      * six baseline readings on D1-6 .. D1-1; coverline = max(baseline)
      * readings on D1, D1+1, D1+2 each strictly above the coverline
      * the reading on D1+2 at least 0.20 C above the coverline
    """
    valid, excluded = _classify(readings)

    if _longest_run(valid) < BASELINE_DAYS + POST_SHIFT_DAYS:
        return BbtResult(BbtStatus.INSUFFICIENT_DATA, None, None, None, None, tuple(excluded), len(valid))

    one_day = timedelta(days=1)
    for d1 in sorted(valid):
        baseline_days = [d1 - one_day * k for k in range(BASELINE_DAYS, 0, -1)]
        post_days = [d1 + one_day * k for k in range(POST_SHIFT_DAYS)]
        if not all(d in valid for d in baseline_days + post_days):
            continue
        cover = max(valid[d] for d in baseline_days)
        post = [valid[d] for d in post_days]
        if all(t > cover for t in post) and post[-1] - cover >= MIN_RISE_CDEG:
            return BbtResult(
                status=BbtStatus.SHIFT_CONFIRMED,
                coverline_c=cover / 100,
                shift_start=d1,
                confirmation_date=post_days[-1],
                ovulation_window=(d1 - 2 * one_day, d1 - one_day),
                excluded=tuple(excluded),
                valid_count=len(valid),
            )

    return BbtResult(BbtStatus.NO_SHIFT, None, None, None, None, tuple(excluded), len(valid))
