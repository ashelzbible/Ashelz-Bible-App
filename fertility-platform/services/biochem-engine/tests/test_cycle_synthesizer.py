import pytest

from core.bbt_analyzer import BbtReading
from core.cycle_synthesizer import (
    FertilityStatus as S,
    Flag,
    MucusReading,
    analyze_cycle,
)
from core.hormone_analyzer import HormoneReading
from tests.conftest import D


def full_cycle():
    """A textbook 17-day ovulatory cycle with all three data sources."""
    e3g = [10] * 5 + [11, 11, 11, 11, 16, 20, 20, 20, 12, 12, 12, 12]
    lh = [4] * 5 + [4, 4, 4, 4, 4, 4, 12, 30, 8, 4, 4, 4, 4]
    pdg = [1] * 14 + [6, 6, 7]
    hormones = [
        HormoneReading(D(i + 1), lh_miu_ml=lh[i], e3g_ng_ml=e3g[i], pdg_ug_ml=pdg[i])
        for i in range(17)
    ]
    bbt_temps = [36.40, 36.45, 36.42, 36.50, 36.44, 36.46, 36.43, 36.45, 36.44, 36.47,
                 36.45, 36.44, 36.46, 36.44, 36.80, 36.82, 36.90]
    bbt = [BbtReading(D(i + 1), t) for i, t in enumerate(bbt_temps)]
    mucus = [MucusReading(D(d), s) for d, s in
             {1: 0, 2: 0, 3: 1, 4: 1, 5: 2, 10: 3, 11: 3, 12: 4, 13: 4, 14: 2, 15: 1, 16: 1}.items()]
    return bbt, hormones, mucus


def statuses(analysis):
    return {d.day: d for d in analysis.days}


def test_full_ovulatory_cycle_status_progression():
    res = analyze_cycle(*full_cycle())
    by = statuses(res)
    assert by[D(1)].status is S.LOW  # mucus only: hormone baseline not yet established
    assert by[D(9)].status is S.LOW  # E3G judged against the established baseline
    assert by[D(10)].status is S.HIGH  # E3G 16 >= 15 and watery mucus
    assert {Flag.E3G_RISE, Flag.MUCUS_FERTILE} <= set(by[D(10)].flags)
    assert by[D(11)].status is S.HIGH
    assert by[D(12)].status is S.PEAK and Flag.LH_SURGE in by[D(12)].flags
    assert by[D(13)].status is S.PEAK and Flag.LH_SURGE in by[D(13)].flags
    assert by[D(14)].status is S.PEAK and Flag.LH_SURGE_RECENT in by[D(14)].flags
    assert by[D(15)].status is S.LOW
    assert by[D(16)].status is S.LOW
    assert by[D(17)].status is S.OVULATION_CONFIRMED
    assert {Flag.PDG_OVULATION_CONFIRMED, Flag.BBT_SHIFT_CONFIRMED} <= set(by[D(17)].flags)
    assert res.ovulation_confirmed_on == D(17)
    assert not res.anovulatory_pattern_suspected
    assert all(d.reasoning for d in res.days)


def test_verified_history_is_never_rewritten_by_later_data():
    bbt, hormones, mucus = full_cycle()
    cutoff = D(14)
    partial = analyze_cycle(
        [r for r in bbt if r.day <= cutoff],
        [r for r in hormones if r.day <= cutoff],
        [r for r in mucus if r.day <= cutoff],
    )
    full = analyze_cycle(bbt, hormones, mucus)
    assert full.days[: len(partial.days)] == partial.days


def test_results_are_deterministic_and_input_order_independent():
    bbt, hormones, mucus = full_cycle()
    a = analyze_cycle(bbt, hormones, mucus)
    b = analyze_cycle(bbt[::-1], hormones[::-1], mucus[::-1])
    assert a == b


def test_empty_input():
    res = analyze_cycle([], [], [])
    assert res.days == () and res.ovulation_confirmed_on is None


def test_span_over_one_year_is_rejected():
    with pytest.raises(ValueError):
        analyze_cycle([BbtReading(D(1), 36.5), BbtReading(D(400), 36.5)], [], [])


def test_bbt_only_confirmation_is_flagged():
    bbt, _, _ = full_cycle()
    res = analyze_cycle(bbt, [], [])
    last = statuses(res)[D(17)]
    assert last.status is S.OVULATION_CONFIRMED
    assert Flag.BBT_ONLY_CONFIRMATION in last.flags
    assert statuses(res)[D(10)].status is S.INSUFFICIENT_DATA
    assert Flag.BBT_ONLY_PRE_OVULATION in statuses(res)[D(10)].flags


def test_pdg_confirmation_with_discordant_flat_bbt():
    _, hormones, _ = full_cycle()
    flat = [BbtReading(D(i), 36.45 + 0.01 * (i % 3)) for i in range(1, 18)]
    res = analyze_cycle(flat, hormones, [])
    last = statuses(res)[D(17)]
    assert last.status is S.OVULATION_CONFIRMED
    assert Flag.PDG_BBT_DISCORDANT in last.flags
    assert Flag.BBT_SHIFT_CONFIRMED not in last.flags


def test_pdg_confirmation_without_bbt_data_has_no_discordance_flag():
    _, hormones, _ = full_cycle()
    last = statuses(analyze_cycle([], hormones, []))[D(17)]
    assert last.status is S.OVULATION_CONFIRMED
    assert Flag.PDG_BBT_DISCORDANT not in last.flags


def test_egg_white_mucus_with_e3g_rise_is_peak_without_lh():
    hormones = [HormoneReading(D(i), e3g_ng_ml=10) for i in range(1, 6)] + [
        HormoneReading(D(6), e3g_ng_ml=16)
    ]
    day = statuses(analyze_cycle([], hormones, [MucusReading(D(6), 4)]))[D(6)]
    assert day.status is S.PEAK
    assert Flag.MUCUS_PEAK_QUALITY in day.flags


def test_egg_white_mucus_alone_is_high_not_peak():
    day = statuses(analyze_cycle([], [], [MucusReading(D(3), 4)]))[D(3)]
    assert day.status is S.HIGH
    assert Flag.MUCUS_PEAK_WITHOUT_HORMONE_SUPPORT in day.flags


def test_watery_mucus_alone_is_high_without_peak_support_flag():
    day = statuses(analyze_cycle([], [], [MucusReading(D(3), 3)]))[D(3)]
    assert day.status is S.HIGH
    assert Flag.MUCUS_PEAK_WITHOUT_HORMONE_SUPPORT not in day.flags


def test_hormone_rise_with_dry_mucus_is_flagged_discordant_and_high():
    hormones = [HormoneReading(D(i), e3g_ng_ml=10) for i in range(1, 6)] + [
        HormoneReading(D(6), e3g_ng_ml=20)
    ]
    day = statuses(analyze_cycle([], hormones, [MucusReading(D(6), 0)]))[D(6)]
    assert day.status is S.HIGH
    assert Flag.MUCUS_HORMONE_DISCORDANT in day.flags


def test_hormone_rise_without_mucus_data_has_no_discordance_flag():
    hormones = [HormoneReading(D(i), e3g_ng_ml=10) for i in range(1, 6)] + [
        HormoneReading(D(6), e3g_ng_ml=20)
    ]
    day = statuses(analyze_cycle([], hormones, []))[D(6)]
    assert day.status is S.HIGH and Flag.MUCUS_HORMONE_DISCORDANT not in day.flags


def test_absolute_lh_surge_without_baseline_is_peak():
    day = statuses(analyze_cycle([], [HormoneReading(D(2), lh_miu_ml=26)], []))[D(2)]
    assert day.status is S.PEAK
    assert Flag.HORMONE_BASELINE_INSUFFICIENT in day.flags


def test_e3g_within_baseline_without_mucus_is_low():
    hormones = [HormoneReading(D(i), e3g_ng_ml=10, lh_miu_ml=4) for i in range(1, 8)]
    day = statuses(analyze_cycle([], hormones, []))[D(7)]
    assert day.status is S.LOW


def test_lh_only_reading_without_e3g_is_insufficient():
    hormones = [HormoneReading(D(i), e3g_ng_ml=10, lh_miu_ml=4) for i in range(1, 6)] + [
        HormoneReading(D(6), lh_miu_ml=4)
    ]
    day = statuses(analyze_cycle([], hormones, []))[D(6)]
    assert day.status is S.INSUFFICIENT_DATA


def test_missing_day_is_insufficient_data_not_guessed():
    day = statuses(analyze_cycle([], [], [MucusReading(D(1), 0), MucusReading(D(3), 0)]))[D(2)]
    assert day.status is S.INSUFFICIENT_DATA
    assert day.flags == (Flag.NO_OBSERVATIONS,)


@pytest.mark.parametrize("scores", [[7], [-1], [2, 3]])
def test_invalid_or_duplicate_mucus_is_ignored_and_flagged(scores):
    day = statuses(analyze_cycle([], [], [MucusReading(D(1), s) for s in scores]))[D(1)]
    assert Flag.INVALID_MUCUS_SCORE in day.flags
    assert day.status is S.INSUFFICIENT_DATA


def test_fever_spike_day_cannot_trigger_a_shift_in_synthesis():
    bbt, _, _ = full_cycle()
    bbt = [BbtReading(r.day, 38.4 if r.day == D(15) else r.temp_c) for r in bbt]
    res = analyze_cycle(bbt, [], [])
    assert res.ovulation_confirmed_on is None


def anovulatory_data(days):
    mucus = [MucusReading(D(i), 1) for i in range(1, days + 1)]
    bbt = [BbtReading(D(i), 36.40 + 0.02 * (i % 4)) for i in range(1, days + 1)]
    hormones = [HormoneReading(D(i), e3g_ng_ml=10, lh_miu_ml=4, pdg_ug_ml=1) for i in range(1, days + 1)]
    return bbt, hormones, mucus


def test_anovulatory_cycle_never_confirms_and_is_flagged_after_35_days():
    res = analyze_cycle(*anovulatory_data(36))
    assert res.ovulation_confirmed_on is None
    assert res.anovulatory_pattern_suspected
    assert all(d.status is S.LOW for d in res.days[5:])


def test_short_anovulatory_looking_data_is_not_flagged_yet():
    assert not analyze_cycle(*anovulatory_data(34)).anovulatory_pattern_suspected


def test_lh_surge_without_ovulation_confirmation_is_not_anovulatory():
    bbt, hormones, mucus = anovulatory_data(40)
    hormones[20] = HormoneReading(D(21), e3g_ng_ml=10, lh_miu_ml=30, pdg_ug_ml=1)
    res = analyze_cycle(bbt, hormones, mucus)
    assert res.ovulation_confirmed_on is None
    assert not res.anovulatory_pattern_suspected
