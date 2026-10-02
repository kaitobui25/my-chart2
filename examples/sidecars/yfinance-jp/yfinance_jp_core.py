from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Iterable
from zoneinfo import ZoneInfo


TOKYO_TZ = ZoneInfo("Asia/Tokyo")
POLL_INTERVAL_SECONDS = 60
SUPPORTED_INTERVALS = ("1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w", "1M")
YFINANCE_INTERVALS = {
    "1m": "1m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1h": "1h",
    "4h": "1h",
    "1d": "1d",
    "1w": "1wk",
    "1M": "1mo",
}
DEFAULT_HISTORY_PERIODS = {
    "1m": "5d",
    "5m": "1mo",
    "15m": "1mo",
    "30m": "1mo",
    "1h": "1mo",
    "4h": "1mo",
    "1d": "max",
    "1w": "max",
    "1M": "max",
}
LATEST_PERIODS = {
    "1m": "5d",
    "5m": "5d",
    "15m": "5d",
    "30m": "5d",
    "1h": "5d",
    "4h": "5d",
    "1d": "1mo",
    "1w": "3mo",
    "1M": "1y",
}
JP_CODE_LETTERS = "ACDFGHJKLMNPRSTUWXY"
JP_CODE_RE = re.compile(
    rf"^(?:\d{{4}}|\d{{3}}[{JP_CODE_LETTERS}]|\d[{JP_CODE_LETTERS}]\d{{2}})$"
)
SCANNER_PAGE_SIZE = 250
SCANNER_HISTORY_BATCH_SIZE = 250
SCANNER_HISTORY_THREADS = 8


@dataclass(slots=True)
class Candle:
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float | None = None


@dataclass(slots=True)
class SymbolItem:
    symbol: str
    name: str = ""
    exchange: str = "JPX"


@dataclass(slots=True)
class ScannerInstrument:
    symbol: str
    name: str
    exchange: str
    assetType: str
    price: float | None
    volume: float | None
    marketCap: float | None
    dataTime: int | None


def normalize_symbol(raw: str) -> str:
    value = str(raw or "").strip().upper()
    if value.endswith(".T"):
        value = value[:-2]
    if not JP_CODE_RE.fullmatch(value):
        raise ValueError("Japan stock symbol must be a 4-character TSE code, optionally ending in .T")
    return f"{value}.T"


def try_normalize_symbol(raw: str) -> str | None:
    try:
        return normalize_symbol(raw)
    except ValueError:
        return None


def native_interval(interval: str) -> str:
    try:
        return YFINANCE_INTERVALS[interval]
    except KeyError as exc:
        raise ValueError(f"unsupported interval: {interval}") from exc


def session_metadata(now: datetime | None = None) -> dict[str, Any]:
    local_now = (now or datetime.now(TOKYO_TZ)).astimezone(TOKYO_TZ)
    minute = local_now.hour * 60 + local_now.minute
    weekday = local_now.weekday() < 5
    morning_open = 9 * 60
    morning_close = 11 * 60 + 30
    afternoon_open = 12 * 60 + 30
    afternoon_close = 15 * 60 + 30

    if weekday and (morning_open <= minute < morning_close or afternoon_open <= minute < afternoon_close):
        state = "open"
    elif weekday and morning_close <= minute < afternoon_open:
        state = "lunch_break"
    else:
        state = "closed"

    return {
        "timezone": "Asia/Tokyo",
        "localTime": local_now.isoformat(),
        "sessionDate": local_now.date().isoformat(),
        "state": state,
        "isRegularSession": state == "open",
        "weekday": weekday,
        "holidayAware": False,
        "regularSessions": [
            {"open": "09:00", "close": "11:30"},
            {"open": "12:30", "close": "15:30"},
        ],
    }


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _timestamp(value: Any) -> int | None:
    if value is None:
        return None
    try:
        import pandas as pd

        parsed = pd.Timestamp(value)
        if parsed.tzinfo is None:
            parsed = parsed.tz_localize(TOKYO_TZ)
        else:
            parsed = parsed.tz_convert(TOKYO_TZ)
        return int(parsed.timestamp())
    except Exception:
        return None


def frame_to_candles(frame: Any) -> list[Candle]:
    if frame is None or getattr(frame, "empty", True):
        return []

    candles: list[Candle] = []
    for index, row in frame.iterrows():
        timestamp = _timestamp(index)
        open_ = _finite(row.get("Open"))
        high = _finite(row.get("High"))
        low = _finite(row.get("Low"))
        close = _finite(row.get("Close"))
        volume = _finite(row.get("Volume"))
        if timestamp is None or None in (open_, high, low, close):
            continue
        assert open_ is not None and high is not None and low is not None and close is not None
        if min(open_, high, low, close) <= 0:
            continue
        if high < max(open_, low, close) or low > min(open_, high, close):
            continue
        if volume is not None and volume < 0:
            volume = None
        candles.append(Candle(timestamp, open_, high, low, close, volume))
    return sorted(candles, key=lambda item: item.time)


def daily_candle_is_closed(timestamp: int, now: datetime | None = None) -> bool:
    local_now = (now or datetime.now(TOKYO_TZ)).astimezone(TOKYO_TZ)
    candle_day = datetime.fromtimestamp(timestamp, TOKYO_TZ).date()
    if candle_day < local_now.date():
        return True
    if candle_day > local_now.date():
        return False
    return (local_now.hour, local_now.minute) >= (15, 30)


def _aggregate_group(group: list[Candle]) -> Candle:
    return Candle(
        time=group[0].time,
        open=group[0].open,
        high=max(item.high for item in group),
        low=min(item.low for item in group),
        close=group[-1].close,
        volume=sum(item.volume or 0 for item in group),
    )


def aggregate_four_hour(candles: Iterable[Candle]) -> list[Candle]:
    per_day: dict[tuple[int, int, int], list[Candle]] = {}
    for candle in sorted(candles, key=lambda item: item.time):
        local = datetime.fromtimestamp(candle.time, TOKYO_TZ)
        per_day.setdefault((local.year, local.month, local.day), []).append(candle)

    result: list[Candle] = []
    for day in sorted(per_day):
        bars = per_day[day]
        for index in range(0, len(bars), 4):
            result.append(_aggregate_group(bars[index:index + 4]))
    return result


class YFinanceJapanGateway:
    def __init__(self, yf_module: Any | None = None) -> None:
        self._yf = yf_module

    def _yfinance(self) -> Any:
        if self._yf is None:
            import yfinance as yf

            self._yf = yf
        return self._yf

    def health(self) -> dict[str, Any]:
        try:
            from importlib.util import find_spec

            configured = self._yf is not None or find_spec("yfinance") is not None
        except Exception:
            configured = self._yf is not None
        return {
            "ok": True,
            "configured": configured,
            "provider": "yfinance",
            "source": "Yahoo Finance",
            "exchange": "Tokyo Stock Exchange",
            "timezone": "Asia/Tokyo",
            "pollIntervalSeconds": POLL_INTERVAL_SECONDS,
            "supportedIntervals": list(SUPPORTED_INTERVALS),
            "adjustedDefault": False,
            "session": session_metadata(),
            **({} if configured else {"warning": "yfinance package is not installed"}),
        }

    def symbols(self, query: str, limit: int) -> list[SymbolItem]:
        query = str(query or "").strip()
        if not query:
            return []
        limit = max(1, limit)
        direct = try_normalize_symbol(query)
        items: dict[str, SymbolItem] = {}

        try:
            yf = self._yfinance()
            search = yf.Search(query, max_results=limit, news_count=0, raise_errors=True)
            for quote in getattr(search, "quotes", []) or []:
                if not isinstance(quote, dict):
                    continue
                raw_symbol = str(quote.get("symbol") or "")
                if not raw_symbol.upper().endswith(".T"):
                    continue
                symbol = try_normalize_symbol(raw_symbol)
                if symbol is None:
                    continue
                name = str(quote.get("longname") or quote.get("shortname") or "").strip()
                exchange = str(quote.get("exchange") or quote.get("exchDisp") or "JPX").strip() or "JPX"
                items[symbol] = SymbolItem(symbol=symbol, name=name, exchange=exchange)
        except Exception:
            if direct is None:
                raise

        if direct is not None and direct not in items:
            items[direct] = SymbolItem(symbol=direct)

        needle = direct or query.upper()
        ordered = sorted(
            items.values(),
            key=lambda item: (0 if item.symbol == needle else 1, item.symbol),
        )
        return ordered[:limit]

    def scanner_universe(self, page_size: int = SCANNER_PAGE_SIZE) -> list[ScannerInstrument]:
        page_size = min(SCANNER_PAGE_SIZE, max(1, int(page_size)))
        yf = self._yfinance()
        query = yf.EquityQuery("eq", ["region", "jp"])
        offset = 0
        total: int | None = None
        items: dict[str, ScannerInstrument] = {}

        while total is None or offset < total:
            payload = yf.screen(
                query,
                offset=offset,
                size=page_size,
                sortField="ticker",
                sortAsc=True,
            )
            if not isinstance(payload, dict):
                raise RuntimeError("yfinance screen returned an invalid response")
            quotes = payload.get("quotes") or []
            if not isinstance(quotes, list):
                raise RuntimeError("yfinance screen returned an invalid quotes payload")
            if total is None:
                try:
                    total = max(0, int(payload.get("total", len(quotes))))
                except (TypeError, ValueError):
                    total = len(quotes)

            for quote in quotes:
                if not isinstance(quote, dict):
                    continue
                if str(quote.get("quoteType") or "EQUITY").upper() != "EQUITY":
                    continue
                symbol = try_normalize_symbol(str(quote.get("symbol") or ""))
                if symbol is None:
                    continue
                name = str(
                    quote.get("longName")
                    or quote.get("shortName")
                    or quote.get("longname")
                    or quote.get("shortname")
                    or ""
                ).strip()
                exchange = str(quote.get("exchange") or "JPX").strip().upper() or "JPX"
                data_time = _finite(quote.get("regularMarketTime"))
                items[symbol] = ScannerInstrument(
                    symbol=symbol,
                    name=name,
                    exchange=exchange,
                    assetType="EQUITY",
                    price=_finite(quote.get("regularMarketPrice")),
                    volume=_finite(quote.get("regularMarketVolume")),
                    marketCap=_finite(quote.get("marketCap")),
                    dataTime=None if data_time is None else int(data_time),
                )

            if not quotes:
                break
            offset += len(quotes)

        return sorted(items.values(), key=lambda item: item.symbol)

    @staticmethod
    def _history_kwargs(
        interval: str,
        adjusted: bool,
        from_time: int | None,
        to_time: int | None,
    ) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "interval": native_interval(interval),
            "auto_adjust": adjusted,
            "actions": False,
            "prepost": False,
            "repair": False,
            "raise_errors": True,
        }
        if from_time is None and to_time is None:
            kwargs["period"] = DEFAULT_HISTORY_PERIODS[interval]
            return kwargs

        if from_time is not None:
            kwargs["start"] = datetime.fromtimestamp(from_time, TOKYO_TZ)
        if to_time is not None:
            # yfinance's end is exclusive. One second keeps a candle exactly at
            # the requested endpoint eligible without imposing a lookback cap.
            kwargs["end"] = datetime.fromtimestamp(to_time, TOKYO_TZ) + timedelta(seconds=1)
        return kwargs

    def history(
        self,
        symbol: str,
        interval: str,
        limit: int,
        from_time: int | None = None,
        to_time: int | None = None,
        adjusted: bool = False,
    ) -> list[Candle]:
        normalized = normalize_symbol(symbol)
        if interval not in SUPPORTED_INTERVALS:
            raise ValueError(f"unsupported interval: {interval}")
        if limit < 1:
            raise ValueError("limit must be at least 1")

        ticker = self._yfinance().Ticker(normalized)
        frame = ticker.history(**self._history_kwargs(interval, adjusted, from_time, to_time))
        candles = frame_to_candles(frame)
        if interval == "4h":
            candles = aggregate_four_hour(candles)
        if from_time is not None:
            candles = [item for item in candles if item.time >= from_time]
        if to_time is not None:
            candles = [item for item in candles if item.time <= to_time]
        return candles[-limit:]

    @staticmethod
    def _daily_history_start(limit: int, since_time: int | None) -> datetime:
        if since_time is not None:
            return datetime.fromtimestamp(max(0, int(since_time)), TOKYO_TZ)
        calendar_days = max(30, math.ceil(limit * 365 / 235) + 14)
        return datetime.now(TOKYO_TZ) - timedelta(days=calendar_days)

    @staticmethod
    def _download_symbol_frame(frame: Any, symbol: str, single_symbol: bool) -> Any:
        if frame is None or getattr(frame, "empty", True):
            return None
        columns = getattr(frame, "columns", None)
        if getattr(columns, "nlevels", 1) > 1:
            try:
                if symbol in set(columns.get_level_values(0)):
                    return frame[symbol]
                if symbol in set(columns.get_level_values(1)):
                    return frame.xs(symbol, axis=1, level=1)
            except Exception:
                return None
            return None
        return frame if single_symbol else None

    def daily_history(
        self,
        symbols: Iterable[str],
        limit: int,
        since_time: int | None = None,
    ) -> dict[str, list[Candle]]:
        if limit < 1:
            raise ValueError("limit must be at least 1")

        normalized: list[str] = []
        seen: set[str] = set()
        for raw_symbol in symbols:
            symbol = try_normalize_symbol(raw_symbol)
            if symbol is None or symbol in seen:
                continue
            seen.add(symbol)
            normalized.append(symbol)
        if not normalized:
            return {}

        yf = self._yfinance()
        start = self._daily_history_start(limit, since_time)
        output: dict[str, list[Candle]] = {symbol: [] for symbol in normalized}

        for batch_start in range(0, len(normalized), SCANNER_HISTORY_BATCH_SIZE):
            batch = normalized[batch_start:batch_start + SCANNER_HISTORY_BATCH_SIZE]
            frame = yf.download(
                batch,
                start=start,
                interval="1d",
                group_by="ticker",
                auto_adjust=False,
                actions=False,
                threads=min(SCANNER_HISTORY_THREADS, len(batch)),
                progress=False,
                prepost=False,
                repair=False,
                keepna=False,
                multi_level_index=True,
            )
            for symbol in batch:
                symbol_frame = self._download_symbol_frame(frame, symbol, len(batch) == 1)
                candles = frame_to_candles(symbol_frame)
                if since_time is not None:
                    candles = [item for item in candles if item.time >= since_time]
                output[symbol] = candles[-limit:]

        return output

    def latest(self, symbols: Iterable[str], interval: str, adjusted: bool = False) -> dict[str, Candle]:
        if interval not in SUPPORTED_INTERVALS:
            raise ValueError(f"unsupported interval: {interval}")
        yf = self._yfinance()
        output: dict[str, Candle] = {}
        seen: set[str] = set()
        for raw_symbol in symbols:
            symbol = try_normalize_symbol(raw_symbol)
            if symbol is None or symbol in seen:
                continue
            seen.add(symbol)
            try:
                frame = yf.Ticker(symbol).history(
                    period=LATEST_PERIODS[interval],
                    interval=native_interval(interval),
                    auto_adjust=adjusted,
                    actions=False,
                    prepost=False,
                    repair=False,
                    raise_errors=True,
                )
                candles = frame_to_candles(frame)
                if interval == "4h":
                    candles = aggregate_four_hour(candles)
                if candles:
                    output[symbol] = candles[-1]
            except Exception:
                continue
        return output
