from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fiinquant_sidecar import FiinQuantGateway


class FakeEvent:
    def __init__(self) -> None:
        self.is_set = False

    def set(self) -> None:
        self.is_set = True


class FakeStream:
    def __init__(self) -> None:
        self.url = "https://example.test/RealtimeHub"
        self._stop_event = FakeEvent()
        self.disconnects = 0

    @staticmethod
    def access_token() -> str:
        return "token"

    def _on_disconnect(self) -> None:
        self.disconnects += 1

    def _handle_disconnect(self) -> None:
        raise AssertionError("SDK reconnect loop must be disabled")


class FakeFiinClient:
    def __init__(self) -> None:
        self.stream = FakeStream()
        self.calls: list[tuple[list[str], object]] = []

    def Trading_Data_Stream(self, *, tickers: list[str], callback):
        self.calls.append((tickers, callback))
        return self.stream


class FakeBuilder:
    last_options = None

    def with_url(self, _url, options):
        FakeBuilder.last_options = options
        return self

    @staticmethod
    def build():
        return "connection"


class StreamCompatibilityTests(unittest.TestCase):
    def test_legacy_signalr_stream_uses_one_outer_reconnect_owner(self) -> None:
        gateway = FiinQuantGateway("", "")
        client = FakeFiinClient()
        gateway._client = client
        callback = lambda _data: None

        builder_module = types.ModuleType("signalrcore.hub_connection_builder")
        builder_module.HubConnectionBuilder = FakeBuilder
        signalr_module = types.ModuleType("signalrcore")
        with patch.dict(sys.modules, {
            "signalrcore": signalr_module,
            "signalrcore.hub_connection_builder": builder_module,
        }):
            stream = gateway.make_stream(["FPT"], callback)
            connection = stream._build_connection()

        self.assertIs(client.stream, stream)
        self.assertEqual([(["FPT"], callback)], client.calls)
        self.assertEqual("connection", connection)
        self.assertEqual("token", FakeBuilder.last_options["access_token_factory"]())
        stream._handle_disconnect()
        stream._on_disconnect()
        self.assertEqual(1, stream.disconnects)
        self.assertTrue(stream._stop_event.is_set)


if __name__ == "__main__":
    unittest.main()
