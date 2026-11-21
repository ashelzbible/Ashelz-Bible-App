import math

from core.hormone_analyzer import Analyte, HormoneReading as H, analyze_hormones
from tests.conftest import D


def run(start, **cols):
    """Build readings: run(1, lh=[...], e3g=[...], pdg=[...]) on consecutive days."""
    n = max(len(v) for v in cols.values())
    out = []
    for i in range(n):
        out.append(
            H(
                D(start + i),
                lh_miu_ml=cols["lh"][i] if "lh" in cols and i < len(cols["lh"]) else None,
                e3g_ng_ml=cols["e3g"][i] if "e3g" in cols and i < len(cols["e3g"]) else None,
                pdg_ug_ml=cols["pdg"][i] if "pdg" in cols and i < len(cols["pdg"]) else None,
            )
        )
    return out


def test_baseline_is_mean_of_first_five_readings():
    res = analyze_hormones(run(1, e3g=[10, 12, 8, 10, 10, 10], lh=[4, 4, 4, 4, 4, 4]))
    assert res.e3g_baseline == 10.0
    assert res.lh_baseline == 4.0
    assert res.insufficient_baseline == ()


def test_e3g_exactly_fifty_percent_above_baseline_flags_high():
    res = analyze_hormones(run(1, e3g=[10, 10, 10, 10, 10, 15.0, 14.99]))
    assert res.e3g_rise_days == (D(6),)


def test_e3g_rise_with_decimal_values_is_exact():
    # mean of these five is exactly 0.3; 0.45 is exactly +50% (0.3*1.5 in
    # binary floating point is 0.44999999999999996 and would still pass,
    # but 0.1+0.2 style drift must never flip a decision).
    res = analyze_hormones(run(1, e3g=[0.1, 0.2, 0.3, 0.4, 0.5, 0.45]))
    assert res.e3g_baseline == 0.3
    assert res.e3g_rise_days == (D(6),)


def test_baseline_window_readings_are_not_themselves_evaluated():
    res = analyze_hormones(run(1, e3g=[1, 1, 1, 100, 100, 100]))
    # baseline = 40.6 over the first five; day 6 (100) is >= 1.5x? 100 >= 60.9
    assert D(4) not in res.e3g_rise_days and D(5) not in res.e3g_rise_days
    assert res.e3g_rise_days == (D(6),)


def test_insufficient_baseline_flags_analyte_and_blocks_relative_rules():
    res = analyze_hormones(run(1, e3g=[10, 10, 10, 10], lh=[4, 4, 4, 4]))
    assert res.insufficient_baseline == (Analyte.E3G, Analyte.LH)
    assert res.e3g_baseline is None and res.e3g_rise_days == ()


def test_zero_baseline_is_not_usable():
    res = analyze_hormones(run(1, e3g=[0, 0, 0, 0, 0, 5], lh=[0, 0, 0, 0, 0, 9]))
    assert res.e3g_baseline is None and res.lh_baseline is None
    assert res.e3g_rise_days == () and res.lh_surge_days == ()


def test_lh_surge_relative_threshold_2_5x():
    res = analyze_hormones(run(1, lh=[4, 4, 4, 4, 4, 9.99, 10.0]))
    assert res.lh_surge_days == (D(7),)


def test_lh_surge_absolute_threshold_without_any_baseline():
    res = analyze_hormones([H(D(3), lh_miu_ml=25.0), H(D(2), lh_miu_ml=24.99)])
    assert res.lh_surge_days == (D(3),)
    assert res.lh_baseline is None


def test_lh_peak_is_max_in_first_episode_earliest_on_tie():
    lh = [4, 4, 4, 4, 4, 12, 30, 30, 15, 4, 40]
    res = analyze_hormones(run(1, lh=lh))
    assert res.lh_surge_days == (D(6), D(7), D(8), D(9), D(11))
    assert res.lh_peak_day == D(7)  # tie 30/30 -> earliest; later episode ignored


def test_ovulation_confirmed_by_three_consecutive_pdg_days_after_peak():
    lh = [4, 4, 4, 4, 4, 12, 30, 8, 4, 4, 4]
    pdg = [1, 1, 1, 1, 1, 1, 1, 6.0, 5.0, 5.5, 3]
    res = analyze_hormones(run(1, lh=lh, pdg=pdg))
    assert res.lh_peak_day == D(7)
    assert res.pdg_run_days == (D(8), D(9), D(10))
    assert res.ovulation_confirmed_day == D(10)


def test_pdg_below_threshold_or_not_consecutive_does_not_confirm():
    lh = [4, 4, 4, 4, 4, 30, 8, 4, 4, 4, 4]
    below = analyze_hormones(run(1, lh=lh, pdg=[1] * 6 + [6, 4.99, 6, 6, 6]))
    # 4.99 on D8 breaks the run; the first qualifying run is D9-D11.
    assert below.pdg_run_days == (D(9), D(10), D(11))
    assert below.ovulation_confirmed_day == D(11)
    gap = [H(D(7), pdg_ug_ml=6), H(D(8), pdg_ug_ml=6), H(D(10), pdg_ug_ml=6)]
    res = analyze_hormones(run(1, lh=lh) + gap)
    assert res.ovulation_confirmed_day is None
    assert res.lh_peak_day == D(6)


def test_pdg_on_or_before_peak_day_is_ignored():
    lh = [4, 4, 4, 4, 4, 30]
    pdg = [6, 6, 6, 6, 6, 6]
    res = analyze_hormones(run(1, lh=lh, pdg=pdg))
    assert res.lh_peak_day == D(6)
    assert res.ovulation_confirmed_day is None


def test_pdg_without_lh_peak_never_confirms_and_anovulatory_has_no_peak():
    res = analyze_hormones(run(1, lh=[4] * 20, pdg=[1] * 20, e3g=[10] * 20))
    assert res.lh_surge_days == () and res.lh_peak_day is None
    assert res.ovulation_confirmed_day is None


def test_invalid_negative_nan_and_duplicate_values_are_excluded():
    readings = [
        H(D(1), lh_miu_ml=-1.0),
        H(D(2), e3g_ng_ml=math.nan),
        H(D(3), pdg_ug_ml=5.0),
        H(D(3), pdg_ug_ml=5.0),
    ]
    res = analyze_hormones(readings)
    assert res.excluded == (
        (D(1), Analyte.LH),
        (D(2), Analyte.E3G),
        (D(3), Analyte.PDG),
    )


def test_missing_values_are_not_imputed_baseline_needs_five_real_readings():
    readings = [H(D(i), e3g_ng_ml=10) for i in (1, 3, 5, 7)] + [H(D(9), lh_miu_ml=3)]
    res = analyze_hormones(readings)
    assert Analyte.E3G in res.insufficient_baseline


def test_input_order_does_not_matter():
    readings = run(1, lh=[4, 4, 4, 4, 4, 30], e3g=[10, 10, 10, 10, 10, 20])
    assert analyze_hormones(list(reversed(readings))) == analyze_hormones(readings)
