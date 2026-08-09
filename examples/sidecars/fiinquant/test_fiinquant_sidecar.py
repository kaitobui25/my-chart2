from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from aiohttp import WSMsgType
from aiohttp.test_utils import AioHTTPTestCase

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fiinquant_sidecar import (
    FiinQuantGateway,
    HistoryCache,
    TickHub,
    authenticate_stream,
    build_app,
    check_token,
    is_allowed_origin,
)


def candles(count: int) -> list[dict]:
    return [
        {
            "time": 1_700_000_000 + index * 60,
            "open": 10.0,
            "high": 11.0,
            "low": 9.0,
            "close": 10.5,
            "volume": 100.0,
        }
        for index in range(count)
    ]


class FakeGateway:
    def __init__(self) -> None:
        self.history_calls: list[tuple[str, str, int, int | None, int | None]] = []
        self.stream_count = 0
        self.max_stream_count = 0
        self.stream_lock = threading.Lock()

    def fetch_history(self, symbol: str, interval: str, limit: int,
                      from_time: int | None = None,
                      to_time: int | None = None) -> list[dict]:
        self.history_calls.append((symbol, interval, limit, from_time, to_time))
        return candles(limit)

    def make_stream(self, _tickers: list[str], _callback):
        return FakeStream(self)


class FakeHistoryFrame:
    def to_dict(self, orient: str) -> list[dict]:
        if orient != "records":
            raise ValueError(orient)
        return [{
            "timestamp": "2026-07-18 10:00:00",
            "open": 10,
            "high": 11,
            "low": 9,
            "close": 10.5,
            "volume": 100,
        }]


class FakeHistoryRequest:
    def get_data(self) -> FakeHistoryFrame:
        return FakeHistoryFrame()


class FakeFiinClient:
    def __init__(self) -> None:
        self.request = FakeHistoryRequest()
        self.history_args: dict | None = None
        self.history_calls: list[dict] = []

    def Fetch_Trading_Data(self, **kwargs) -> FakeHistoryRequest:
        self.history_args = kwargs
        self.history_calls.append(kwargs)
        return self.request


class FakeStream:
    def __init__(self, gateway: FakeGateway) -> None:
        self.gateway = gateway
        self.stopped = threading.Event()
        self.ended = threading.Event()
        self.thread: threading.Thread | None = None

    def start(self) -> None:
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self) -> None:
        with self.gateway.stream_lock:
            self.gateway.stream_count += 1
            self.gateway.max_stream_count = max(
                self.gateway.max_stream_count, self.gateway.stream_count
            )
        self.stopped.wait(1)
        with self.gateway.stream_lock:
            self.gateway.stream_count -= 1
        self.ended.set()

    def stop(self) -> None:
        self.stopped.set()
        self.ended.wait(1)


class FakeWebSocket:
    def __init__(self, incoming: dict | str | None = None) -> None:
        self.messages: list[dict] = []
        self.incoming = incoming
        self.close_code: int | None = None

    async def send_str(self, payload: str) -> None:
        self.messages.append(json.loads(payload))

    async def send_json(self, payload: dict) -> None:
        self.messages.append(payload)

    async def receive(self):
        payload = self.incoming
        data = payload if isinstance(payload, str) else json.dumps(payload)
        return SimpleNamespace(type=WSMsgType.TEXT, data=data)

    async def close(self, *, code: int, message: bytes) -> None:
        del message
        self.close_code = code


class FakeRequest:
    def __init__(self, headers: dict[str, str] | None = None,
                 query: dict[str, str] | None = None) -> None:
        self.headers = headers or {}
        self.query = query or {}


class SecurityConfigTests(unittest.TestCase):
    def test_sidecar_token_is_required(self) -> None:
        old = os.environ.get("SIDECAR_TOKEN")
        try:
            os.environ.pop("SIDECAR_TOKEN", None)

            self.assertFalse(check_token(FakeRequest()))  # type: ignore[arg-type]
        finally:
            if old is None:
                os.environ.pop("SIDECAR_TOKEN", None)
            else:
                os.environ["SIDECAR_TOKEN"] = old

    def test_sidecar_token_accepts_bearer_or_header(self) -> None:
        old = os.environ.get("SIDECAR_TOKEN")
        try:
            os.environ["SIDECAR_TOKEN"] = "secret-token"

            self.assertTrue(check_token(FakeRequest(  # type: ignore[arg-type]
                headers={"Authorization": "Bearer secret-token"},
            )))
            self.assertTrue(check_token(FakeRequest(  # type: ignore[arg-type]
                headers={"X-L2Chart-Sidecar-Token": "secret-token"},
            )))
            self.assertFalse(check_token(FakeRequest(  # type: ignore[arg-type]
                headers={"X-L2Chart-Sidecar-Token": "wrong"},
            )))
            self.assertFalse(check_token(FakeRequest(  # type: ignore[arg-type]
                query={"token": "secret-token"},
            )))
            self.assertTrue(check_token(FakeRequest(  # type: ignore[arg-type]
                headers={"X-L2Chart-Sidecar-Token": "secret-token"},
            )))
        finally:
            if old is None:
                os.environ.pop("SIDECAR_TOKEN", None)
            else:
                os.environ["SIDECAR_TOKEN"] = old

    def test_cors_defaults_to_local_workstation_origins(self) -> None:
        old = os.environ.get("SIDECAR_ALLOWED_ORIGINS")
        try:
            os.environ.pop("SIDECAR_ALLOWED_ORIGINS", None)

            self.assertTrue(is_allowed_origin("http://127.0.0.1:5173"))
            self.assertTrue(is_allowed_origin("http://localhost:62000"))
            self.assertTrue(is_allowed_origin("http://[::1]:53175"))
            self.assertFalse(is_allowed_origin("https://example.com"))

            os.environ["SIDECAR_ALLOWED_ORIGINS"] = "http://100.97.188.57:53175"
            self.assertTrue(is_allowed_origin("http://100.97.188.57:53175"))
            self.assertFalse(is_allowed_origin("http://100.97.188.57:53173"))
        finally:
            if old is None:
                os.environ.pop("SIDECAR_ALLOWED_ORIGINS", None)
            else:
                os.environ["SIDECAR_ALLOWED_ORIGINS"] = old


class StreamAuthenticationTests(unittest.IsolatedAsyncioTestCase):
    async def test_authenticates_with_first_websocket_message(self) -> None:
        old = os.environ.get("SIDECAR_TOKEN")
        try:
            os.environ["SIDECAR_TOKEN"] = "secret-token"
            socket = FakeWebSocket({
                "action": "authenticate",
                "token": "secret-token",
            })

            authenticated = await authenticate_stream(
                FakeRequest(), socket  # type: ignore[arg-type]
            )

            self.assertTrue(authenticated)
            self.assertEqual([{"type": "authenticated"}], socket.messages)
            self.assertIsNone(socket.close_code)
        finally:
            if old is None:
                os.environ.pop("SIDECAR_TOKEN", None)
            else:
                os.environ["SIDECAR_TOKEN"] = old

    async def test_rejects_subscription_before_authentication(self) -> None:
        old = os.environ.get("SIDECAR_TOKEN")
        try:
            os.environ["SIDECAR_TOKEN"] = "secret-token"
            socket = FakeWebSocket({"action": "subscribe", "subscriptions": []})

            authenticated = await authenticate_stream(
                FakeRequest(), socket  # type: ignore[arg-type]
            )

            self.assertFalse(authenticated)
            self.assertEqual("INVALID_TOKEN", socket.messages[0]["code"])
            self.assertEqual(4403, socket.close_code)
        finally:
            if old is None:
                os.environ.pop("SIDECAR_TOKEN", None)
            else:
                os.environ["SIDECAR_TOKEN"] = old


class StreamEndpointTests(AioHTTPTestCase):
    async def asyncSetUp(self) -> None:
        self.old_token = os.environ.get("SIDECAR_TOKEN")
        os.environ["SIDECAR_TOKEN"] = "secret-token"
        await super().asyncSetUp()

    async def asyncTearDown(self) -> None:
        await super().asyncTearDown()
        if self.old_token is None:
            os.environ.pop("SIDECAR_TOKEN", None)
        else:
            os.environ["SIDECAR_TOKEN"] = self.old_token

    async def get_application(self):
        return build_app(None)

    async def test_accepts_first_message_authentication(self) -> None:
        socket = await self.client.ws_connect("/stream")
        await socket.send_json({
            "action": "authenticate",
            "token": "secret-token",
        })

        self.assertEqual(
            {"type": "authenticated"},
            await socket.receive_json(),
        )
        self.assertEqual(
            {"type": "error", "code": "SESSION_REQUIRED"},
            await socket.receive_json(),
        )

    async def test_query_token_does_not_authenticate_stream(self) -> None:
        socket = await self.client.ws_connect("/stream?token=secret-token")
        await socket.send_json({"action": "subscribe", "subscriptions": []})

        self.assertEqual(
            {"type": "error", "code": "INVALID_TOKEN"},
            await socket.receive_json(),
        )

    async def test_health_reports_dependency_versions(self) -> None:
        response = await self.client.get("/health")
        payload = await response.json()

        self.assertEqual(
            {"fiinquantx", "signalrcore", "msgpack"},
            set(payload["dependencies"]),
        )


class HistoryCacheTests(unittest.IsolatedAsyncioTestCase):
    async def test_small_cache_does_not_satisfy_larger_history_request(self) -> None:
        gateway = FakeGateway()
        cache = HistoryCache(gateway)

        first, first_cached = await cache.get("SSI", "1m", 2)
        expanded, expanded_cached = await cache.get("SSI", "1m", 500)

        self.assertEqual(2, len(first))
        self.assertFalse(first_cached)
        self.assertEqual(500, len(expanded))
        self.assertFalse(expanded_cached)
        self.assertEqual([2, 500], [call[2] for call in gateway.history_calls])

    async def test_large_cache_can_serve_smaller_history_request(self) -> None:
        gateway = FakeGateway()
        cache = HistoryCache(gateway)

        await cache.get("SSI", "1m", 500)
        result, cached = await cache.get("SSI", "1m", 2)

        self.assertTrue(cached)
        self.assertEqual(2, len(result))
        self.assertEqual([500], [call[2] for call in gateway.history_calls])

    async def test_explicit_range_is_forwarded_without_reusing_latest_cache(self) -> None:
        gateway = FakeGateway()
        cache = HistoryCache(gateway)

        await cache.get("HPG", "1d", 500)
        ranged, cached = await cache.get("HPG", "1d", 1000, 1_600_000_000, 1_700_000_000)

        self.assertFalse(cached)
        self.assertEqual(1000, len(ranged))
        self.assertEqual([500, 1000], [call[2] for call in gateway.history_calls])
        self.assertEqual((1_600_000_000, 1_700_000_000), gateway.history_calls[-1][3:])


class FiinQuantGatewayTests(unittest.TestCase):
    def test_history_request_uses_non_realtime_http_path(self) -> None:
        gateway = FiinQuantGateway("", "")
        client = FakeFiinClient()
        gateway._client = client

        result = gateway.fetch_history("HPG", "1m", 1)

        self.assertEqual(1, len(result))
        self.assertIsNotNone(client.history_args)
        self.assertFalse(client.history_args["realtime"])

    def test_intraday_history_supplements_period_with_current_day(self) -> None:
        gateway = FiinQuantGateway("", "")
        client = FakeFiinClient()
        gateway._client = client

        gateway.fetch_history("HPG", "1m", 500)

        self.assertEqual(2, len(client.history_calls))
        self.assertNotIn("period", client.history_calls[0])
        self.assertIn("from_date", client.history_calls[0])
        self.assertIn("to_date", client.history_calls[0])
        self.assertEqual(500, client.history_calls[1]["period"])

    def test_daily_history_does_not_make_intraday_supplement_request(self) -> None:
        gateway = FiinQuantGateway("", "")
        client = FakeFiinClient()
        gateway._client = client

        gateway.fetch_history("HPG", "1d", 500)

        self.assertEqual(1, len(client.history_calls))
        self.assertEqual(500, client.history_calls[0]["period"])


class TickHubTests(unittest.IsolatedAsyncioTestCase):
    def test_tick_time_combines_trading_date_and_timestamp(self) -> None:
        actual = TickHub._tick_time({
            "TradingDate": "2026-07-20",
            "Timestamp": "09:38:15",
        })
        expected = datetime(
            2026, 7, 20, 9, 38, 15, tzinfo=ZoneInfo("Asia/Ho_Chi_Minh")
        ).timestamp()

        self.assertEqual(expected, actual)

    def test_tick_time_accepts_complete_iso_timestamp(self) -> None:
        actual = TickHub._tick_time({
            "TradingDate": "2026-07-20",
            "Timestamp": "2026-07-20T09:38:15+07:00",
        })
        expected = datetime(
            2026, 7, 20, 9, 38, 15, tzinfo=ZoneInfo("Asia/Ho_Chi_Minh")
        ).timestamp()

        self.assertEqual(expected, actual)

    async def test_duplicate_subscribers_aggregate_volume_once(self) -> None:
        gateway = FakeGateway()
        cache = HistoryCache(gateway)
        hub = TickHub(gateway, cache)
        first = FakeWebSocket()
        second = FakeWebSocket()
        subscription = {("SSI", "1m")}
        hub.clients[first] = set(subscription)
        hub.clients[second] = set(subscription)

        hub._handle_tick({
            "Ticker": "SSI",
            "Close": 25.0,
            "MatchVolume": 10,
            "TradingDate": "2026-07-18 10:00:10",
        })
        await asyncio.sleep(0)

        self.assertEqual(10.0, hub.bars[("SSI", "1m")]["volume"])
        self.assertEqual(1, len(first.messages))
        self.assertEqual(1, len(second.messages))
        self.assertEqual("SSI", first.messages[0]["symbol"])
        self.assertEqual("1m", first.messages[0]["interval"])
        self.assertEqual("SSI", hub.status()["lastTickSymbol"])
        self.assertIsNotNone(hub.status()["lastTickAt"])

    async def test_invalid_ticks_do_not_create_bars(self) -> None:
        gateway = FakeGateway()
        cache = HistoryCache(gateway)
        hub = TickHub(gateway, cache)
        client = FakeWebSocket()
        hub.clients[client] = {("VNM", "1m")}

        for tick in (
            {"Ticker": "VNM", "Close": 0, "TradingDate": "2026-07-18 10:00:10"},
            {"Ticker": "VNM", "Close": float("nan"), "TradingDate": "2026-07-18 10:00:10"},
            {"Ticker": "VNM", "Close": 58.3},
        ):
            hub._handle_tick(tick)
        await asyncio.sleep(0)

        self.assertNotIn(("VNM", "1m"), hub.bars)
        self.assertEqual([], client.messages)

    async def test_symbol_changes_keep_one_upstream_stream(self) -> None:
        gateway = FakeGateway()
        cache = HistoryCache(gateway)
        hub = TickHub(gateway, cache)
        client = FakeWebSocket()
        hub.clients[client] = {("SSI", "1m")}

        await hub._sync_stream()
        await asyncio.sleep(0.01)
        self.assertIsNotNone(hub._stream)
        self.assertEqual(frozenset({"SSI"}), hub._stream_symbols)
        self.assertEqual(1, gateway.stream_count)
        hub.clients[client] = {("HPG", "1m"), ("SSI", "1m")}
        await hub._sync_stream()
        await asyncio.sleep(0.01)

        self.assertIsNotNone(hub._stream)
        self.assertEqual(frozenset({"HPG", "SSI"}), hub._stream_symbols)
        self.assertEqual(1, gateway.stream_count)
        self.assertEqual(1, gateway.max_stream_count)
        await hub.close()


if __name__ == "__main__":
    unittest.main()
