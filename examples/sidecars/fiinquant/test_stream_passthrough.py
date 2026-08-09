from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fiinquant_sidecar import FiinQuantGateway


class FakeFiinClient:
    def __init__(self) -> None:
        self.stream = object()
        self.calls: list[tuple[list[str], object]] = []

    def Trading_Data_Stream(self, *, tickers: list[str], callback):
        self.calls.append((tickers, callback))
        return self.stream


class StreamPassthroughTests(unittest.TestCase):
    def test_current_sdk_stream_is_returned_without_private_monkey_patch(self) -> None:
        gateway = FiinQuantGateway("", "")
        client = FakeFiinClient()
        gateway._client = client
        callback = lambda _data: None

        stream = gateway.make_stream(["FPT"], callback)

        self.assertIs(client.stream, stream)
        self.assertEqual([(["FPT"], callback)], client.calls)
        self.assertFalse(hasattr(stream, "_build_connection"))
        self.assertFalse(hasattr(stream, "_handle_disconnect"))


if __name__ == "__main__":
    unittest.main()
