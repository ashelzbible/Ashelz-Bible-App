import math

import pytest

from core.bbt_analyzer import (
    BbtReading,
    BbtStatus,
    ExclusionReason,
    analyze_bbt,
    to_centidegrees,
)
from tests.conftest import D


def series(start_day, temps, **kw):
    return [BbtReading(D(start_day + i), t, **kw) for i, t in enumerate(temps)]


BASE = [36.40, 36.45, 36.42, 36.50, 36.44, 36.48]  # coverline 36.50


def test_classic_shift_confirmed():
    res = analyze_bbt(series(1, BASE + [36.70, 36.72, 36.75]))
    assert res.status is BbtStatus.SHIFT_CONFIRMED
    assert res.coverline_c == 36.50
    assert res.shift_start == D(7)
    assert res.confirmation_date == D(9)
    assert res.ovulation_window == (D(5), D(6))
    assert res.valid_count == 9
    assert res.excluded == ()


def test_third_reading_exactly_point_two_above_coverline_confirms():
    # 36.70 - 36.50 is not exactly 0.20 in binary floating point; the
    # integer-centidegree comparison must still accept it.
    res = analyze_bbt(series(1, BASE + [36.60, 36.65, 36.70]))
    assert res.status is BbtStatus.SHIFT_CONFIRMED


def test_third_reading_point_one_nine_above_does_not_confirm():
    res = analyze_bbt(series(1, BASE + [36.60, 36.65, 36.69]))
    assert res.status is BbtStatus.NO_SHIFT


def test_any_post_shift_reading_not_above_coverline_blocks():
    res = analyze_bbt(series(1, BASE + [36.70, 36.50, 36.80]))  # 2nd equals coverline
    assert res.status is BbtStatus.NO_SHIFT


def test_uses_only_the_six_days_before_the_shift_for_coverline():
    # An old spike 7+ days before the shift must not raise the coverline.
    temps = [36.90] + BASE + [36.70, 36.72, 36.75]
    res = analyze_bbt(series(1, temps))
    assert res.status is BbtStatus.SHIFT_CONFIRMED
    assert res.coverline_c == 36.50
    assert res.shift_start == D(8)


def test_earliest_valid_shift_is_reported():
    temps = BASE + [36.70, 36.72, 36.75, 36.80, 36.85]
    res = analyze_bbt(series(1, temps))
    assert res.shift_start == D(7)


def test_anovulatory_flat_cycle_has_no_shift():
    temps = [36.40 + 0.02 * ((i * 7) % 5) for i in range(30)]
    res = analyze_bbt(series(1, temps))
    assert res.status is BbtStatus.NO_SHIFT
    assert res.coverline_c is None and res.confirmation_date is None


def test_fever_spike_above_37_8_is_excluded_and_never_used():
    temps = BASE + [38.20, 36.72, 36.75, 36.80]
    res = analyze_bbt(series(1, temps))
    assert [e.reason for e in res.excluded] == [ExclusionReason.FEVER_SPIKE]
    assert res.excluded[0].day == D(7)
    # The fever day splits the data into runs of 6 and 3 valid days; the spike
    # is neither used nor interpolated, so no shift can be confirmed.
    assert res.status is BbtStatus.INSUFFICIENT_DATA
    assert res.shift_start is None


def test_fever_spike_inside_long_flat_series_yields_no_shift():
    temps = [36.4, 36.45, 36.42, 36.5, 36.44, 36.48, 38.2, 36.46, 36.43, 36.47,
             36.41, 36.45, 36.44, 36.46, 36.42, 36.45, 36.43, 36.44]
    res = analyze_bbt(series(1, temps))
    assert res.status is BbtStatus.NO_SHIFT
    assert res.excluded[0].reason is ExclusionReason.FEVER_SPIKE


def test_fever_boundary_37_8_is_valid_37_81_is_not():
    ok = analyze_bbt(series(1, BASE + [36.9, 37.0, 37.8]))
    assert ok.status is BbtStatus.SHIFT_CONFIRMED and not ok.excluded
    bad = analyze_bbt(series(1, BASE + [36.9, 37.0, 37.81]))
    assert bad.excluded[0].reason is ExclusionReason.FEVER_SPIKE
    assert bad.status is BbtStatus.INSUFFICIENT_DATA  # only 8 consecutive valid days


def test_fever_in_baseline_breaks_consecutiveness_without_imputation():
    temps = [36.40, 36.45, 38.5, 36.50, 36.44, 36.48] + [36.70, 36.72, 36.75]
    res = analyze_bbt(series(1, temps))
    assert res.status is BbtStatus.INSUFFICIENT_DATA
    assert res.valid_count == 8


def test_sleep_disruption_is_excluded():
    readings = series(1, BASE + [36.70, 36.72]) + [BbtReading(D(9), 36.75, sleep_disrupted=True)]
    res = analyze_bbt(readings)
    assert res.excluded[0].reason is ExclusionReason.SLEEP_DISRUPTION
    assert res.status is BbtStatus.INSUFFICIENT_DATA


def test_missing_day_is_not_imputed():
    readings = series(1, BASE + [36.70]) + series(9, [36.72, 36.75])  # D8 missing
    res = analyze_bbt(readings)
    assert res.status is BbtStatus.INSUFFICIENT_DATA
    assert res.valid_count == 9  # 9 valid days, but never 9 in a row


def test_enough_readings_but_gaps_everywhere_is_insufficient_not_no_shift():
    readings = [BbtReading(D(i), 36.5) for i in range(1, 30, 2)]  # every other day
    assert analyze_bbt(readings).status is BbtStatus.INSUFFICIENT_DATA


def test_too_few_readings():
    assert analyze_bbt([]).status is BbtStatus.INSUFFICIENT_DATA
    assert analyze_bbt(series(1, BASE)).status is BbtStatus.INSUFFICIENT_DATA


def test_duplicate_date_is_excluded_entirely():
    readings = series(1, BASE + [36.70, 36.72, 36.75]) + [BbtReading(D(8), 36.10)]
    res = analyze_bbt(readings)
    assert [e.reason for e in res.excluded] == [ExclusionReason.DUPLICATE_DATE]  # reported once
    assert res.status is BbtStatus.INSUFFICIENT_DATA


@pytest.mark.parametrize("bad", [33.99, 42.01, math.nan, math.inf])
def test_implausible_values_are_excluded(bad):
    res = analyze_bbt(series(1, BASE + [bad, 36.72, 36.75]))
    assert res.excluded[0].reason is ExclusionReason.IMPLAUSIBLE_VALUE


def test_input_order_does_not_matter():
    readings = series(1, BASE + [36.70, 36.72, 36.75])
    assert analyze_bbt(list(reversed(readings))) == analyze_bbt(readings)


def test_to_centidegrees_rounds_half_up_exactly():
    assert to_centidegrees(36.7) == 3670
    assert to_centidegrees(36.505) in (3650, 3651)
    assert to_centidegrees(36.504) == 3650
