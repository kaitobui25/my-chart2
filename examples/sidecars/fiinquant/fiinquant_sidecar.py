"""Optional FiinQuantX HTTP and WebSocket adapter for the L2Chart workstation.

The process owns one authenticated SDK session, caches OHLC history by symbol
and interval, and multiplexes realtime subscriptions across browser clients.
See README.md for installation and security boundaries.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import secrets
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from aiohttp import WSMsgType, web

VN_TZ = ZoneInfo("Asia/Ho_Chi_Minh")
BASE_DIR = Path(__file__).resolve().parent

INTERVAL_SECONDS = {
    "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
    "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400,
}
# Expired entries are returned immediately and refreshed in the background.
TTL_INTRADAY = 15.0
TTL_DAILY = 120.0
STREAM_AUTH_TIMEOUT_SECONDS = 5.0


def load_env() -> None:
    env_path = BASE_DIR / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


class FiinQuantGateway:
    """Own one FiinQuantX login and run blocking SDK calls in an executor."""

    def __init__(self, username: str, password: str) -> None:
        self.username = username
        self.password = password
        self._client = None
        self._lock = threading.Lock()
        # Limit concurrent history calls so background loads cannot starve the
        # active chart while sharing one SDK session.
        self._history_slots = threading.BoundedSemaphore(2)
        self._symbols_cache: list[dict] | None = None

    @property
    def logged_in(self) -> bool:
        return self._client is not None

    def _ensure_client(self):
        with self._lock:
            if self._client is None:
                from FiinQuantX import FiinSession

                self._client = FiinSession(
                    username=self.username, password=self.password
                ).login()
            return self._client

    def fetch_history(self, symbol: str, interval: str, limit: int,
                      from_time: int | None = None,
                      to_time: int | None = None) -> list[dict]:
        client = self._ensure_client()
        requested_from = from_time
        requested_to = to_time
        use_rolling_range = (
            from_time is None and to_time is None and interval != "1d"
        )
        if use_rolling_range:
            # period=N can stop at the previous completed trading day. A
            # rolling range includes the current session in one HTTP request.
            now = datetime.now(VN_TZ)
            bars_per_session = (4.5 * 60 * 60) / INTERVAL_SECONDS[interval]
            estimated_sessions = limit / max(bars_per_session, 1)
            span_days = max(7, math.ceil(estimated_sessions * 1.75) + 4)
            requested_from = int((now - timedelta(days=span_days)).timestamp())
            requested_to = int(now.timestamp())

        candles_by_time: dict[int, dict] = {}
        data = self._request_history(
            client, symbol, interval, limit, requested_from, requested_to
        )
        for candle in self._history_candles(data):
            candles_by_time[candle["time"]] = candle

        # Holidays or suspended symbols can leave the estimated range short.
        # Fall back to period=N only then and merge without duplicate times.
        if use_rolling_range and len(candles_by_time) < limit:
            data = self._request_history(
                client, symbol, interval, limit, None, None
            )
            for candle in self._history_candles(data):
                candles_by_time[candle["time"]] = candle
        return sorted(candles_by_time.values(), key=lambda c: c["time"])[-limit:]

    def _request_history(self, client, symbol: str, interval: str, limit: int,
                         from_time: int | None,
                         to_time: int | None):
        history_args = {
            "realtime": False,
            "tickers": [symbol],
            "fields": ["open", "high", "low", "close", "volume"],
            "adjusted": True,
            "by": interval,
            "lasted": True,
        }
        if from_time is not None and to_time is not None:
            history_args["from_date"] = datetime.fromtimestamp(
                from_time, VN_TZ
            ).strftime("%Y-%m-%d %H:%M")
            history_args["to_date"] = datetime.fromtimestamp(
                to_time, VN_TZ
            ).strftime("%Y-%m-%d %H:%M")
        else:
            history_args["period"] = limit
        with self._history_slots:
            request = client.Fetch_Trading_Data(**history_args)
            # Historical Fetch_Trading_Data is an HTTP request in FiinQuantX.
            # stop() belongs to realtime=True streams and is not required here.
            return request.get_data()

    @staticmethod
    def _history_candles(data) -> list[dict]:
        candles = []
        for row in data.to_dict("records"):
            ts = str(row.get("timestamp", ""))
            dt = None
            for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
                try:
                    dt = datetime.strptime(ts, fmt).replace(tzinfo=VN_TZ)
                    break
                except ValueError:
                    continue
            if dt is None:
                continue
            try:
                open_price = float(row["open"])
                high_price = float(row["high"])
                low_price = float(row["low"])
                close_price = float(row["close"])
                volume = float(row.get("volume") or 0)
            except (KeyError, TypeError, ValueError):
                continue
            prices = (open_price, high_price, low_price, close_price)
            if (not all(math.isfinite(value) and value > 0 for value in prices)
                    or high_price < max(open_price, close_price, low_price)
                    or low_price > min(open_price, close_price, high_price)):
                continue
            if not math.isfinite(volume) or volume < 0:
                volume = 0.0
            candles.append(
                {
                    "time": int(dt.timestamp()),
                    "open": open_price,
                    "high": high_price,
                    "low": low_price,
                    "close": close_price,
                    "volume": volume,
                }
            )
        return candles

    def fetch_symbols(self) -> list[dict]:
        if self._symbols_cache is not None:
            return self._symbols_cache
        client = self._ensure_client()
        with self._history_slots:
            # TickerList is a metadata/HTTP helper on the existing login session.
            # It does not create a Trading_Data_Stream WebSocket.
            raw = client.TickerList(
                tickers=["HOSE", "HNX", "UPCOM", "FU", "INDEX"]
            )
            for method_name in ("get_data", "to_dataFrame"):
                method = getattr(raw, method_name, None)
                if callable(method):
                    raw = method()
                    break
            if hasattr(raw, "data"):
                raw = raw.data
        records = self._symbol_records(raw)
        self._symbols_cache = sorted(
            {item["symbol"]: item for item in records}.values(),
            key=lambda item: item["symbol"],
        )
        return self._symbols_cache

    @classmethod
    def _symbol_records(cls, raw) -> list[dict]:
        if hasattr(raw, "to_dict"):
            try:
                raw = raw.to_dict("records")
            except TypeError:
                raw = raw.to_dict()
        if isinstance(raw, str):
            symbol = raw.strip().upper()
            return [{"symbol": symbol}] if symbol else []
        if isinstance(raw, (list, tuple, set)):
            return [item for value in raw for item in cls._symbol_records(value)]
        if not isinstance(raw, dict):
            return []
        symbol = next((str(raw[key]).strip().upper() for key in
                       ("symbol", "ticker", "Ticker", "code", "organCode")
                       if raw.get(key)), "")
        if symbol:
            name = next((str(raw[key]).strip() for key in
                         ("name", "organName", "companyName", "tickerName")
                         if raw.get(key)), "")
            exchange = next((str(raw[key]).strip() for key in
                             ("exchange", "comGroupCode", "market", "floor")
                             if raw.get(key)), "")
            return [{"symbol": symbol, "name": name, "exchange": exchange}]
        return [item for value in raw.values() for item in cls._symbol_records(value)]

    def make_stream(self, tickers: list[str], callback):
        client = self._ensure_client()
        stream = client.Trading_Data_Stream(tickers=tickers, callback=callback)
        self._disable_sdk_reconnect(stream)
        return stream

    @staticmethod
    def _disable_sdk_reconnect(stream) -> None:
        """Let TickHub own retries; FiinQuantX currently starts two retry loops."""
        try:
            from signalrcore.hub_connection_builder import HubConnectionBuilder
        except ImportError:
            return

        def build_connection():
            return HubConnectionBuilder().with_url(stream.url, options={
                "access_token_factory": lambda: stream.access_token()
            }).build()

        original_disconnect = stream._on_disconnect

        def on_disconnect() -> None:
            original_disconnect()
            stream._stop_event.set()

        # FiinQuantX 0.1.64 combines signalrcore automatic reconnect with its
        # own reconnect loop. A disconnect can therefore multiply sockets and
        # threads. TickHub performs one bounded retry instead.
        stream._build_connection = build_connection
        stream._handle_disconnect = lambda: None
        stream._on_disconnect = on_disconnect


class HistoryCache:
    """Stale-while-revalidate candle cache keyed by symbol and interval."""

    def __init__(self, gateway: FiinQuantGateway) -> None:
        self.gateway = gateway
        self._store: dict[tuple[str, str], tuple[list[dict], float, int]] = {}
        self._inflight: set[tuple[str, str]] = set()
        self._locks: dict[tuple[str, str], asyncio.Lock] = {}

    def peek_last(self, symbol: str, interval: str) -> dict | None:
        entry = self._store.get((symbol, interval))
        return entry[0][-1] if entry and entry[0] else None

    async def get(self, symbol: str, interval: str, limit: int,
                  from_time: int | None = None,
                  to_time: int | None = None) -> tuple[list[dict], bool]:
        if from_time is not None and to_time is not None:
            candles = await asyncio.get_running_loop().run_in_executor(
                None, self.gateway.fetch_history, symbol, interval, limit,
                from_time, to_time
            )
            return candles, False
        key = (symbol, interval)
        ttl = TTL_DAILY if interval == "1d" else TTL_INTRADAY
        entry = self._store.get(key)
        if entry is not None:
            candles, fetched_at, coverage = entry
            if coverage >= limit:
                if time.monotonic() - fetched_at > ttl:
                    self._spawn_refresh(symbol, interval, max(limit, coverage))
                return candles[-limit:], True
        candles = await self._fetch(symbol, interval, limit)
        return candles, False

    def _spawn_refresh(self, symbol: str, interval: str, limit: int) -> None:
        key = (symbol, interval)
        if key in self._inflight:
            return
        self._inflight.add(key)

        async def refresh() -> None:
            try:
                await self._fetch(symbol, interval, limit, force=True)
            except Exception:
                pass
            finally:
                self._inflight.discard(key)

        asyncio.get_running_loop().create_task(refresh())

    async def _fetch(self, symbol: str, interval: str, limit: int,
                     force: bool = False) -> list[dict]:
        key = (symbol, interval)
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            entry = self._store.get(key)
            if not force and entry is not None and entry[2] >= limit:
                return entry[0][-limit:]
            if force and entry is not None:
                limit = max(limit, entry[2])
            loop = asyncio.get_running_loop()
            candles = await loop.run_in_executor(
                None, self.gateway.fetch_history, symbol, interval, limit
            )
            self._store[key] = (candles, time.monotonic(), limit)
            return candles


class TickHub:
    """Share one upstream stream across clients and restart on symbol changes."""

    def __init__(self, gateway: FiinQuantGateway, cache: HistoryCache) -> None:
        self.gateway = gateway
        self.cache = cache
        self.loop: asyncio.AbstractEventLoop | None = None
        self.clients: dict[web.WebSocketResponse, set[tuple[str, str]]] = {}
        self.bars: dict[tuple[str, str], dict] = {}
        self._stream = None
        self._stream_thread: threading.Thread | None = None
        self._stream_symbols: frozenset[str] = frozenset()
        self._restart_pending = False
        self._restart_handle: asyncio.TimerHandle | None = None
        self._closed = False
        self._sync_lock = asyncio.Lock()
        self._stream_started_at: float | None = None
        self._last_tick_received_at: float | None = None
        self._last_market_tick_at: float | None = None
        self._last_tick_symbol: str | None = None
        self._last_stream_error: str | None = None

    def register(self, ws: web.WebSocketResponse,
                 subscriptions: set[tuple[str, str]] | None = None) -> None:
        self.clients[ws] = subscriptions or set()
        self._schedule_stream_sync()

    def set_subscriptions(self, ws: web.WebSocketResponse,
                          subscriptions: set[tuple[str, str]]) -> None:
        if ws not in self.clients:
            return
        self.clients[ws] = subscriptions
        self._schedule_stream_sync()

    def unregister(self, ws: web.WebSocketResponse) -> None:
        self.clients.pop(ws, None)
        self._schedule_stream_sync()

    def _schedule_stream_sync(self, delay: float = 0.5) -> None:
        if self._closed or self._restart_pending or self.loop is None:
            return
        self._restart_pending = True
        # One upstream stream is restarted at most once for a burst of changes.
        self._restart_handle = self.loop.call_later(
            delay, lambda: asyncio.ensure_future(self._sync_stream())
        )

    async def _sync_stream(self) -> None:
        self._restart_pending = False
        self._restart_handle = None
        async with self._sync_lock:
            if self._closed:
                return
            wanted = self._wanted_symbols()
            if wanted == self._stream_symbols:
                return
            loop = asyncio.get_running_loop()
            old = self._stream
            old_thread = self._stream_thread
            old_symbols = self._stream_symbols
            self._stream = None
            self._stream_thread = None
            self._stream_symbols = frozenset()
            if old is not None:
                stopped = await loop.run_in_executor(
                    None, self._stop_and_join, old, old_thread
                )
                if not stopped:
                    # Never overlap upstream streams. Retry the requested
                    # subscription set after the SDK's old thread exits.
                    self._stream = old
                    self._stream_thread = old_thread
                    self._stream_symbols = old_symbols
                    self._schedule_stream_sync()
                    return
            if not wanted:
                return

            def on_tick(data) -> None:
                row = self._tick_row(data)
                if row is None:
                    self._last_stream_error = "FiinQuant returned an unreadable realtime tick"
                    return
                if self.loop is not None:
                    self.loop.call_soon_threadsafe(self._handle_tick, row)

            stream = await loop.run_in_executor(
                None, self.gateway.make_stream, sorted(wanted), on_tick
            )
            if self._closed or wanted != self._wanted_symbols():
                await loop.run_in_executor(None, self._safe_stop, stream)
                self._schedule_stream_sync()
                return
            self._stream = stream
            self._stream_symbols = wanted
            try:
                # FiinQuantX start() creates its own thread and returns
                # immediately. Do not wrap it in another short-lived thread or
                # TickHub will interpret every successful start as a disconnect.
                await loop.run_in_executor(None, stream.start)
            except Exception as exc:
                self._last_stream_error = str(exc)[:300]
                self._stream = None
                self._stream_symbols = frozenset()
                await loop.run_in_executor(None, self._safe_stop, stream)
                self._schedule_stream_sync(5.0)
                return
            self._stream_started_at = time.time()
            self._last_stream_error = None
            stream_thread = getattr(stream, "thread", None)
            self._stream_thread = (
                stream_thread if isinstance(stream_thread, threading.Thread) else None
            )
            if self._stream_thread is not None:
                monitor = threading.Thread(
                    target=self._watch_stream,
                    args=(stream, self._stream_thread),
                    daemon=True,
                )
                monitor.start()

    def _wanted_symbols(self) -> frozenset[str]:
        return frozenset(
            symbol
            for subscriptions in self.clients.values()
            for symbol, _ in subscriptions
        )

    def _stream_ended(self, stream) -> None:
        if self._stream is not stream or self._closed:
            return
        self._last_stream_error = "FiinQuant realtime stream ended"
        self._stream = None
        self._stream_thread = None
        self._stream_symbols = frozenset()
        self._schedule_stream_sync(5.0)

    def _watch_stream(self, stream, thread: threading.Thread) -> None:
        thread.join()
        if self.loop is not None:
            self.loop.call_soon_threadsafe(self._stream_ended, stream)

    async def close(self) -> None:
        self._closed = True
        if self._restart_handle is not None:
            self._restart_handle.cancel()
            self._restart_handle = None
        self._restart_pending = False
        clients = list(self.clients)
        self.clients.clear()
        for ws in clients:
            try:
                await ws.close(code=1001, message=b"FiinQuant session replaced")
            except Exception:
                pass
        async with self._sync_lock:
            old = self._stream
            old_thread = self._stream_thread
            self._stream = None
            self._stream_thread = None
            self._stream_symbols = frozenset()
            if old is not None:
                await asyncio.get_running_loop().run_in_executor(
                    None, self._stop_and_join, old, old_thread
                )

    @staticmethod
    def _stop_and_join(stream, thread: threading.Thread | None) -> bool:
        TickHub._safe_stop(stream)
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=10)
            return not thread.is_alive()
        return True

    @staticmethod
    def _safe_stop(stream) -> None:
        stop_event = getattr(stream, "_stop_event", None)
        if stop_event is not None:
            stop_event.set()
        hub = getattr(stream, "hub_connection", None)
        transport = getattr(hub, "transport", None)
        checker = getattr(transport, "connection_checker", None)
        try:
            if checker is not None:
                checker.stop()
        except Exception:
            pass
        try:
            ws = getattr(transport, "_ws", None)
            if ws is not None:
                ws.close()
        except Exception:
            pass
        try:
            if hub is not None:
                hub.stop()
            elif stop_event is None:
                # Test doubles and older SDK objects without exposed lifecycle
                # primitives still get their public stop hook.
                stream.stop()
        except Exception:
            pass

    def _handle_tick(self, row: dict) -> None:
        symbol = str(row.get("Ticker") or "").upper()
        try:
            close = float(row.get("Close"))
        except (TypeError, ValueError):
            return
        tick_time = self._tick_time(row)
        if (not symbol or not math.isfinite(close) or close <= 0
                or tick_time is None):
            return
        self._last_tick_received_at = time.time()
        self._last_market_tick_at = tick_time
        self._last_tick_symbol = symbol
        try:
            match_volume = float(row.get("MatchVolume") or 0)
        except (TypeError, ValueError):
            match_volume = 0.0
        if not math.isfinite(match_volume) or match_volume < 0:
            match_volume = 0.0
        total_volume = row.get("TotalMatchVolume")

        targets = {
            subscription
            for subscriptions in self.clients.values()
            for subscription in subscriptions
            if subscription[0] == symbol
        }
        candles = {
            subscription: self._aggregate(
                symbol, subscription[1], close, match_volume,
                total_volume, tick_time
            )
            for subscription in targets
        }
        for ws, subscriptions in list(self.clients.items()):
            for subscription in subscriptions:
                candle = candles.get(subscription)
                if candle is not None:
                    asyncio.ensure_future(
                        self._send(ws, subscription[0], subscription[1], candle)
                    )

    async def _send(self, ws: web.WebSocketResponse, symbol: str,
                    interval: str, candle: dict) -> None:
        try:
            await ws.send_str(json.dumps({
                "type": "bar", "symbol": symbol,
                "interval": interval, "candle": candle,
            }))
        except Exception:
            self.unregister(ws)

    def _aggregate(self, symbol: str, interval: str, close: float, match_volume: float,
                   total_volume, tick_time: float) -> dict | None:
        step = INTERVAL_SECONDS.get(interval)
        if step is None:
            return None
        if interval == "1d":
            local = datetime.fromtimestamp(tick_time, VN_TZ)
            bucket = int(local.replace(hour=0, minute=0, second=0, microsecond=0).timestamp())
        else:
            bucket = int(tick_time // step) * step

        key = (symbol, interval)
        bar = self.bars.get(key)
        if bar is not None and bucket < bar["time"]:
            return None
        seed = self.cache.peek_last(symbol, interval)
        if bar is None or bar["time"] != bucket:
            if bar is None and seed is not None and seed["time"] == bucket:
                bar = dict(seed)  # Continue the open bar returned by history.
            else:
                bar = {"time": bucket, "open": close, "high": close,
                       "low": close, "close": close, "volume": 0.0}
            self.bars[key] = bar
        elif seed is not None and seed["time"] == bucket:
            bar = self._merge_seed_bar(seed, bar)
            self.bars[key] = bar
        bar["close"] = close
        bar["high"] = max(bar["high"], close)
        bar["low"] = min(bar["low"], close)
        if interval == "1d" and total_volume is not None:
            try:
                next_volume = float(total_volume)
            except (TypeError, ValueError):
                next_volume = float(bar.get("volume") or 0)
            if math.isfinite(next_volume) and next_volume >= 0:
                bar["volume"] = next_volume
        else:
            bar["volume"] = float(bar.get("volume") or 0) + match_volume
        return dict(bar)

    @staticmethod
    def _merge_seed_bar(seed: dict, bar: dict) -> dict:
        return {
            "time": seed["time"],
            "open": seed["open"],
            "high": max(seed["high"], bar["high"], bar["open"], bar["close"]),
            "low": min(seed["low"], bar["low"], bar["open"], bar["close"]),
            "close": bar["close"],
            "volume": max(float(seed.get("volume") or 0), float(bar.get("volume") or 0)),
        }

    @staticmethod
    def _tick_row(data) -> dict | None:
        to_dict = getattr(data, "to_dict", None)
        if callable(to_dict):
            try:
                row = to_dict()
                if isinstance(row, dict):
                    return row
            except Exception:
                pass
        to_frame = getattr(data, "to_dataFrame", None)
        if callable(to_frame):
            try:
                row = to_frame().iloc[0].to_dict()
                if isinstance(row, dict):
                    return row
            except Exception:
                pass
        return None

    @classmethod
    def _tick_time(cls, row: dict) -> float | None:
        trading_date = row.get("TradingDate")
        timestamp = row.get("Timestamp")

        # Some SDK messages provide Timestamp as a complete epoch/ISO value.
        epoch = cls._epoch_value(timestamp)
        if epoch is not None:
            return epoch
        timestamp_text = str(timestamp or "").strip()
        if any(separator in timestamp_text for separator in ("-", "/", "T")):
            parsed = cls._parse_datetime(timestamp_text)
            if parsed is not None:
                return parsed.timestamp()

        date_value = cls._parse_datetime(trading_date)
        if date_value is None:
            return cls._epoch_value(trading_date)

        # FiinQuant RealTimeData exposes TradingDate and Timestamp separately.
        # Combine them before bucketing intraday bars.
        if timestamp_text:
            normalized_time = timestamp_text.removesuffix("Z")
            for fmt in ("%H:%M:%S.%f", "%H:%M:%S", "%H:%M"):
                try:
                    parsed_time = datetime.strptime(normalized_time, fmt).time()
                    return datetime.combine(
                        date_value.date(), parsed_time, tzinfo=VN_TZ
                    ).timestamp()
                except ValueError:
                    continue
        return date_value.timestamp()

    @staticmethod
    def _epoch_value(raw) -> float | None:
        try:
            value = float(raw)
        except (TypeError, ValueError):
            return None
        if not math.isfinite(value) or value < 1_000_000_000:
            return None
        return value / 1000 if value > 1e12 else value

    @staticmethod
    def _parse_datetime(raw) -> datetime | None:
        if not isinstance(raw, str) or not raw.strip():
            return None
        text = raw.strip().replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(text)
            return parsed.replace(tzinfo=VN_TZ) if parsed.tzinfo is None else parsed
        except ValueError:
            pass
        for fmt in ("%d/%m/%Y %H:%M:%S", "%d/%m/%Y"):
            try:
                return datetime.strptime(text, fmt).replace(tzinfo=VN_TZ)
            except ValueError:
                continue
        return None

    def status(self) -> dict:
        subscriptions = {
            subscription
            for client_subscriptions in self.clients.values()
            for subscription in client_subscriptions
        }

        def iso(value: float | None) -> str | None:
            if value is None:
                return None
            return datetime.fromtimestamp(value, VN_TZ).isoformat(timespec="seconds")

        return {
            "browserClients": len(self.clients),
            "subscriptions": len(subscriptions),
            "requestedSymbols": sorted(self._wanted_symbols()),
            "upstreamActive": self._stream is not None,
            "streamStartedAt": iso(self._stream_started_at),
            "lastTickAt": iso(self._last_tick_received_at),
            "lastMarketTickAt": iso(self._last_market_tick_at),
            "lastTickSymbol": self._last_tick_symbol,
            "lastError": self._last_stream_error,
        }


LOOPBACK_ORIGIN_HOSTS = {"127.0.0.1", "::1", "localhost"}


def sidecar_token() -> str:
    return os.environ.get("SIDECAR_TOKEN", "").strip()


def allowed_origins() -> set[str]:
    raw = os.environ.get("SIDECAR_ALLOWED_ORIGINS", "").strip()
    return {item.strip().rstrip("/") for item in raw.split(",") if item.strip()}


def is_allowed_origin(origin: str | None) -> bool:
    if not origin:
        return True
    normalized = origin.rstrip("/")
    try:
        parsed = urlsplit(normalized)
        is_loopback = (
            parsed.scheme in {"http", "https"}
            and parsed.hostname in LOOPBACK_ORIGIN_HOSTS
            and parsed.username is None
            and parsed.password is None
        )
    except ValueError:
        is_loopback = False
    return is_loopback or normalized in allowed_origins()


def request_token(request: web.Request) -> str:
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    header = request.headers.get("X-L2Chart-Sidecar-Token", "")
    return header.strip()


def check_token_value(candidate: str) -> bool:
    expected = sidecar_token()
    if not expected:
        return False
    return secrets.compare_digest(candidate, expected)


def check_token(request: web.Request) -> bool:
    return check_token_value(request_token(request))


async def authenticate_stream(
    request: web.Request,
    ws: web.WebSocketResponse,
) -> bool:
    if not check_token(request):
        try:
            message = await asyncio.wait_for(
                ws.receive(), timeout=STREAM_AUTH_TIMEOUT_SECONDS
            )
        except TimeoutError:
            await ws.send_json({"type": "error", "code": "AUTH_TIMEOUT"})
            await ws.close(code=4403, message=b"authentication timeout")
            return False
        if message.type != WSMsgType.TEXT:
            await ws.send_json({"type": "error", "code": "INVALID_TOKEN"})
            await ws.close(code=4403, message=b"invalid sidecar token")
            return False
        try:
            payload = json.loads(message.data)
        except (json.JSONDecodeError, TypeError):
            payload = None
        candidate = payload.get("token") if isinstance(payload, dict) else None
        if (
            not isinstance(candidate, str)
            or payload.get("action") != "authenticate"
            or not check_token_value(candidate)
        ):
            await ws.send_json({"type": "error", "code": "INVALID_TOKEN"})
            await ws.close(code=4403, message=b"invalid sidecar token")
            return False
    await ws.send_json({"type": "authenticated"})
    return True


@web.middleware
async def cors_middleware(request: web.Request, handler):
    origin = request.headers.get("Origin")
    if not is_allowed_origin(origin):
        return web.json_response({"message": "origin not allowed"}, status=403)
    if request.method == "OPTIONS":
        response = web.Response()
    else:
        try:
            response = await handler(request)
        except web.HTTPException as exc:
            response = exc
    if origin:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
    response.headers["Access-Control-Allow-Headers"] = (
        "Authorization, Content-Type, X-L2Chart-Sidecar-Token"
    )
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response


def build_app(gateway: FiinQuantGateway | None) -> web.Application:
    cache = HistoryCache(gateway) if gateway else None
    hub = TickHub(gateway, cache) if gateway and cache else None
    runtime = {"gateway": gateway, "cache": cache, "hub": hub}
    app = web.Application(middlewares=[cors_middleware])

    async def on_startup(_app: web.Application) -> None:
        current_hub = runtime["hub"]
        if current_hub is not None:
            current_hub.loop = asyncio.get_running_loop()

    app.on_startup.append(on_startup)

    async def health(request: web.Request) -> web.Response:
        current_gateway = runtime["gateway"]
        current_hub = runtime["hub"]
        token_configured = bool(sidecar_token())
        authorized = check_token(request)
        return web.json_response(
            {"ok": True, "loggedIn": bool(current_gateway and current_gateway.logged_in),
             "configured": current_gateway is not None,
             "tokenConfigured": token_configured,
             "authorized": authorized,
             "stream": current_hub.status() if authorized and current_hub is not None else None}
        )

    async def session(request: web.Request) -> web.Response:
        if not check_token(request):
            return web.json_response({"message": "invalid sidecar token"}, status=401)
        try:
            payload = await request.json()
        except (json.JSONDecodeError, TypeError):
            return web.json_response({"message": "invalid JSON body"}, status=400)
        username = str(payload.get("username") or "").strip()
        password = str(payload.get("password") or "")
        if not username or not password:
            return web.json_response({"message": "username and password are required"}, status=400)
        next_gateway = FiinQuantGateway(username, password)
        try:
            await asyncio.get_running_loop().run_in_executor(None, next_gateway._ensure_client)
        except Exception as exc:  # noqa: BLE001
            return web.json_response({"message": str(exc)[:300]}, status=401)
        next_cache = HistoryCache(next_gateway)
        next_hub = TickHub(next_gateway, next_cache)
        next_hub.loop = asyncio.get_running_loop()
        old_hub = runtime["hub"]
        runtime.update(gateway=next_gateway, cache=next_cache, hub=next_hub)
        if old_hub is not None:
            await old_hub.close()
        return web.json_response({"ok": True, "loggedIn": True})

    async def history(request: web.Request) -> web.Response:
        if not check_token(request):
            return web.json_response({"message": "invalid sidecar token"}, status=401)
        current_cache = runtime["cache"]
        if current_cache is None:
            return web.json_response(
                {"message": "FIINQUANT_USERNAME/PASSWORD are not configured"},
                status=503,
            )
        symbol = request.query.get("symbol", "").strip().upper()
        interval = request.query.get("interval", "1m")
        limit = min(max(int(request.query.get("limit", "500")), 1), 20000)
        from_time = int(request.query["from"]) if request.query.get("from") else None
        to_time = int(request.query["to"]) if request.query.get("to") else None
        if not symbol:
            return web.json_response({"message": "symbol is required"}, status=400)
        if interval not in INTERVAL_SECONDS:
            return web.json_response({"message": f"unsupported interval: {interval}"}, status=400)
        try:
            candles, cached = await current_cache.get(
                symbol, interval, limit, from_time, to_time
            )
        except Exception as exc:  # noqa: BLE001
            return web.json_response({"message": str(exc)[:300]}, status=502)
        return web.json_response({"candles": candles, "cached": cached})

    async def symbols(request: web.Request) -> web.Response:
        if not check_token(request):
            return web.json_response({"message": "invalid sidecar token"}, status=401)
        current_gateway = runtime["gateway"]
        if current_gateway is None:
            return web.json_response({"message": "FiinQuant session is not configured"}, status=503)
        query = request.query.get("q", "").strip().upper()
        limit = min(max(int(request.query.get("limit", "20")), 1), 100)
        try:
            items = await asyncio.get_running_loop().run_in_executor(
                None, current_gateway.fetch_symbols
            )
        except Exception as exc:  # noqa: BLE001
            return web.json_response({"message": str(exc)[:300]}, status=502)
        matches = [item for item in items if not query or query in item["symbol"]]
        matches.sort(key=lambda item: (
            0 if item["symbol"] == query else
            1 if item["symbol"].startswith(query) else 2,
            item["symbol"],
        ))
        return web.json_response({"symbols": matches[:limit]})

    async def stream(request: web.Request) -> web.WebSocketResponse:
        current_hub = runtime["hub"]
        ws = web.WebSocketResponse(heartbeat=25)
        await ws.prepare(request)
        if not await authenticate_stream(request, ws):
            return ws
        if current_hub is None:
            await ws.send_json({"type": "error", "code": "SESSION_REQUIRED"})
            await ws.close(code=4401, message=b"FiinQuant login required")
            return ws
        symbol = request.query.get("symbol", "").strip().upper()
        interval = request.query.get("interval", "1m")
        initial = {(symbol, interval)} if symbol and interval in INTERVAL_SECONDS else set()
        current_hub.register(ws, initial)
        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    try:
                        payload = json.loads(msg.data)
                    except (json.JSONDecodeError, TypeError):
                        continue
                    if payload.get("action") != "subscribe":
                        continue
                    raw_subscriptions = payload.get("subscriptions")
                    if not isinstance(raw_subscriptions, list):
                        continue
                    subscriptions: set[tuple[str, str]] = set()
                    for item in raw_subscriptions[:100]:
                        if not isinstance(item, dict):
                            continue
                        next_symbol = str(item.get("symbol") or "").strip().upper()
                        next_interval = str(item.get("interval") or "")
                        if next_symbol and len(next_symbol) <= 32 \
                                and next_interval in INTERVAL_SECONDS:
                            subscriptions.add((next_symbol, next_interval))
                    current_hub.set_subscriptions(ws, subscriptions)
                if msg.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
                    break
        finally:
            current_hub.unregister(ws)
        return ws

    app.router.add_get("/health", health)
    app.router.add_post("/session", session)
    app.router.add_get("/history", history)
    app.router.add_get("/symbols", symbols)
    app.router.add_get("/stream", stream)
    return app


def main() -> None:
    load_env()
    username = os.environ.get("FIINQUANT_USERNAME", "")
    password = os.environ.get("FIINQUANT_PASSWORD", "")
    gateway = FiinQuantGateway(username, password) if username and password else None
    if gateway is None:
        print("[warning] FIINQUANT_USERNAME/PASSWORD are not configured; /history returns 503")
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8720"))
    print(f"FiinQuant sidecar listening on http://{host}:{port}")
    web.run_app(build_app(gateway), host=host, port=port, print=None)


if __name__ == "__main__":
    main()
