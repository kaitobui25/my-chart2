from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from models import Candle, CandleKind, Timeframe

HA_ALGO_VERSION = 1


@dataclass(frozen=True)
class AggregatedCandle(Candle):
    bucket_end: int = 0


@dataclass(frozen=True)
class HeikinCandle:
    time: int
    raw_open: float
    raw_high: float
    raw_low: float
    raw_close: float
    ha_open: float
    ha_high: float
    ha_low: float
    ha_close: float
    bucket_end: int


@dataclass(frozen=True)
class HeikinMetrics:
    timeframe: Timeframe
    kind: CandleKind
    candle_time: int
    ha_open: float
    ha_high: float
    ha_low: float
    ha_close: float
    green: bool
    no_lower_wick: bool
    ha_close_change_pct: float | None
    ha_body_pct: float | None
    source_last_time: int


def _local_bucket_start(timestamp: int, timeframe: Timeframe, tz: ZoneInfo) -> datetime:
    local = datetime.fromtimestamp(timestamp, tz)
    if timeframe == '1w':
        return (local - timedelta(days=local.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    return local.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def _next_bucket(start: datetime, timeframe: Timeframe) -> datetime:
    if timeframe == '1w':
        return start + timedelta(days=7)
    if start.month == 12:
        return start.replace(year=start.year + 1, month=1)
    return start.replace(month=start.month + 1)


def aggregate_daily(candles: list[Candle], timeframe: Timeframe, timezone_name: str) -> list[AggregatedCandle]:
    if timeframe not in {'1w', '1M'}:
        raise ValueError(f'unsupported HA timeframe: {timeframe}')
    tz = ZoneInfo(timezone_name)
    ordered = sorted(candles, key=lambda item: item.time)
    result: list[AggregatedCandle] = []
    current_key: int | None = None

    for candle in ordered:
        start = _local_bucket_start(candle.time, timeframe, tz)
        key = int(start.timestamp())
        end = int(_next_bucket(start, timeframe).timestamp())
        if current_key != key:
            result.append(AggregatedCandle(
                time=key,
                open=candle.open,
                high=candle.high,
                low=candle.low,
                close=candle.close,
                volume=candle.volume,
                is_closed=candle.is_closed,
                bucket_end=end,
            ))
            current_key = key
            continue
        previous = result[-1]
        volume = None if previous.volume is None and candle.volume is None else float(previous.volume or 0) + float(candle.volume or 0)
        result[-1] = AggregatedCandle(
            time=previous.time,
            open=previous.open,
            high=max(previous.high, candle.high),
            low=min(previous.low, candle.low),
            close=candle.close,
            volume=volume,
            is_closed=previous.is_closed and candle.is_closed,
            bucket_end=previous.bucket_end,
        )
    return result


def to_heikin(candles: list[AggregatedCandle]) -> list[HeikinCandle]:
    output: list[HeikinCandle] = []
    for index, candle in enumerate(candles):
        ha_close = (candle.open + candle.high + candle.low + candle.close) / 4.0
        if index == 0:
            ha_open = (candle.open + candle.close) / 2.0
        else:
            previous = output[-1]
            ha_open = (previous.ha_open + previous.ha_close) / 2.0
        ha_high = max(candle.high, ha_open, ha_close)
        ha_low = min(candle.low, ha_open, ha_close)
        output.append(HeikinCandle(
            time=candle.time,
            raw_open=candle.open,
            raw_high=candle.high,
            raw_low=candle.low,
            raw_close=candle.close,
            ha_open=ha_open,
            ha_high=ha_high,
            ha_low=ha_low,
            ha_close=ha_close,
            bucket_end=candle.bucket_end,
        ))
    return output


def _metrics_for_index(series: list[HeikinCandle], index: int, timeframe: Timeframe, kind: CandleKind, source_last_time: int) -> HeikinMetrics:
    candle = series[index]
    previous = series[index - 1] if index > 0 else None
    change = None
    if previous is not None and previous.ha_close != 0:
        change = (candle.ha_close / previous.ha_close - 1.0) * 100.0
    body = None if candle.ha_open == 0 else (candle.ha_close - candle.ha_open) / candle.ha_open * 100.0
    tolerance = max(abs(candle.ha_open) * 1e-9, 1e-10)
    return HeikinMetrics(
        timeframe=timeframe,
        kind=kind,
        candle_time=candle.time,
        ha_open=candle.ha_open,
        ha_high=candle.ha_high,
        ha_low=candle.ha_low,
        ha_close=candle.ha_close,
        green=candle.ha_close > candle.ha_open,
        no_lower_wick=candle.raw_low >= candle.ha_open - tolerance,
        ha_close_change_pct=change,
        ha_body_pct=body,
        source_last_time=source_last_time,
    )


def compute_latest_metrics(daily: list[Candle], timeframe: Timeframe, timezone_name: str, now: int | None = None) -> dict[CandleKind, HeikinMetrics]:
    if len(daily) < 3:
        return {}
    now_ts = int(datetime.now(timezone.utc).timestamp()) if now is None else int(now)
    aggregated = aggregate_daily(daily, timeframe, timezone_name)
    series = to_heikin(aggregated)
    if len(series) < 2:
        return {}
    source_last_time = max(item.time for item in daily)
    metrics: dict[CandleKind, HeikinMetrics] = {
        'current': _metrics_for_index(series, len(series) - 1, timeframe, 'current', source_last_time),
    }
    closed_indexes = [index for index, candle in enumerate(series) if candle.bucket_end <= now_ts]
    if closed_indexes:
        index = closed_indexes[-1]
        metrics['closed'] = _metrics_for_index(series, index, timeframe, 'closed', source_last_time)
    return metrics
