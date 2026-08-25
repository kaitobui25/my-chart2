from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from statistics import median
from zoneinfo import ZoneInfo

from models import BreakoutVolumeScan, Candle


@dataclass(frozen=True)
class WeeklyBar:
    time: int
    bucket_end: int
    open: float
    high: float
    low: float
    close: float
    volume: float | None
    traded_value: float | None


@dataclass(frozen=True)
class BreakoutVolumeResult:
    signal_state: str
    signal_time: int
    close: float
    volume: float
    weekly_change_pct: float
    rvol: float
    breakout_level: float
    traded_value: float
    median_traded_value: float
    median_volume: float
    strong: bool
    next_week_time: int | None = None
    next_week_volume: float | None = None
    next_week_rvol: float | None = None
    next_week_close: float | None = None
    next_week_holds_breakout: bool | None = None


def _week_start(timestamp: int, timezone_name: str) -> datetime:
    local = datetime.fromtimestamp(timestamp, ZoneInfo(timezone_name))
    return (local - timedelta(days=local.weekday())).replace(
        hour=0,
        minute=0,
        second=0,
        microsecond=0,
    )


def aggregate_closed_weeks(
    daily: list[Candle],
    timezone_name: str,
    *,
    now: int | None = None,
) -> list[WeeklyBar]:
    """Aggregate daily bars and return only fully closed stock-market weeks."""
    now_ts = int(time.time()) if now is None else int(now)
    ordered = sorted(daily, key=lambda item: item.time)
    buckets: list[WeeklyBar] = []
    current_key: int | None = None
    missing_volume = False

    for candle in ordered:
        start = _week_start(candle.time, timezone_name)
        key = int(start.timestamp())
        # Stock week is eligible only after Friday has completely finished.
        bucket_end = int((start + timedelta(days=5)).timestamp())
        if current_key != key:
            missing_volume = candle.volume is None
            volume = None if missing_volume else float(candle.volume)
            traded_value = None if missing_volume else float(candle.close) * float(candle.volume)
            buckets.append(WeeklyBar(
                time=key,
                bucket_end=bucket_end,
                open=float(candle.open),
                high=float(candle.high),
                low=float(candle.low),
                close=float(candle.close),
                volume=volume,
                traded_value=traded_value,
            ))
            current_key = key
            continue

        previous = buckets[-1]
        missing_volume = missing_volume or candle.volume is None
        volume = None if missing_volume else float(previous.volume or 0) + float(candle.volume or 0)
        traded_value = (
            None
            if missing_volume
            else float(previous.traded_value or 0) + float(candle.close) * float(candle.volume or 0)
        )
        buckets[-1] = WeeklyBar(
            time=previous.time,
            bucket_end=previous.bucket_end,
            open=previous.open,
            high=max(previous.high, float(candle.high)),
            low=min(previous.low, float(candle.low)),
            close=float(candle.close),
            volume=volume,
            traded_value=traded_value,
        )

    return [bar for bar in buckets if bar.bucket_end <= now_ts]


def diagnose_breakout_volume(
    daily: list[Candle],
    timezone_name: str,
    config: BreakoutVolumeScan,
    *,
    now: int | None = None,
) -> dict[str, object]:
    """Explain Scanner 04 against the latest fully closed week without running a market scan."""
    now_ts = int(time.time()) if now is None else int(now)
    weeks = aggregate_closed_weeks(daily, timezone_name, now=now_ts)
    if len(weeks) < 12:
        raise ValueError(f'cần ít nhất 12 tuần đã đóng; hiện có {len(weeks)} tuần')

    current = weeks[-1]
    previous = weeks[-2]
    baseline = weeks[-9:-1]
    baseline_closes = [float(item.close) for item in baseline]
    baseline_volumes = [None if item.volume is None else float(item.volume) for item in baseline]
    baseline_values = [None if item.traded_value is None else float(item.traded_value) for item in baseline]

    median_volume = (
        None
        if any(value is None for value in baseline_volumes)
        else float(median([float(value) for value in baseline_volumes if value is not None]))
    )
    median_traded_value = (
        None
        if any(value is None for value in baseline_values)
        else float(median([float(value) for value in baseline_values if value is not None]))
    )
    breakout_level = float(max(baseline_closes))
    weekly_change_pct = (
        None
        if previous.close <= 0
        else (float(current.close) / float(previous.close) - 1.0) * 100.0
    )
    volume_w0 = None if current.volume is None else float(current.volume)
    rvol = (
        None
        if volume_w0 is None or median_volume is None or median_volume <= 0
        else volume_w0 / median_volume
    )

    w0_closed = current.bucket_end <= now_ts
    weekly_change_pass = (
        weekly_change_pct is not None
        and weekly_change_pct >= config.min_weekly_change_pct
    )
    breakout_pass = float(current.close) > breakout_level
    median_volume_pass = (
        median_volume is not None
        and median_volume >= config.min_median_volume
    )
    median_traded_value_pass = (
        median_traded_value is not None
        and median_traded_value >= config.min_median_traded_value
    )
    rvol_pass = rvol is not None and rvol >= config.min_rvol
    strong = rvol is not None and rvol >= config.strong_rvol
    overall_pass = all((
        w0_closed,
        weekly_change_pass,
        breakout_pass,
        median_volume_pass,
        median_traded_value_pass,
        rvol_pass,
    ))

    return {
        'evaluatedAt': now_ts,
        'w0Start': int(current.time),
        'w0End': int(current.bucket_end - 86400),
        'w0Closed': w0_closed,
        'closeW1': float(previous.close),
        'closeW0': float(current.close),
        'weeklyChangePct': weekly_change_pct,
        'weeklyChangePass': weekly_change_pass,
        'breakoutLevel': breakout_level,
        'breakoutPass': breakout_pass,
        'medianVolume': median_volume,
        'medianVolumePass': median_volume_pass,
        'medianTradedValue': median_traded_value,
        'medianTradedValuePass': median_traded_value_pass,
        'volumeW0': volume_w0,
        'rvol': rvol,
        'rvolPass': rvol_pass,
        'strong': strong,
        'overallPass': overall_pass,
        'baselineCloses': baseline_closes,
        'baselineVolumes': baseline_volumes,
        'baselineTradedValues': baseline_values,
        'thresholds': {
            'minMedianTradedValue': float(config.min_median_traded_value),
            'minMedianVolume': float(config.min_median_volume),
            'minWeeklyChangePct': float(config.min_weekly_change_pct),
            'minRvol': float(config.min_rvol),
            'strongRvol': float(config.strong_rvol),
        },
    }


def _signal_at(
    weeks: list[WeeklyBar],
    index: int,
    config: BreakoutVolumeScan,
) -> BreakoutVolumeResult | None:
    if index < 8:
        return None
    current = weeks[index]
    previous = weeks[index - 1]
    baseline = weeks[index - 8:index]

    if current.volume is None or current.traded_value is None:
        return None
    if any(item.volume is None or item.traded_value is None for item in baseline):
        return None

    baseline_volumes = [float(item.volume) for item in baseline if item.volume is not None]
    baseline_values = [float(item.traded_value) for item in baseline if item.traded_value is not None]
    median_volume = float(median(baseline_volumes))
    median_traded_value = float(median(baseline_values))
    if median_volume <= 0:
        return None
    if median_traded_value < config.min_median_traded_value:
        return None
    if median_volume < config.min_median_volume:
        return None

    breakout_level = max(item.close for item in baseline)
    if current.close <= breakout_level:
        return None
    if previous.close <= 0:
        return None
    weekly_change_pct = (current.close / previous.close - 1.0) * 100.0
    if weekly_change_pct < config.min_weekly_change_pct:
        return None
    rvol = float(current.volume) / median_volume
    if rvol < config.min_rvol:
        return None

    next_week = weeks[index + 1] if index + 1 < len(weeks) else None
    next_week_volume = None if next_week is None or next_week.volume is None else float(next_week.volume)
    next_week_rvol = None if next_week_volume is None else next_week_volume / median_volume
    next_week_close = None if next_week is None else float(next_week.close)
    next_week_holds = None if next_week_close is None else next_week_close >= breakout_level

    return BreakoutVolumeResult(
        signal_state='FOLLOW_UP' if next_week is not None else 'NEW',
        signal_time=current.time,
        close=float(current.close),
        volume=float(current.volume),
        weekly_change_pct=weekly_change_pct,
        rvol=rvol,
        breakout_level=float(breakout_level),
        traded_value=float(current.traded_value),
        median_traded_value=median_traded_value,
        median_volume=median_volume,
        strong=rvol >= config.strong_rvol,
        next_week_time=None if next_week is None else next_week.time,
        next_week_volume=next_week_volume,
        next_week_rvol=next_week_rvol,
        next_week_close=next_week_close,
        next_week_holds_breakout=next_week_holds,
    )


def evaluate_breakout_volume(
    daily: list[Candle],
    timezone_name: str,
    config: BreakoutVolumeScan,
    *,
    now: int | None = None,
) -> BreakoutVolumeResult | None:
    """Return a new closed-week breakout or one closed-week follow-up."""
    weeks = aggregate_closed_weeks(daily, timezone_name, now=now)
    if len(weeks) < 12:
        return None

    latest_index = len(weeks) - 1
    latest = _signal_at(weeks, latest_index, config)
    if latest is not None:
        return latest

    return _signal_at(weeks, latest_index - 1, config)
