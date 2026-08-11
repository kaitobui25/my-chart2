from __future__ import annotations

import asyncio
import io
import json
import math
import os
import threading
import time
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterable
from zoneinfo import ZoneInfo

from aiohttp import web

VIETNAM_TZ = ZoneInfo('Asia/Ho_Chi_Minh')
INDEX_SYMBOLS = {
    'VNINDEX', 'VN30', 'VN100', 'VNALLSHARE', 'VNMIDCAP', 'VNSML',
    'HNXINDEX', 'HNX30', 'UPCOMINDEX',
}
SUPPORTED_INTERVALS = {'1m', '5m', '15m', '1h', '4h', '1d', '1w', '1M'}
NATIVE_INTERVALS = {
    '1m': '1m',
    '5m': '5m',
    '15m': '15m',
    '1h': '1h',
    '1d': '1D',
}


def _read_simple_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            values[key] = value
            if key not in os.environ:
                os.environ[key] = value
    return values


VNSTOCK_ENV_PATH = Path(__file__).with_name('.env')
_read_simple_env(VNSTOCK_ENV_PATH)
HOST = os.getenv('HOST', '127.0.0.1').strip() or '127.0.0.1'
PORT = int(os.getenv('PORT', '8740'))
POLL_INTERVAL_SECONDS = max(300.0, float(os.getenv('POLL_INTERVAL_SECONDS', '300')))
SYMBOL_CACHE_SECONDS = max(60, int(os.getenv('SYMBOL_CACHE_SECONDS', '3600')))


def _load_vnstock_api_key(path: Path = VNSTOCK_ENV_PATH) -> bool:
    values = _read_simple_env(path)
    api_key = (values.get('VNSTOCK_API_KEY') or values.get('APIKEY') or '').strip()
    if not api_key:
        return bool(os.getenv('VNSTOCK_API_KEY', '').strip())
    os.environ['VNSTOCK_API_KEY'] = api_key
    return True


class VnstockQuotaError(RuntimeError):
    pass


def _call_vnstock(function: Any, *args: Any, **kwargs: Any) -> Any:
    try:
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            return function(*args, **kwargs)
    except SystemExit as exc:
        if 'rate limit exceeded' in str(exc).lower():
            raise VnstockQuotaError('Vnstock rate limit reached; retry later') from None
        raise


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
    name: str = ''
    exchange: str = ''


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _records(value: Any) -> list[dict[str, Any]]:
    if value is None:
        return []
    if hasattr(value, 'to_dict'):
        try:
            rows = value.to_dict('records')
            if isinstance(rows, list):
                return [row for row in rows if isinstance(row, dict)]
        except Exception:
            pass
    if isinstance(value, dict):
        keys = list(value.keys())
        if keys and all(isinstance(value[key], list) for key in keys):
            length = max((len(value[key]) for key in keys), default=0)
            return [
                {key: value[key][index] if index < len(value[key]) else None for key in keys}
                for index in range(length)
            ]
        return [value]
    if isinstance(value, (list, tuple)):
        return [item for item in value if isinstance(item, dict)]
    return []


def _lower_row(row: dict[str, Any]) -> dict[str, Any]:
    return {str(key).strip().lower(): value for key, value in row.items()}


def _first(row: dict[str, Any], names: Iterable[str]) -> Any:
    lowered = _lower_row(row)
    for name in names:
        key = name.lower()
        if key in lowered and lowered[key] is not None:
            return lowered[key]
    return None


def _timestamp(value: Any) -> int | None:
    if value is None:
        return None
    number = _finite(value)
    if number is not None and number >= 1_000_000_000:
        return int(number / 1000 if number > 1e12 else number)
    text = str(value).strip()
    if not text:
        return None
    try:
        # Pandas handles Timestamp/date/datetime and most Vnstock time strings.
        import pandas as pd
        parsed = pd.Timestamp(value)
        if parsed.tzinfo is None:
            parsed = parsed.tz_localize(VIETNAM_TZ)
        else:
            parsed = parsed.tz_convert(VIETNAM_TZ)
        return int(parsed.timestamp())
    except Exception:
        pass
    for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%Y-%m-%d', '%Y%m%d'):
        try:
            parsed_dt = datetime.strptime(text, fmt).replace(tzinfo=VIETNAM_TZ)
            return int(parsed_dt.timestamp())
        except ValueError:
            continue
    return None


def normalize_candle(row: dict[str, Any]) -> Candle | None:
    timestamp = _timestamp(_first(row, ('time', 'datetime', 'date', 'trading_date', 'tradingdate', 'timestamp')))
    open_ = _finite(_first(row, ('open', 'open_price', 'openprice')))
    high = _finite(_first(row, ('high', 'high_price', 'highprice')))
    low = _finite(_first(row, ('low', 'low_price', 'lowprice')))
    close = _finite(_first(row, ('close', 'close_price', 'closeprice', 'price', 'last_price', 'lastprice')))
    volume = _finite(_first(row, ('volume', 'total_volume', 'totalvolume', 'match_volume', 'matchvolume')))
    if timestamp is None or open_ is None or high is None or low is None or close is None:
        return None
    if min(open_, high, low, close) <= 0:
        return None
    if high < max(open_, low, close) or low > min(open_, high, close):
        return None
    if volume is not None and volume < 0:
        volume = None
    return Candle(timestamp, open_, high, low, close, volume)


def _aggregate_group(group: list[Candle]) -> Candle:
    return Candle(
        time=group[0].time,
        open=group[0].open,
        high=max(item.high for item in group),
        low=min(item.low for item in group),
        close=group[-1].close,
        volume=sum(item.volume or 0 for item in group),
    )


def aggregate_candles(candles: list[Candle], interval: str) -> list[Candle]:
    ordered = sorted(candles, key=lambda item: item.time)
    if interval not in {'4h', '1w', '1M'}:
        return ordered
    grouped: dict[tuple[int, ...], list[Candle]] = {}
    if interval == '4h':
        # Vietnamese equities have a lunch break. Group consecutive 1h bars per
        # trading day instead of flooring wall-clock time into artificial buckets.
        per_day: dict[tuple[int, int, int], list[Candle]] = {}
        for candle in ordered:
            dt = datetime.fromtimestamp(candle.time, VIETNAM_TZ)
            per_day.setdefault((dt.year, dt.month, dt.day), []).append(candle)
        result: list[Candle] = []
        for day in sorted(per_day):
            bars = sorted(per_day[day], key=lambda item: item.time)
            for index in range(0, len(bars), 4):
                result.append(_aggregate_group(bars[index:index + 4]))
        return result
    for candle in ordered:
        dt = datetime.fromtimestamp(candle.time, VIETNAM_TZ)
        if interval == '1w':
            iso = dt.isocalendar()
            key = (iso.year, iso.week)
        else:
            key = (dt.year, dt.month)
        grouped.setdefault(key, []).append(candle)
    return [_aggregate_group(grouped[key]) for key in sorted(grouped)]


def _normalize_symbol(raw: str) -> str:
    return ''.join(ch for ch in raw.strip().upper() if ch.isalnum())


def _normalize_exchange(value: Any) -> str:
    text = str(value or '').strip().upper()
    aliases = {
        'HSX': 'HOSE',
        'HOSE': 'HOSE',
        'HNX': 'HNX',
        'UPCOM': 'UPCOM',
        'UPCO': 'UPCOM',
    }
    return aliases.get(text, text)


class VnstockGateway:
    def __init__(self) -> None:
        self._market: Any | None = None
        self._reference: Any | None = None
        self._lock = threading.RLock()
        self._symbols: list[SymbolItem] = []
        self._symbols_at = 0.0

    @staticmethod
    def _load_classes() -> tuple[Any, Any]:
        try:
            from vnstock.ui import Market
        except ImportError:
            from vnstock import Market
        from vnstock import Reference
        return Market, Reference

    def _ensure_clients(self) -> tuple[Any, Any]:
        with self._lock:
            _load_vnstock_api_key()
            if self._market is None or self._reference is None:
                Market, Reference = self._load_classes()
                self._market = Market()
                self._reference = Reference()
            return self._market, self._reference

    def health(self) -> dict[str, Any]:
        # Health checks must never consume upstream Vnstock/API quota. The
        # launcher polls this endpoint while waiting for the local sidecar, so
        # constructing Market/Reference here can create a retry storm when the
        # guest rate limit is already exhausted. Data clients stay fully lazy.
        try:
            from importlib.util import find_spec
            configured = find_spec('vnstock') is not None
        except Exception:
            configured = False
        return {
            'ok': True,
            'configured': configured,
            'provider': 'Vnstock',
            'routing': 'Unified UI (KBS/VCI auto)',
            'timezone': 'Asia/Ho_Chi_Minh',
            'pollIntervalSeconds': POLL_INTERVAL_SECONDS,
            **({} if configured else {'warning': 'vnstock package is not installed'}),
        }

    def symbols(self, query: str, limit: int) -> list[SymbolItem]:
        now = time.time()
        with self._lock:
            if not self._symbols or now - self._symbols_at > SYMBOL_CACHE_SECONDS:
                _, reference = self._ensure_clients()
                rows = _records(_call_vnstock(lambda: reference.equity.list()))
                items: dict[str, SymbolItem] = {}
                for row in rows:
                    symbol = _normalize_symbol(str(_first(row, ('symbol', 'ticker', 'code')) or ''))
                    if not symbol:
                        continue
                    name = str(_first(row, ('organ_name', 'organname', 'name', 'company_name', 'companyname')) or '').strip()
                    exchange = _normalize_exchange(_first(row, ('exchange', 'comgroupcode', 'board', 'market')))
                    items[symbol] = SymbolItem(symbol, name, exchange)
                self._symbols = sorted(items.values(), key=lambda item: item.symbol)
                self._symbols_at = now
            needle = query.strip().upper()
            if not needle:
                return self._symbols[:limit]
            ranked: list[tuple[int, SymbolItem]] = []
            for item in self._symbols:
                name_upper = item.name.upper()
                if item.symbol == needle:
                    rank = 0
                elif item.symbol.startswith(needle):
                    rank = 1
                elif needle in item.symbol:
                    rank = 2
                elif name_upper.startswith(needle):
                    rank = 3
                elif needle in name_upper:
                    rank = 4
                else:
                    continue
                ranked.append((rank, item))
            ranked.sort(key=lambda pair: (pair[0], pair[1].symbol))
            return [item for _, item in ranked[:limit]]

    @staticmethod
    def _native_interval(interval: str) -> tuple[str, str]:
        if interval == '4h':
            return '1h', '4h'
        if interval in {'1w', '1M'}:
            return '1D', interval
        native = NATIVE_INTERVALS.get(interval)
        if native is None:
            raise ValueError(f'unsupported interval: {interval}')
        return native, interval

    @staticmethod
    def _asset(market: Any, symbol: str) -> Any:
        if symbol.upper() in INDEX_SYMBOLS:
            return market.index(symbol.upper())
        return market.equity(symbol.upper())

    def history(
        self,
        symbol: str,
        interval: str,
        limit: int,
        from_time: int | None = None,
        to_time: int | None = None,
    ) -> list[Candle]:
        symbol = _normalize_symbol(symbol)
        if not symbol:
            return []
        if interval not in SUPPORTED_INTERVALS:
            raise ValueError(f'unsupported interval: {interval}')
        native_interval, output_interval = self._native_interval(interval)
        market, _ = self._ensure_clients()

        kwargs: dict[str, Any] = {'interval': native_interval}
        if from_time is not None or to_time is not None:
            now = datetime.now(VIETNAM_TZ)
            start_dt = datetime.fromtimestamp(from_time or int((now - timedelta(days=30)).timestamp()), VIETNAM_TZ)
            end_dt = datetime.fromtimestamp(to_time or int(now.timestamp()), VIETNAM_TZ)
            if output_interval == '4h':
                start_dt -= timedelta(days=1)
            elif output_interval == '1w':
                start_dt -= timedelta(days=8)
            elif output_interval == '1M':
                start_dt -= timedelta(days=35)
            kwargs['start'] = start_dt.strftime('%Y-%m-%d')
            kwargs['end'] = (end_dt + timedelta(days=1)).strftime('%Y-%m-%d')
        else:
            native_limit = limit
            if output_interval == '4h':
                native_limit = max(limit * 4, 20)
            elif output_interval == '1w':
                native_limit = max(limit * 7, 30)
            elif output_interval == '1M':
                native_limit = max(limit * 31, 90)
            kwargs['count'] = min(max(native_limit, 2), 50_000)

        with self._lock:
            asset = _call_vnstock(self._asset, market, symbol)
            try:
                raw = _call_vnstock(asset.ohlcv, **kwargs)
            except TypeError:
                # Compatibility with adapters using length instead of count.
                if 'count' in kwargs:
                    kwargs['length'] = kwargs.pop('count')
                raw = _call_vnstock(asset.ohlcv, **kwargs)
        candles = [item for row in _records(raw) if (item := normalize_candle(row)) is not None]
        candles = aggregate_candles(candles, output_interval)
        if from_time is not None:
            candles = [item for item in candles if item.time >= from_time]
        if to_time is not None:
            candles = [item for item in candles if item.time <= to_time]
        return candles[-limit:]

    def latest(self, symbols: list[str], interval: str) -> dict[str, Candle]:
        symbols = [_normalize_symbol(symbol) for symbol in symbols]
        symbols = [symbol for symbol in dict.fromkeys(symbols) if symbol]
        if not symbols:
            return {}
        result: dict[str, Candle] = {}
        for symbol in symbols:
            try:
                candles = self.history(symbol, interval, 2)
                if candles:
                    result[symbol] = candles[-1]
            except VnstockQuotaError:
                raise
            except Exception:
                continue
        return result


GATEWAY = VnstockGateway()


def _json(payload: Any, status: int = 200) -> web.Response:
    return web.Response(
        status=status,
        text=json.dumps(payload, ensure_ascii=False, separators=(',', ':')),
        content_type='application/json',
    )


async def health_handler(_: web.Request) -> web.Response:
    payload = await asyncio.to_thread(GATEWAY.health)
    return _json(payload, 200 if payload.get('ok') else 503)


async def symbols_handler(request: web.Request) -> web.Response:
    query = request.query.get('q', '')
    limit = min(100, max(1, int(request.query.get('limit', '20'))))
    try:
        items = await asyncio.to_thread(GATEWAY.symbols, query, limit)
        return _json({'symbols': [asdict(item) for item in items]})
    except VnstockQuotaError as exc:
        return _json({'message': str(exc)}, 429)
    except Exception as exc:
        return _json({'message': str(exc)}, 502)


async def history_handler(request: web.Request) -> web.Response:
    symbol = request.query.get('symbol', '')
    interval = request.query.get('interval', '1d')
    limit = min(50_000, max(1, int(request.query.get('limit', '500'))))
    from_time = int(request.query['from']) if request.query.get('from') else None
    to_time = int(request.query['to']) if request.query.get('to') else None
    try:
        candles = await asyncio.to_thread(GATEWAY.history, symbol, interval, limit, from_time, to_time)
        return _json({
            'symbol': _normalize_symbol(symbol),
            'interval': interval,
            'source': 'vnstock-unified',
            'candles': [asdict(item) for item in candles],
        })
    except VnstockQuotaError as exc:
        return _json({'message': str(exc)}, 429)
    except ValueError as exc:
        return _json({'message': str(exc)}, 400)
    except Exception as exc:
        return _json({'message': str(exc)}, 502)


async def latest_handler(request: web.Request) -> web.Response:
    symbols = request.query.get('symbols', '').split(',')
    interval = request.query.get('interval', '1d')
    if interval not in SUPPORTED_INTERVALS:
        return _json({'message': f'unsupported interval: {interval}'}, 400)
    try:
        latest = await asyncio.to_thread(GATEWAY.latest, symbols, interval)
        return _json({
            'interval': interval,
            'source': 'vnstock-unified',
            'candles': {symbol: asdict(candle) for symbol, candle in latest.items()},
        })
    except VnstockQuotaError as exc:
        return _json({'message': str(exc)}, 429)
    except Exception as exc:
        return _json({'message': str(exc)}, 502)


def create_app() -> web.Application:
    app = web.Application(client_max_size=1024 * 1024)
    app.router.add_get('/health', health_handler)
    app.router.add_get('/symbols', symbols_handler)
    app.router.add_get('/history', history_handler)
    app.router.add_get('/latest', latest_handler)
    return app


if __name__ == '__main__':
    print(f'[vnstock] sidecar listening on http://{HOST}:{PORT}')
    web.run_app(create_app(), host=HOST, port=PORT, print=None)
