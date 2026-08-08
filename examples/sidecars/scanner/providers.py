from __future__ import annotations

import asyncio
import math
import time
from abc import ABC, abstractmethod
from collections import defaultdict
from datetime import datetime
from typing import Any, Iterable
from zoneinfo import ZoneInfo

import aiohttp

from models import Candle, Instrument, MarketSnapshot, ProviderCapabilities, ProviderId


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _chunks(values: list[str], size: int) -> Iterable[list[str]]:
    for index in range(0, len(values), size):
        yield values[index:index + size]


class ScannerProvider(ABC):
    capabilities: ProviderCapabilities

    @abstractmethod
    async def list_instruments(self, universes: tuple[str, ...]) -> list[Instrument]: ...

    @abstractmethod
    async def snapshots(self, symbols: list[str]) -> list[MarketSnapshot]: ...

    @abstractmethod
    async def daily_history(self, symbols: list[str], limit: int, since_time: int | None = None) -> dict[str, list[Candle]]: ...

    async def close(self) -> None:
        return None


class FiinQuantProvider(ScannerProvider):
    def __init__(self, username: str, password: str, batch_size: int = 50) -> None:
        self.username = username.strip()
        self.password = password
        self.batch_size = max(1, min(batch_size, 100))
        self._client = None
        self._client_lock = asyncio.Lock()
        self._request_lock = asyncio.Lock()
        self.capabilities = ProviderCapabilities(
            id='fiinquant', label='FiinQuant', market_cap=False, bulk_snapshot=True, bulk_history=True,
            universes=('HOSE', 'HNX', 'UPCOM'), default_universes=('HOSE', 'HNX', 'UPCOM'),
            timezone='Asia/Ho_Chi_Minh', max_history_concurrency=1, snapshot_ttl_seconds=60, history_ttl_seconds=120,
            available=bool(self.username and self.password),
            detail=None if self.username and self.password else 'FIINQUANT_USERNAME/PASSWORD are not configured',
        )

    async def _ensure_client(self):
        if self._client is not None:
            return self._client
        async with self._client_lock:
            if self._client is None:
                if not self.username or not self.password:
                    raise RuntimeError('FiinQuant scanner credentials are not configured')
                self._client = await asyncio.to_thread(self._login_sync)
        return self._client

    def _login_sync(self):
        from FiinQuantX import FiinSession
        return FiinSession(username=self.username, password=self.password).login()

    @staticmethod
    def _raw_records(raw: Any) -> list[dict[str, Any]]:
        if hasattr(raw, 'to_dict'):
            try:
                value = raw.to_dict('records')
                if isinstance(value, list):
                    return [item for item in value if isinstance(item, dict)]
            except TypeError:
                pass
        if hasattr(raw, 'to_dataFrame'):
            try:
                return FiinQuantProvider._raw_records(raw.to_dataFrame())
            except Exception:
                return []
        if isinstance(raw, dict):
            return [raw]
        if isinstance(raw, (list, tuple, set)):
            records = []
            for value in raw:
                if isinstance(value, dict):
                    records.append(value)
                else:
                    symbol = str(value).strip().upper()
                    if symbol:
                        records.append({'ticker': symbol})
            return records
        return []

    @staticmethod
    def _symbol_from_row(row: dict[str, Any]) -> str:
        for key in ('ticker', 'Ticker', 'symbol', 'Symbol', 'code', 'organCode'):
            value = str(row.get(key) or '').strip().upper()
            if value:
                return value
        return ''

    @staticmethod
    def _timestamp_from_row(row: dict[str, Any]) -> int | None:
        raw = row.get('timestamp') or row.get('Timestamp') or row.get('time') or row.get('TradingDate')
        if raw is None:
            return None
        number = _finite(raw)
        if number is not None and number >= 1_000_000_000:
            return int(number / 1000 if number > 1e12 else number)
        text = str(raw).strip().replace('Z', '+00:00')
        if not text:
            return None
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            parsed = None
            for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%Y-%m-%d', '%d/%m/%Y'):
                try:
                    parsed = datetime.strptime(text, fmt)
                    break
                except ValueError:
                    continue
        if parsed is None:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=ZoneInfo('Asia/Ho_Chi_Minh'))
        return int(parsed.timestamp())

    async def list_instruments(self, universes: tuple[str, ...]) -> list[Instrument]:
        client = await self._ensure_client()
        requested = universes or self.capabilities.default_universes

        def fetch() -> list[Instrument]:
            items: dict[str, Instrument] = {}
            for universe in requested:
                try:
                    raw = client.TickerList(ticker=universe)
                except TypeError:
                    raw = client.TickerList(tickers=[universe])
                for row in self._raw_records(raw):
                    symbol = self._symbol_from_row(row)
                    if not symbol:
                        continue
                    name = next((str(row.get(key) or '').strip() for key in ('name', 'organName', 'companyName', 'tickerName') if row.get(key)), '')
                    exchange = next((str(row.get(key) or '').strip().upper() for key in ('exchange', 'comGroupCode', 'market', 'floor') if row.get(key)), universe)
                    items[symbol] = Instrument('fiinquant', symbol, name, exchange or universe, 'STOCK', True)
            return sorted(items.values(), key=lambda item: item.symbol)

        async with self._request_lock:
            return await asyncio.to_thread(fetch)

    def _fetch_batch_sync(self, client: Any, symbols: list[str], period: int, fields: list[str], since_time: int | None = None) -> list[dict[str, Any]]:
        kwargs: dict[str, Any] = {'realtime': False, 'tickers': symbols, 'fields': fields, 'adjusted': True, 'by': '1d', 'lasted': True}
        if since_time is None:
            kwargs['period'] = period
        else:
            kwargs['from_date'] = datetime.fromtimestamp(since_time, ZoneInfo('Asia/Ho_Chi_Minh')).strftime('%Y-%m-%d')
            kwargs['to_date'] = datetime.now(ZoneInfo('Asia/Ho_Chi_Minh')).strftime('%Y-%m-%d %H:%M')
        return self._raw_records(client.Fetch_Trading_Data(**kwargs).get_data())

    async def snapshots(self, symbols: list[str]) -> list[MarketSnapshot]:
        client = await self._ensure_client()
        result: dict[str, MarketSnapshot] = {}
        async with self._request_lock:
            for batch in _chunks(symbols, self.batch_size):
                rows = await asyncio.to_thread(self._fetch_batch_sync, client, batch, 1, ['close', 'volume'])
                for row in rows:
                    symbol = self._symbol_from_row(row)
                    if symbol:
                        result[symbol] = MarketSnapshot(symbol, _finite(row.get('close') if 'close' in row else row.get('Close')), _finite(row.get('volume') if 'volume' in row else row.get('Volume')), None, self._timestamp_from_row(row))
        return list(result.values())

    async def daily_history(self, symbols: list[str], limit: int, since_time: int | None = None) -> dict[str, list[Candle]]:
        client = await self._ensure_client()
        grouped: dict[str, list[Candle]] = defaultdict(list)
        async with self._request_lock:
            for batch in _chunks(symbols, self.batch_size):
                rows = await asyncio.to_thread(self._fetch_batch_sync, client, batch, limit, ['open', 'high', 'low', 'close', 'volume'], since_time)
                now = int(time.time())
                for row in rows:
                    symbol = self._symbol_from_row(row)
                    ts = self._timestamp_from_row(row)
                    open_price = _finite(row.get('open') if 'open' in row else row.get('Open'))
                    high = _finite(row.get('high') if 'high' in row else row.get('High'))
                    low = _finite(row.get('low') if 'low' in row else row.get('Low'))
                    close = _finite(row.get('close') if 'close' in row else row.get('Close'))
                    if not symbol or ts is None or None in (open_price, high, low, close):
                        continue
                    assert open_price is not None and high is not None and low is not None and close is not None
                    if min(open_price, high, low, close) <= 0 or high < max(open_price, low, close) or low > min(open_price, high, close):
                        continue
                    volume = _finite(row.get('volume') if 'volume' in row else row.get('Volume'))
                    local = datetime.fromtimestamp(ts, ZoneInfo('Asia/Ho_Chi_Minh'))
                    next_day = local.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() + 86400
                    grouped[symbol].append(Candle(ts, open_price, high, low, close, volume, next_day <= now))
        return {symbol: sorted(values, key=lambda item: item.time)[-limit:] for symbol, values in grouped.items()}


class BinanceProvider(ScannerProvider):
    def __init__(self, provider_id: ProviderId, session: aiohttp.ClientSession | None = None) -> None:
        if provider_id not in {'binance_spot', 'binance_usdm'}:
            raise ValueError('invalid Binance provider id')
        self.provider_id = provider_id
        self._owned_session = session is None
        self.session = session
        if provider_id == 'binance_spot':
            self.rest_base = 'https://data-api.binance.vision'; self.exchange_info_path = '/api/v3/exchangeInfo'; self.ticker_path = '/api/v3/ticker/24hr'; self.klines_path = '/api/v3/klines'; label = 'Binance Spot'; self.asset_type = 'SPOT'
        else:
            self.rest_base = 'https://fapi.binance.com'; self.exchange_info_path = '/fapi/v1/exchangeInfo'; self.ticker_path = '/fapi/v1/ticker/24hr'; self.klines_path = '/fapi/v1/klines'; label = 'Binance USD-M Futures'; self.asset_type = 'PERPETUAL'
        self.capabilities = ProviderCapabilities(id=provider_id, label=label, market_cap=False, bulk_snapshot=True, bulk_history=False, universes=('USDT',), default_universes=('USDT',), timezone='UTC', max_history_concurrency=8, snapshot_ttl_seconds=30, history_ttl_seconds=60)

    async def _get_session(self) -> aiohttp.ClientSession:
        if self.session is None:
            self.session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15))
        return self.session

    async def _json(self, path: str, params: dict[str, str] | None = None) -> Any:
        session = await self._get_session()
        async with session.get(f'{self.rest_base}{path}', params=params) as response:
            if response.status >= 400:
                raise RuntimeError(f'Binance HTTP {response.status}: {(await response.text())[:300]}')
            return await response.json()

    async def list_instruments(self, universes: tuple[str, ...]) -> list[Instrument]:
        payload = await self._json(self.exchange_info_path)
        allowed_quotes = set(universes or self.capabilities.default_universes)
        result = []
        for row in payload.get('symbols', []) if isinstance(payload, dict) else []:
            if row.get('status') != 'TRADING': continue
            if self.provider_id == 'binance_spot' and row.get('isSpotTradingAllowed') is False: continue
            if self.provider_id == 'binance_usdm' and row.get('contractType') != 'PERPETUAL': continue
            quote = str(row.get('quoteAsset') or '').upper()
            if allowed_quotes and quote not in allowed_quotes: continue
            symbol = str(row.get('symbol') or '').upper()
            if not symbol: continue
            base = str(row.get('baseAsset') or '').upper()
            result.append(Instrument(self.provider_id, symbol, f'{base}/{quote}' if base and quote else symbol, 'BINANCE', f'{self.asset_type}:{quote}', True))
        return result

    async def snapshots(self, symbols: list[str]) -> list[MarketSnapshot]:
        wanted = set(symbols)
        payload = await self._json(self.ticker_path)
        rows = payload if isinstance(payload, list) else [payload]
        result = []
        for row in rows:
            symbol = str(row.get('symbol') or '').upper()
            if symbol in wanted:
                result.append(MarketSnapshot(symbol, _finite(row.get('lastPrice')), _finite(row.get('volume')), None, int((_finite(row.get('closeTime')) or time.time() * 1000) / 1000)))
        return result

    async def _history_one(self, symbol: str, limit: int, semaphore: asyncio.Semaphore, since_time: int | None = None) -> tuple[str, list[Candle]]:
        params = {'symbol': symbol, 'interval': '1d', 'limit': str(min(1000, limit))}
        if since_time is not None: params['startTime'] = str(max(0, int(since_time)) * 1000)
        async with semaphore: payload = await self._json(self.klines_path, params)
        now_ms = int(time.time() * 1000)
        candles = []
        if not isinstance(payload, list): return symbol, candles
        for row in payload:
            if not isinstance(row, list) or len(row) < 7: continue
            values = [_finite(row[index]) for index in (1, 2, 3, 4)]
            if any(value is None for value in values): continue
            open_price, high, low, close = (float(value) for value in values if value is not None)
            if min(open_price, high, low, close) <= 0: continue
            candles.append(Candle(int(float(row[0]) / 1000), open_price, high, low, close, _finite(row[5]), int(float(row[6])) < now_ms))
        return symbol, candles

    async def daily_history(self, symbols: list[str], limit: int, since_time: int | None = None) -> dict[str, list[Candle]]:
        semaphore = asyncio.Semaphore(self.capabilities.max_history_concurrency)
        pairs = await asyncio.gather(*(self._history_one(symbol, limit, semaphore, since_time) for symbol in symbols))
        return {symbol: candles for symbol, candles in pairs}

    async def close(self) -> None:
        if self._owned_session and self.session is not None:
            await self.session.close(); self.session = None


def build_providers(fiinquant_username: str, fiinquant_password: str) -> dict[ProviderId, ScannerProvider]:
    return {'fiinquant': FiinQuantProvider(fiinquant_username, fiinquant_password), 'binance_spot': BinanceProvider('binance_spot'), 'binance_usdm': BinanceProvider('binance_usdm')}
