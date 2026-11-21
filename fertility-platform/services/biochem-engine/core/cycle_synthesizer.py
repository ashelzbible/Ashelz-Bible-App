"""Unified daily fertility status from BBT, urinary hormones and cervical mucus.

Pure and deterministic. Each day is evaluated *causally*: only data dated on
or before that day is visible. Consequently a status already issued for a
past day never changes when later data arrives (verified history is not
rewritten); new data can only add statuses for new days or fill days that
previously had no data.

Status precedence per day (first match wins):
  OVULATION_CONFIRMED  PdG confirmation or BBT 3-over-6 shift confirmed on or
                       before the day
  PEAK                 LH surge on the day or the day before; or egg-white
                       mucus together with an E3G rise on the day
  HIGH                 E3G rise on the day, or watery/egg-white mucus
  LOW                  an informative observation exists and none of the
                       above apply
  INSUFFICIENT_DATA    nothing on the day can rule fertility in or out
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from enum import Enum

from .bbt_analyzer import BbtReading, BbtStatus, analyze_bbt
from .hormone_analyzer import Analyte, HormoneReading, analyze_hormones
from .profiles import DEFAULT_PROFILE, AssayProfile

PEAK_DAYS_AFTER_SURGE = 1  # ovulation follows the LH surge by ~24-36 h
ANOVULATORY_MIN_SPAN_DAYS = 35  # cycle-level flag only; never written onto past days
MUCUS_MIN = 0
MUCUS_MAX = 4
MUCUS_FERTILE_MIN = 3  # 3 = watery, 4 = egg-white
MUCUS_DISCORDANT_MAX = 1  # dry/sticky mucus alongside a hormone rise
MAX_SPAN_DAYS = 366


class FertilityStatus(str, Enum):
    LOW = "LOW"
    HIGH = "HIGH"
    PEAK = "PEAK"
    OVULATION_CONFIRMED = "OVULATION_CONFIRMED"
    INSUFFICIENT_DATA = "INSUFFICIENT_DATA"


class Flag(str, Enum):
    PDG_OVULATION_CONFIRMED = "PDG_OVULATION_CONFIRMED"
    BBT_SHIFT_CONFIRMED = "BBT_SHIFT_CONFIRMED"
    LH_SURGE = "LH_SURGE"
    LH_SURGE_RECENT = "LH_SURGE_RECENT"
    FERTILE_WINDOW_AFTER_PEAK = "FERTILE_WINDOW_AFTER_PEAK"
    E3G_RISE = "E3G_RISE"
    MUCUS_FERTILE = "MUCUS_FERTILE"
    MUCUS_PEAK_QUALITY = "MUCUS_PEAK_QUALITY"
    MUCUS_PEAK_WITHOUT_HORMONE_SUPPORT = "MUCUS_PEAK_WITHOUT_HORMONE_SUPPORT"
    MUCUS_HORMONE_DISCORDANT = "MUCUS_HORMONE_DISCORDANT"
    BBT_ONLY_CONFIRMATION = "BBT_ONLY_CONFIRMATION"
    PDG_BBT_DISCORDANT = "PDG_BBT_DISCORDANT"
    HORMONE_BASELINE_INSUFFICIENT = "HORMONE_BASELINE_INSUFFICIENT"
    INVALID_MUCUS_SCORE = "INVALID_MUCUS_SCORE"
    NO_OBSERVATIONS = "NO_OBSERVATIONS"
    BBT_ONLY_PRE_OVULATION = "BBT_ONLY_PRE_OVULATION"


@dataclass(frozen=True)
class MucusReading:
    """Cervical mucus score: 0 dry, 1 sticky, 2 creamy, 3 watery, 4 egg-white."""

    day: date
    score: int


@dataclass(frozen=True)
class DayStatus:
    day: date
    status: FertilityStatus
    flags: tuple[Flag, ...]
    reasoning: tuple[str, ...]


@dataclass(frozen=True)
class CycleAnalysis:
    days: tuple[DayStatus, ...]
    ovulation_confirmed_on: date | None
    anovulatory_pattern_suspected: bool


def _valid_mucus(readings: list[MucusReading]) -> tuple[dict[date, int], set[date]]:
    """{day: score} for unambiguous in-range entries, plus the set of invalid days."""
    seen: dict[date, list[int]] = {}
    for m in readings:
        seen.setdefault(m.day, []).append(m.score)
    valid: dict[date, int] = {}
    invalid: set[date] = set()
    for day, scores in seen.items():
        if len(scores) > 1 or not MUCUS_MIN <= scores[0] <= MUCUS_MAX:
            invalid.add(day)
        else:
            valid[day] = scores[0]
    return valid, invalid


def _lh_rule_text(profile: AssayProfile) -> str:
    parts: list[str] = []
    if profile.lh_surge_factor is not None:
        parts.append(f">= {float(profile.lh_surge_factor):g}x baseline")
    if profile.lh_surge_absolute is not None:
        parts.append(f">= {float(profile.lh_surge_absolute):g} mIU/mL")
    if profile.lh_peak_rule is not None:
        r = profile.lh_peak_rule
        parts.append(
            f"> {float(r.min_above):g} mIU/mL, a candidate peak confirmed when {r.decline_days} consecutive "
            f"days follow at least {float(r.decline_fraction):.0%} lower"
        )
    return " or ".join(parts)


def _e3g_rule_text(profile: AssayProfile) -> str:
    parts: list[str] = []
    if profile.e3g_rise_factor is not None:
        parts.append(f">= {float(profile.e3g_rise_factor):g}x follicular baseline")
    if profile.e3g_above is not None:
        parts.append(f"> {float(profile.e3g_above):g} ng/mL")
    return " or ".join(parts)


def _status_for_day(
    day: date,
    bbt: list[BbtReading],
    hormones: list[HormoneReading],
    mucus: list[MucusReading],
    profile: AssayProfile,
) -> DayStatus:
    """Evaluate one day from data already restricted to dates <= day."""
    bbt_res = analyze_bbt(bbt)
    horm = analyze_hormones(hormones, profile)
    mucus_valid, mucus_invalid = _valid_mucus(mucus)

    flags: list[Flag] = []
    why: list[str] = []

    if day in mucus_invalid:
        flags.append(Flag.INVALID_MUCUS_SCORE)
        why.append("Mucus entry for this day was invalid or duplicated and was ignored.")
    # Only warn when the day actually carries a reading that cannot be judged.
    today = [r for r in hormones if r.day == day]
    unjudged = [
        a for a in horm.insufficient_baseline
        if any((r.e3g_ng_ml if a is Analyte.E3G else r.lh_miu_ml) is not None for r in today)
    ]
    if unjudged:
        flags.append(Flag.HORMONE_BASELINE_INSUFFICIENT)
        names = "/".join(a.value for a in unjudged)
        why.append(f"{names} follicular baseline not yet established (needs {profile.baseline_readings} readings).")

    # --- OVULATION_CONFIRMED -------------------------------------------------
    pdg_on = horm.ovulation_confirmed_day
    bbt_on = bbt_res.confirmation_date if bbt_res.status is BbtStatus.SHIFT_CONFIRMED else None
    if pdg_on is not None or bbt_on is not None:
        if pdg_on is not None:
            flags.append(Flag.PDG_OVULATION_CONFIRMED)
            why.append(
                f"PdG >= {float(profile.pdg_confirm):g} ug/mL on {profile.pdg_days} consecutive days after the LH peak ({horm.lh_peak_day}); "
                f"confirmed on {pdg_on}."
            )
        if bbt_on is not None:
            flags.append(Flag.BBT_SHIFT_CONFIRMED)
            why.append(
                f"Sustained thermal shift (3-over-6, coverline {bbt_res.coverline_c:.2f} C) "
                f"began {bbt_res.shift_start}; confirmed on {bbt_on}."
            )
        if pdg_on is None:
            flags.append(Flag.BBT_ONLY_CONFIRMATION)
            why.append("Confirmation rests on BBT alone; no PdG confirmation available.")
        elif bbt_on is None and bbt_res.status is BbtStatus.NO_SHIFT:
            flags.append(Flag.PDG_BBT_DISCORDANT)
            why.append("PdG confirms ovulation but BBT shows no qualifying shift.")
        return DayStatus(day, FertilityStatus.OVULATION_CONFIRMED, tuple(flags), tuple(why))

    # --- PEAK ----------------------------------------------------------------
    surge_today = day in horm.lh_surge_days
    surge_recent = any(
        0 < (day - s).days <= PEAK_DAYS_AFTER_SURGE for s in horm.lh_surge_days
    )
    e3g_today = day in horm.e3g_rise_days
    mucus_today = mucus_valid.get(day)

    if surge_today:
        flags.append(Flag.LH_SURGE)
        why.append(f"LH surge ({_lh_rule_text(profile)}).")
    elif surge_recent:
        flags.append(Flag.LH_SURGE_RECENT)
        why.append("Within 1 day after an LH surge; ovulation is imminent.")
    if e3g_today:
        flags.append(Flag.E3G_RISE)
        why.append(f"E3G rise ({_e3g_rule_text(profile)}).")
    if mucus_today is not None and mucus_today >= MUCUS_FERTILE_MIN:
        flags.append(Flag.MUCUS_FERTILE)
        why.append(f"Fertile-quality cervical mucus (score {mucus_today}).")
    if mucus_today == MUCUS_MAX:
        flags.append(Flag.MUCUS_PEAK_QUALITY)

    if surge_today or surge_recent or (mucus_today == MUCUS_MAX and e3g_today):
        return DayStatus(day, FertilityStatus.PEAK, tuple(flags), tuple(why))

    # --- HIGH ----------------------------------------------------------------
    in_window_tail = horm.fertile_window_end is not None and horm.lh_peak_day is not None and horm.lh_peak_day < day <= horm.fertile_window_end
    if in_window_tail:
        flags.append(Flag.FERTILE_WINDOW_AFTER_PEAK)
        why.append(f"Within the fertile window, which closes {horm.fertile_window_end} (confirmed LH peak {horm.lh_peak_day}).")
    if in_window_tail or e3g_today or (mucus_today is not None and mucus_today >= MUCUS_FERTILE_MIN):
        if mucus_today == MUCUS_MAX:
            flags.append(Flag.MUCUS_PEAK_WITHOUT_HORMONE_SUPPORT)
            why.append("Egg-white mucus without E3G rise or LH surge; not escalated to PEAK.")
        if e3g_today and mucus_today is not None and mucus_today <= MUCUS_DISCORDANT_MAX:
            flags.append(Flag.MUCUS_HORMONE_DISCORDANT)
            why.append("E3G is elevated but mucus is not fertile; hormone value takes precedence.")
        return DayStatus(day, FertilityStatus.HIGH, tuple(flags), tuple(why))

    # --- LOW vs INSUFFICIENT_DATA ----------------------------------------------
    # A day is informative when it has a valid mucus score, or an E3G reading
    # that can be judged against an established baseline. A temperature alone
    # cannot rule out fertility before ovulation, and a hormone reading
    # without a baseline cannot be judged.
    e3g_evaluable = Analyte.E3G not in horm.insufficient_baseline and any(
        r.day == day and r.e3g_ng_ml is not None for r in hormones
    )
    if mucus_today is not None:
        why.append(f"Non-fertile cervical mucus (score {mucus_today}) and no hormone trigger.")
        return DayStatus(day, FertilityStatus.LOW, tuple(flags), tuple(why))
    if e3g_evaluable:
        why.append("E3G within follicular baseline range and no LH surge.")
        return DayStatus(day, FertilityStatus.LOW, tuple(flags), tuple(why))

    if any(r.day == day for r in bbt):
        flags.append(Flag.BBT_ONLY_PRE_OVULATION)
        why.append(
            "Only a temperature was logged and no shift is confirmed; "
            "BBT cannot rule out fertility before ovulation."
        )
    else:
        flags.append(Flag.NO_OBSERVATIONS)
        why.append("No usable observations on this day.")
    return DayStatus(day, FertilityStatus.INSUFFICIENT_DATA, tuple(flags), tuple(why))


def analyze_cycle(
    bbt: list[BbtReading],
    hormones: list[HormoneReading],
    mucus: list[MucusReading],
    profile: AssayProfile = DEFAULT_PROFILE,
) -> CycleAnalysis:
    """Produce one DayStatus per calendar day from the first to the last datum."""
    all_days = [r.day for r in bbt] + [r.day for r in hormones] + [r.day for r in mucus]
    if not all_days:
        return CycleAnalysis((), None, False)

    start, end = min(all_days), max(all_days)
    if (end - start).days + 1 > MAX_SPAN_DAYS:
        raise ValueError(f"data span exceeds {MAX_SPAN_DAYS} days; split into separate cycles")

    statuses: list[DayStatus] = []
    for offset in range((end - start).days + 1):
        d = start + timedelta(days=offset)
        statuses.append(
            _status_for_day(
                d,
                [r for r in bbt if r.day <= d],
                [r for r in hormones if r.day <= d],
                [r for r in mucus if r.day <= d],
                profile,
            )
        )

    confirmed_on = next(
        (s.day for s in statuses if s.status is FertilityStatus.OVULATION_CONFIRMED), None
    )
    final_horm = analyze_hormones(hormones, profile)
    final_bbt = analyze_bbt(bbt)
    anovulatory = (
        confirmed_on is None
        and (end - start).days + 1 >= ANOVULATORY_MIN_SPAN_DAYS
        and not final_horm.lh_surge_days
        and final_bbt.status is not BbtStatus.SHIFT_CONFIRMED
    )
    return CycleAnalysis(tuple(statuses), confirmed_on, anovulatory)
