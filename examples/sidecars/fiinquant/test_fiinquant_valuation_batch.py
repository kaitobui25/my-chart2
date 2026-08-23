from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fiinquant_sidecar import FiinQuantGateway, normalize_stock_valuation_many

VN_TZ = ZoneInfo("Asia/Ho_Chi_Minh")


class FakeValuationFrame:
    def to_dict(self, orient: str):
        assert orient == "records"
        return [
            {"Ticker": "AAA", "Date": "2026-08-21", "PE": 10.0, "PB": 1.1},
            {"Ticker": "AAM", "Date": "2026-08-21", "PE": 8.0, "PB": 0.9},
        ]


class FakeMarketDepth:
    def __init__(self) -> None:
        self.kwargs = None

    def get_stock_valuation(self, **kwargs):
        self.kwargs = kwargs
        return FakeValuationFrame()


class FakeClient:
    def __init__(self) -> None:
        self.market_depth = FakeMarketDepth()

    def MarketDepth(self):
        return self.market_depth


def test_normalize_stock_valuation_many_groups_rows_by_ticker() -> None:
    result = normalize_stock_valuation_many(
        FakeValuationFrame(),
        ["AAA", "AAM"],
    )

    assert set(result) == {"AAA", "AAM"}
    assert result["AAA"][0]["pe"] == 10.0
    assert result["AAM"][0]["pb"] == 0.9


def test_gateway_sends_multiple_tickers_in_one_sdk_call() -> None:
    gateway = FiinQuantGateway("", "")
    client = FakeClient()
    gateway._client = client
    start = int(datetime(2016, 8, 23, tzinfo=VN_TZ).timestamp())
    end = int(datetime(2026, 8, 23, tzinfo=VN_TZ).timestamp())

    result = gateway.fetch_stock_valuations(["AAA", "AAM"], start, end)

    assert client.market_depth.kwargs["tickers"] == ["AAA", "AAM"]
    assert client.market_depth.kwargs["from_date"] == "2016-08-23"
    assert client.market_depth.kwargs["to_date"] == "2026-08-23"
    assert set(result) == {"AAA", "AAM"}
