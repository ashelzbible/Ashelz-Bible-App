"""Generate golden vectors for the JavaScript port of the engine (apps/pwa/lib/engine).

Runs the Python engine - the source of truth - on seeded pseudo-random and hand-built cases, under every registered
assay profile, and writes inputs plus exact outputs to the path given as the first argument (default apps/pwa/test/golden.json, git-ignored). The JavaScript test must reproduce
every status, flag and reasoning string exactly.

    cd services/biochem-engine && python3 tools/make_golden.py [output.json]
"""

import json
import random
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core.bbt_analyzer import BbtReading  # noqa: E402
from core.cycle_synthesizer import MucusReading, analyze_cycle  # noqa: E402
from core.hormone_analyzer import HormoneReading  # noqa: E402
from core.profiles import PROFILES  # noqa: E402

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[3] / "apps/pwa/test/golden.json"
rng = random.Random(20261121)
iso = lambda d: d.isoformat()  # noqa: E731


def cycle_case(scale: str, length: int, start: date) -> dict:
    """A simulated cycle with realistic structure plus controlled noise. `scale` picks the hormone magnitudes."""
    ov = rng.randint(max(4, int(length * 0.4)), max(5, int(length * 0.8)))
    p_bbt, p_h, p_m = rng.choice([1.0, 0.9, 0.7]), rng.choice([1.0, 0.9, 0.6]), rng.choice([1.0, 0.8, 0.5])
    base_t = round(rng.uniform(36.2, 36.6), 2)
    shift = rng.choice([0.2, 0.25, 0.3, 0.19, 0.4])
    e3g_base = rng.choice([8, 10, 12.5, 20]) if scale == "spec" else rng.choice([40, 60, 80])
    lh_base = rng.choice([3, 4, 4.5, 6])
    bbt, hormones, mucus = [], [], []
    for i in range(length):
        d = start + timedelta(days=i)
        day = i + 1
        if rng.random() < p_bbt:
            t = base_t + rng.choice([0, 0.01, 0.02, 0.03, 0.04]) + (shift if day > ov else 0)
            r = rng.random()
            if r < 0.03:
                t = rng.choice([38.2, 38.9, 37.81])
            elif r < 0.04:
                t = rng.choice([33.0, 43.0, 34.0, 42.0])
            bbt.append({"day": iso(d), "temp_c": round(t, 2), "sleep_disrupted": rng.random() < 0.05})
            if rng.random() < 0.02:
                bbt.append({"day": iso(d), "temp_c": round(base_t, 2), "sleep_disrupted": False})
        if rng.random() < p_h:
            h = {"day": iso(d)}
            rise = ov - 5 <= day <= ov
            e3g = (e3g_base * rng.choice([1.5, 2, 2.5, 3]) if scale == "spec" else rng.choice([150.0, 150.1, 160, 220, 300])) if rise else e3g_base * rng.choice([0.8, 1, 1.1])
            if rng.random() < 0.9:
                h["e3g_ng_ml"] = round(e3g, 2)
            if day in (ov - 1, ov):
                lh = rng.choice([11.0, 11.1, 25.0, 24.9, 30, 40, 45]) if day == ov - 1 else rng.choice([12, 20, 30, 35, 28])
            elif day == ov + 1 or day == ov + 2:
                lh = rng.choice([4, 6, 10, 14, 15, 15.1, 8])
            else:
                lh = lh_base * rng.choice([0.8, 1, 1.2])
            if rng.random() < 0.9:
                h["lh_miu_ml"] = round(lh, 2)
            if day > ov and rng.random() < 0.85:
                h["pdg_ug_ml"] = rng.choice([5.0, 4.99, 5.01, 6, 7.5, 9, 2.1, 12])
            elif rng.random() < 0.8:
                h["pdg_ug_ml"] = round(rng.uniform(0.3, 2.5), 2)
            if rng.random() < 0.02:
                h["lh_miu_ml"] = -1.0
            if len(h) > 1:
                hormones.append(h)
                if rng.random() < 0.02:
                    hormones.append({"day": iso(d), "e3g_ng_ml": 10.0})
        if rng.random() < p_m:
            score = rng.choice([0, 0, 1, 1, 2, 3, 4]) if not (ov - 3 <= day <= ov) else rng.choice([2, 3, 4, 4])
            if rng.random() < 0.01:
                score = rng.choice([5, -1])
            mucus.append({"day": iso(d), "score": score})
            if rng.random() < 0.03:
                mucus.append({"day": iso(d), "score": rng.choice([0, 4])})
    return {"bbt": bbt, "hormones": hormones, "mucus": mucus}


def run(profile_name: str, case: dict) -> dict:
    try:
        res = analyze_cycle(
            [BbtReading(date.fromisoformat(r["day"]), r["temp_c"], r["sleep_disrupted"]) for r in case["bbt"]],
            [HormoneReading(date.fromisoformat(r["day"]), r.get("lh_miu_ml"), r.get("e3g_ng_ml"), r.get("pdg_ug_ml")) for r in case["hormones"]],
            [MucusReading(date.fromisoformat(r["day"]), r["score"]) for r in case["mucus"]],
            PROFILES[profile_name],
        )
    except ValueError as exc:
        return {"error": str(exc)}
    return {
        "days": [{"day": iso(d.day), "status": d.status.value, "flags": [f.value for f in d.flags], "reasoning": list(d.reasoning)} for d in res.days],
        "ovulation_confirmed_on": None if res.ovulation_confirmed_on is None else iso(res.ovulation_confirmed_on),
        "anovulatory_pattern_suspected": res.anovulatory_pattern_suspected,
    }


cases = []
for n in range(260):
    scale = rng.choice(["spec", "mira"])
    length = rng.choice([3, 6, 9, 12, 16, 20, 24, 28, 34, 38, 45])
    inp = cycle_case(scale, length, date(2025, 1, 1) + timedelta(days=rng.randint(0, 600)))
    for name in PROFILES:
        cases.append({"id": f"fuzz-{n}-{scale}-{name}", "profile": name, "input": inp, "expected": run(name, inp)})

# hand-built edge cases
empty = {"bbt": [], "hormones": [], "mucus": []}
too_long = {"bbt": [{"day": "2024-01-01", "temp_c": 36.5, "sleep_disrupted": False}, {"day": "2025-06-01", "temp_c": 36.5, "sleep_disrupted": False}], "hormones": [], "mucus": []}
flat = {"bbt": [{"day": iso(date(2025, 3, 1) + timedelta(days=i)), "temp_c": 36.4 + 0.01 * (i % 3), "sleep_disrupted": False} for i in range(40)], "hormones": [], "mucus": [{"day": iso(date(2025, 3, 1) + timedelta(days=i)), "score": 1} for i in range(40)]}
exact = {"bbt": [{"day": iso(date(2025, 3, 1) + timedelta(days=i)), "temp_c": t, "sleep_disrupted": False} for i, t in enumerate([36.4, 36.45, 36.42, 36.5, 36.44, 36.48, 36.6, 36.65, 36.7])], "hormones": [], "mucus": []}
for name, inp in [("empty", empty), ("span-over-366", too_long), ("anovulatory-40-days", flat), ("exact-0.20-boundary", exact)]:
    for p in PROFILES:
        cases.append({"id": f"{name}-{p}", "profile": p, "input": inp, "expected": run(p, inp)})

profiles = {
    n: {
        "evidence": p.evidence, "baselineReadings": p.baseline_readings,
        "e3gRiseFactor": None if p.e3g_rise_factor is None else str(p.e3g_rise_factor),
        "e3gAbove": None if p.e3g_above is None else str(p.e3g_above),
        "lhSurgeFactor": None if p.lh_surge_factor is None else str(p.lh_surge_factor),
        "lhSurgeAbsolute": None if p.lh_surge_absolute is None else str(p.lh_surge_absolute),
        "lhPeakRule": None if p.lh_peak_rule is None else [str(p.lh_peak_rule.min_above), p.lh_peak_rule.decline_days, str(p.lh_peak_rule.decline_fraction)],
        "fertileWindowDaysAfterPeak": p.fertile_window_days_after_peak,
        "pdgConfirm": None if p.pdg_confirm is None else str(p.pdg_confirm), "pdgDays": p.pdg_days,
    }
    for n, p in PROFILES.items()
}
OUT.write_text(json.dumps({"profiles": profiles, "cases": cases}, separators=(",", ":")))
statuses = {}
for c in cases:
    for d in c["expected"].get("days", []):
        statuses[d["status"]] = statuses.get(d["status"], 0) + 1
print(f"{len(cases)} cases -> {OUT} ({OUT.stat().st_size // 1024} KiB); day statuses covered: {statuses}")
