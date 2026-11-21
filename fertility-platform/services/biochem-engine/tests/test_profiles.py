from dataclasses import replace
from fractions import Fraction

import pytest
from fastapi.testclient import TestClient

from app.main import create_app, version_tag
from core import ALGORITHM_VERSION
from core.cycle_synthesizer import FertilityStatus as S, Flag, analyze_cycle
from core.hormone_analyzer import HormoneReading as H, analyze_hormones
from core.profiles import DEFAULT_PROFILE, PROFILES, AssayProfile, get_profile
from tests.conftest import D

STRICT = replace(DEFAULT_PROFILE, name="strict-test", e3g_rise_factor=Fraction(2), lh_surge_factor=Fraction(4),
                 lh_surge_absolute=Fraction(40), pdg_confirm=Fraction(8), pdg_days=2, baseline_readings=3)


def test_default_profile_holds_the_specification_values_and_is_labelled_provisional():
    p = get_profile("spec-provisional-1")
    assert p is DEFAULT_PROFILE
    assert (p.baseline_readings, p.e3g_rise_factor, p.lh_surge_factor, p.lh_surge_absolute, p.pdg_confirm, p.pdg_days) == (
        5, Fraction(3, 2), Fraction(5, 2), 25, 5, 3)
    assert "NO published source" in p.evidence


def test_unknown_profile_is_rejected_with_the_available_names():
    with pytest.raises(ValueError, match="spec-provisional-1"):
        get_profile("nope")


@pytest.mark.parametrize("bad", [
    dict(name=""), dict(name="a/b"), dict(name="a+b"), dict(baseline_readings=0), dict(pdg_days=0),
    dict(e3g_rise_factor=Fraction(0)), dict(pdg_confirm=Fraction(-1)),
])
def test_invalid_profiles_cannot_be_constructed(bad):
    with pytest.raises(ValueError):
        replace(DEFAULT_PROFILE, **bad)


def test_profile_changes_e3g_decision():
    readings = [H(D(i), e3g_ng_ml=10) for i in range(1, 4)] + [H(D(4), e3g_ng_ml=15), H(D(5), e3g_ng_ml=20)]
    assert analyze_hormones(readings, STRICT).e3g_rise_days == (D(5),)  # 2x needed, baseline from 3 readings
    loose = replace(STRICT, name="loose-test", e3g_rise_factor=Fraction(3, 2))
    assert analyze_hormones(readings, loose).e3g_rise_days == (D(4), D(5))


def test_profile_changes_lh_and_pdg_decisions():
    lh = [H(D(i), lh_miu_ml=4) for i in range(1, 4)] + [H(D(4), lh_miu_ml=30), H(D(5), lh_miu_ml=16)]
    assert analyze_hormones(lh, STRICT).lh_surge_days == (D(4), D(5))  # 30 < 40 absolute, but both >= 4x baseline of 4
    assert analyze_hormones(lh).lh_surge_days == (D(4),)  # default: no baseline yet (needs 5), only 30 >= 25 qualifies
    pdg = lh + [H(D(6), pdg_ug_ml=9), H(D(7), pdg_ug_ml=9), H(D(8), pdg_ug_ml=7.9)]
    assert analyze_hormones(pdg, STRICT).ovulation_confirmed_day == D(7)  # 2 days at >= 8


def test_profile_flows_into_reasoning_text():
    hormones = [H(D(i), e3g_ng_ml=10) for i in range(1, 4)] + [H(D(4), e3g_ng_ml=25)]
    day = {d.day: d for d in analyze_cycle([], hormones, [], STRICT).days}[D(4)]
    assert day.status is S.HIGH and Flag.E3G_RISE in day.flags
    assert "2x" in " ".join(day.reasoning)
    default_day = {d.day: d for d in analyze_cycle([], hormones, [], DEFAULT_PROFILE).days}[D(4)]
    assert Flag.HORMONE_BASELINE_INSUFFICIENT in default_day.flags
    assert "needs 5 readings" in " ".join(default_day.reasoning)


TOKEN = "t" * 40
HDR = {"X-Engine-Token": TOKEN}
BODY = {"hormones": [{"day": "2025-03-02", "lh_miu_ml": 26.0}]}


def test_api_stamps_the_profile_into_the_version_and_hash(monkeypatch):
    monkeypatch.setitem(PROFILES, STRICT.name, STRICT)
    c = TestClient(create_app(TOKEN))
    default = c.post("/v1/analyze", json=BODY, headers=HDR).json()
    assert default["profile"] == "spec-provisional-1"
    assert default["algorithm_version"] == f"{ALGORITHM_VERSION}+spec-provisional-1" == version_tag("spec-provisional-1")
    strict = c.post("/v1/analyze", json={**BODY, "profile": "strict-test"}, headers=HDR).json()
    assert strict["algorithm_version"].endswith("+strict-test")
    assert strict["input_hash"] != default["input_hash"]  # same data, different thresholds => distinct run
    assert default["days"][0]["status"] == "PEAK" and strict["days"][0]["status"] == "INSUFFICIENT_DATA"


def test_api_rejects_unknown_profile(monkeypatch):
    r = TestClient(create_app(TOKEN)).post("/v1/analyze", json={**BODY, "profile": "mira-guess"}, headers=HDR)
    assert r.status_code == 422 and "unknown assay profile" in r.json()["detail"]
