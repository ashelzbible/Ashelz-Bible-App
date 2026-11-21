from dataclasses import replace
from fractions import Fraction

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from core.bbt_analyzer import BbtReading
from core.cycle_synthesizer import FertilityStatus as S, Flag, MucusReading, analyze_cycle
from core.hormone_analyzer import Analyte, HormoneReading as H, analyze_hormones
from core.profiles import DEFAULT_PROFILE, MIRA_MARQUETTE_PRELIMINARY as MIRA, LhPeakRule, get_profile
from tests.conftest import D


def lh(*values, start=1):
    return [H(D(start + i), lh_miu_ml=v) for i, v in enumerate(values)]


def e3g(*values, start=1):
    return [H(D(start + i), e3g_ng_ml=v) for i, v in enumerate(values)]


def test_mira_profile_is_registered_labelled_preliminary_and_not_the_default():
    assert get_profile("mira-marquette-2021-preliminary") is MIRA
    assert MIRA is not DEFAULT_PROFILE
    assert "PRELIMINARY" in MIRA.evidence and "NOT read" in MIRA.evidence and "100 ng/mL" in MIRA.evidence
    assert MIRA.pdg_confirm is None  # no Mira PdG rule is published in the source


# ---- E3G absolute rule ---------------------------------------------------------
def test_e3g_above_150_is_strict_and_needs_no_baseline():
    res = analyze_hormones(e3g(100, 150, 150.1, 400), MIRA)
    assert res.e3g_rise_days == (D(3), D(4))  # exactly 150 does not qualify
    assert res.insufficient_baseline == ()  # no relative rule -> no baseline requirement
    assert res.e3g_baseline is None


def test_relative_and_absolute_e3g_rules_combine():
    both = replace(DEFAULT_PROFILE, name="both-test", e3g_above=Fraction(30))
    readings = e3g(10, 10, 10, 10, 10, 31, 16)
    assert analyze_hormones(readings, both).e3g_rise_days == (D(6), D(7))  # 31 absolute; 16 >= 1.5x baseline
    assert analyze_hormones(readings, DEFAULT_PROFILE).e3g_rise_days == (D(6), D(7))
    assert analyze_hormones(e3g(10, 10, 10, 10, 10, 31, 12), both).e3g_rise_days == (D(6),)


# ---- LH peak rule --------------------------------------------------------------
def test_lh_candidate_requires_strictly_more_than_11():
    assert analyze_hormones(lh(5, 11, 11.1, 4, 4), MIRA).lh_surge_days == (D(3),)


def test_peak_is_the_cycle_maximum_confirmed_by_two_days_at_least_half_lower():
    res = analyze_hormones(lh(4, 12, 30, 14, 15, 4), MIRA)
    assert res.lh_peak_day == D(3)  # 30; followed by 14 and 15, both <= 15
    assert res.fertile_window_end == D(7)  # peak + 4 days


def test_decline_of_exactly_fifty_percent_qualifies_but_slightly_less_does_not():
    assert analyze_hormones(lh(4, 40, 20, 20), MIRA).lh_peak_day == D(2)
    assert analyze_hormones(lh(4, 40, 20.1, 20), MIRA).lh_peak_day is None


def test_peak_is_unconfirmed_until_the_decline_is_observed_and_never_guessed():
    assert analyze_hormones(lh(4, 30), MIRA).lh_peak_day is None  # nothing after the peak yet
    assert analyze_hormones(lh(4, 30, 10), MIRA).lh_peak_day is None  # only one day so far
    assert analyze_hormones([*lh(4, 30, 10, start=1), H(D(5), lh_miu_ml=9)], MIRA).lh_peak_day is None  # day 4 missing
    assert analyze_hormones(lh(4, 30, 10, 9), MIRA).lh_peak_day == D(2)


def test_multiple_surges_choose_the_highest_not_the_first_and_ties_go_to_the_earliest():
    res = analyze_hormones(lh(4, 14, 5, 5, 4, 40, 10, 10, 4), MIRA)
    assert res.lh_peak_day == D(6)  # 40 beats the earlier 14 surge
    tie = analyze_hormones(lh(4, 30, 5, 5, 4, 30, 5, 5), MIRA)
    assert tie.lh_peak_day == D(2)


def test_no_candidate_above_threshold_means_no_peak_or_window():
    res = analyze_hormones(lh(4, 6, 9, 11), MIRA)
    assert res.lh_surge_days == () and res.lh_peak_day is None and res.fertile_window_end is None


def test_profile_without_a_window_rule_has_no_window_end():
    no_window = replace(MIRA, name="no-window-test", fertile_window_days_after_peak=None)
    assert analyze_hormones(lh(4, 30, 10, 9), no_window).fertile_window_end is None


def test_pdg_is_ignored_when_the_profile_has_no_pdg_rule():
    readings = [H(D(1), lh_miu_ml=4), H(D(2), lh_miu_ml=30), H(D(3), lh_miu_ml=10), H(D(4), lh_miu_ml=9),
                H(D(5), pdg_ug_ml=9), H(D(6), pdg_ug_ml=9), H(D(7), pdg_ug_ml=9)]
    assert analyze_hormones(readings, MIRA).ovulation_confirmed_day is None
    assert analyze_hormones(readings, replace(MIRA, name="pdg-test", pdg_confirm=Fraction(5))).ovulation_confirmed_day == D(7)


# ---- profile validation ----------------------------------------------------------
@pytest.mark.parametrize("bad", [
    dict(min_above=Fraction(0), decline_days=2, decline_fraction=Fraction(1, 2)),
    dict(min_above=Fraction(11), decline_days=0, decline_fraction=Fraction(1, 2)),
    dict(min_above=Fraction(11), decline_days=2, decline_fraction=Fraction(0)),
    dict(min_above=Fraction(11), decline_days=2, decline_fraction=Fraction(1)),
])
def test_invalid_peak_rules_are_rejected(bad):
    with pytest.raises(ValueError):
        LhPeakRule(**bad)


def test_negative_window_and_nonpositive_optional_thresholds_are_rejected():
    with pytest.raises(ValueError):
        replace(MIRA, name="x1", fertile_window_days_after_peak=-1)
    with pytest.raises(ValueError):
        replace(MIRA, name="x2", e3g_above=Fraction(0))


# ---- synthesized daily status ------------------------------------------------------
def mira_cycle():
    e3g_vals = [60, 70, 90, 120, 160, 200, 180, 120, 80, 60, 50, 40]
    lh_vals = [4, 4, 4, 5, 8, 14, 30, 12, 10, 6, 4, 4]
    return [H(D(i + 1), lh_miu_ml=lh_vals[i], e3g_ng_ml=e3g_vals[i]) for i in range(12)]


def test_mira_daily_statuses_follow_the_marquette_window():
    res = analyze_cycle([], mira_cycle(), [], MIRA)
    by = {d.day: d for d in res.days}
    assert by[D(2)].status is S.LOW  # E3G 70 <= 150, judgeable with no baseline
    assert by[D(5)].status is S.HIGH and Flag.E3G_RISE in by[D(5)].flags  # E3G 160 > 150
    assert by[D(6)].status is S.PEAK  # LH 14 > 11: candidate peak
    assert by[D(7)].status is S.PEAK and Flag.LH_SURGE in by[D(7)].flags  # 30
    assert by[D(8)].status is S.PEAK and Flag.LH_SURGE in by[D(8)].flags  # LH 12 > 11: still a candidate
    assert by[D(9)].status is S.PEAK and Flag.LH_SURGE_RECENT in by[D(9)].flags  # day after a candidate day
    assert "E3G rise (> 150 ng/mL)" in " ".join(by[D(5)].reasoning)
    assert "candidate peak confirmed when 2 consecutive days follow at least 50% lower" in " ".join(by[D(7)].reasoning)
    # the peak (D7, LH 30) is confirmed on D9 (D8=12 and D9=10 are both <= 15); the window then runs to D11
    assert by[D(10)].status is S.HIGH and Flag.FERTILE_WINDOW_AFTER_PEAK in by[D(10)].flags
    assert by[D(11)].status is S.HIGH and "closes 2025-03-11" in " ".join(by[D(11)].reasoning)
    assert by[D(12)].status is S.LOW  # window closed
    assert res.ovulation_confirmed_on is None  # no PdG rule, no BBT supplied


def test_mira_history_is_not_rewritten_when_later_days_arrive():
    full = mira_cycle()
    early = analyze_cycle([], full[:8], [], MIRA)
    late = analyze_cycle([], full, [], MIRA)
    assert late.days[: len(early.days)] == early.days


def test_mira_cycle_can_still_be_confirmed_by_bbt():
    temps = [36.4, 36.45, 36.42, 36.5, 36.44, 36.46, 36.43, 36.45, 36.44, 36.47, 36.45, 36.44, 36.8, 36.82, 36.9]
    bbt = [BbtReading(D(i + 1), t) for i, t in enumerate(temps)]
    res = analyze_cycle(bbt, mira_cycle(), [MucusReading(D(1), 1)], MIRA)
    assert res.ovulation_confirmed_on == D(15)
    last = {d.day: d for d in res.days}[D(15)]
    assert Flag.BBT_ONLY_CONFIRMATION in last.flags


def test_default_profile_reasoning_is_unchanged_in_meaning():
    day = {d.day: d for d in analyze_cycle([], [H(D(1), lh_miu_ml=26)], [], DEFAULT_PROFILE).days}[D(1)]
    assert "LH surge (>= 2.5x baseline or >= 25 mIU/mL)" in " ".join(day.reasoning)


def test_api_runs_the_mira_profile():
    c = TestClient(create_app("t" * 40))
    body = {"profile": MIRA.name, "hormones": [{"day": "2025-03-01", "e3g_ng_ml": 151.0}]}
    r = c.post("/v1/analyze", json=body, headers={"X-Engine-Token": "t" * 40}).json()
    assert r["algorithm_version"].endswith("+mira-marquette-2021-preliminary")
    assert r["days"][0]["status"] == "HIGH"
