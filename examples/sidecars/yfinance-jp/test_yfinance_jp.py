from __future__ import annotations

import json
import unittest
from datetime import datetime
from pathlib import Path
import sys
from unittest.mock import patch

import pandas as pd


HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from yfinance_jp_core import (  # noqa: E402
    Candle,
    DEFAULT_HISTORY_PERIODS,
    LATEST_PERIODS,
    YFinanceJapanGateway,
    aggregate_four_hour,
    native_interval,
    normalize_symbol,
    session_metadata,
)
import yfinance_jp_sidecar as sidecar  # noqa: E402
from yfinance_jp_sidecar import create_app, parse_adjusted  # noqa: E402


class FakeTicker:
    def __init__(self, symbol: str, owner: "FakeYFinance") -> None:
        self.symbol = symbol
        self.owner = owner

    def history(self, **kwargs):
        self.owner.history_calls.append((self.symbol, kwargs))
        return self.owner.frame


class FakeSearch:
    def __init__(self, quotes):
        self.quotes = quotes


class FakeEquityQuery:
    def __init__(self, operator: str, operand: list) -> None:
        self.operator = operator
        self.operand = operand


class FakeYFinance:
    def __init__(self, frame: pd.DataFrame | None = None) -> None:
        self.frame = frame if frame is not None else pd.DataFrame()
        self.history_calls: list[tuple[str, dict]] = []
        self.search_calls: list[tuple[str, int]] = []
        self.search_quotes: list[dict] = []
        self.screen_calls: list[tuple[FakeEquityQuery, int, int, str, bool]] = []
        self.screen_pages: dict[int, dict] = {}
        self.download_calls: list[tuple[list[str], dict]] = []

    def Ticker(self, symbol: str) -> FakeTicker:
        return FakeTicker(symbol, self)

    def Search(self, query: str, max_results: int, news_count: int, raise_errors: bool) -> FakeSearch:
        self.search_calls.append((query, max_results))
        return FakeSearch(self.search_quotes)

    def EquityQuery(self, operator: str, operand: list) -> FakeEquityQuery:
        return FakeEquityQuery(operator, operand)

    def screen(
        self,
        query: FakeEquityQuery,
        offset: int,
        size: int,
        sortField: str,
        sortAsc: bool,
    ) -> dict:
        self.screen_calls.append((query, offset, size, sortField, sortAsc))
        return self.screen_pages.get(offset, {"total": 0, "quotes": []})

    def download(self, tickers, **kwargs):
        symbols = list(tickers) if not isinstance(tickers, str) else [tickers]
        self.download_calls.append((symbols, kwargs))
        if self.frame.empty:
            return pd.DataFrame()
        return pd.concat({symbol: self.frame.copy() for symbol in symbols}, axis=1)


class FakeJsonRequest:
    def __init__(self, payload: dict) -> None:
        self.payload = payload

    async def json(self) -> dict:
        return self.payload


def sample_frame() -> pd.DataFrame:
    index = pd.DatetimeIndex([
        "2026-09-30 09:00:00+09:00",
        "2026-09-30 10:00:00+09:00",
    ])
    return pd.DataFrame(
        {
            "Open": [100.0, 101.0],
            "High": [102.0, 104.0],
            "Low": [99.0, 100.0],
            "Close": [101.0, 103.0],
            "Volume": [1000, 1500],
        },
        index=index,
    )


class SymbolTests(unittest.TestCase):
    def test_normalizes_numeric_and_alphanumeric_tse_codes(self) -> None:
        self.assertEqual(normalize_symbol("7203"), "7203.T")
        self.assertEqual(normalize_symbol("130a"), "130A.T")
        self.assertEqual(normalize_symbol("9A76"), "9A76.T")
        self.assertEqual(normalize_symbol("130A.T"), "130A.T")

    def test_rejects_non_tse_shape(self) -> None:
        with self.assertRaises(ValueError):
            normalize_symbol("AAPL")

    def test_symbol_search_filters_to_tokyo_and_keeps_alphanumeric_code(self) -> None:
        fake = FakeYFinance()
        fake.search_quotes = [
            {"symbol": "130A.T", "shortname": "Example Japan", "exchange": "JPX"},
            {"symbol": "AAPL", "shortname": "Apple", "exchange": "NMS"},
        ]
        items = YFinanceJapanGateway(fake).symbols("130A", 10)
        self.assertEqual([item.symbol for item in items], ["130A.T"])
        self.assertEqual(items[0].name, "Example Japan")

    def test_scanner_universe_pages_region_jp_and_returns_snapshot_fields(self) -> None:
        fake = FakeYFinance()
        fake.screen_pages = {
            0: {
                "total": 3,
                "quotes": [
                    {
                        "symbol": "130A.T",
                        "longName": "Veritas In Silico",
                        "exchange": "JPX",
                        "quoteType": "EQUITY",
                        "regularMarketPrice": 432,
                        "regularMarketVolume": 13_100,
                        "marketCap": 2_802_433_280,
                        "regularMarketTime": 1_790_836_200,
                    },
                    {
                        "symbol": "7203.T",
                        "shortName": "Toyota Motor",
                        "exchange": "JPX",
                        "quoteType": "EQUITY",
                        "regularMarketPrice": 3000.5,
                        "regularMarketVolume": 12_000_000,
                        "marketCap": 45_000_000_000_000,
                        "regularMarketTime": 1_790_836_200,
                    },
                ],
            },
            2: {
                "total": 3,
                "quotes": [
                    {
                        "symbol": "9984.T",
                        "shortName": "SoftBank Group",
                        "exchange": "JPX",
                        "quoteType": "EQUITY",
                        "regularMarketPrice": 6500,
                        "regularMarketVolume": 5_000_000,
                        "marketCap": 10_000_000_000_000,
                        "regularMarketTime": 1_790_836_200,
                    }
                ],
            },
        }

        items = YFinanceJapanGateway(fake).scanner_universe(page_size=2)

        self.assertEqual([item.symbol for item in items], ["130A.T", "7203.T", "9984.T"])
        self.assertEqual(items[1].name, "Toyota Motor")
        self.assertEqual(items[1].price, 3000.5)
        self.assertEqual(items[1].volume, 12_000_000)
        self.assertEqual(items[1].marketCap, 45_000_000_000_000)
        self.assertEqual(items[1].dataTime, 1_790_836_200)
        self.assertEqual([call[1] for call in fake.screen_calls], [0, 2])
        query = fake.screen_calls[0][0]
        self.assertEqual((query.operator, query.operand), ("eq", ["region", "jp"]))


class IntervalTests(unittest.TestCase):
    def test_week_and_month_use_yfinance_native_intervals(self) -> None:
        self.assertEqual(native_interval("30m"), "30m")
        self.assertEqual(native_interval("1w"), "1wk")
        self.assertEqual(native_interval("1M"), "1mo")
        self.assertEqual(native_interval("4h"), "1h")

    def test_no_range_periods_are_valid_for_every_supported_interval(self) -> None:
        self.assertEqual(DEFAULT_HISTORY_PERIODS["1m"], "5d")
        self.assertEqual(DEFAULT_HISTORY_PERIODS["5m"], "1mo")
        self.assertEqual(DEFAULT_HISTORY_PERIODS["30m"], "1mo")
        self.assertEqual(DEFAULT_HISTORY_PERIODS["1w"], "max")
        self.assertEqual(DEFAULT_HISTORY_PERIODS["1M"], "max")
        self.assertEqual(set(DEFAULT_HISTORY_PERIODS), set(LATEST_PERIODS))

    def test_four_hour_aggregation_does_not_cross_tokyo_days(self) -> None:
        tokyo = session_metadata(datetime.fromisoformat("2026-10-01T10:00:00+09:00"))["timezone"]
        self.assertEqual(tokyo, "Asia/Tokyo")
        first = int(datetime.fromisoformat("2026-10-01T09:00:00+09:00").timestamp())
        second_day = int(datetime.fromisoformat("2026-10-02T09:00:00+09:00").timestamp())
        candles = [
            Candle(first, 10, 12, 9, 11, 100),
            Candle(first + 3600, 11, 13, 10, 12, 200),
            Candle(second_day, 20, 22, 19, 21, 300),
        ]
        result = aggregate_four_hour(candles)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0].volume, 300)
        self.assertEqual(result[1].open, 20)


class AdjustmentAndRangeTests(unittest.TestCase):
    def test_adjustment_parser_is_explicit(self) -> None:
        self.assertFalse(parse_adjusted(None))
        self.assertFalse(parse_adjusted("raw"))
        self.assertTrue(parse_adjusted("true"))
        with self.assertRaises(ValueError):
            parse_adjusted("maybe")

    def test_history_passes_adjustment_and_requested_start_without_sidecar_cap(self) -> None:
        fake = FakeYFinance(sample_frame())
        gateway = YFinanceJapanGateway(fake)
        old_start = int(datetime.fromisoformat("2020-01-01T00:00:00+09:00").timestamp())
        end = int(datetime.fromisoformat("2026-10-01T00:00:00+09:00").timestamp())
        gateway.history("7203", "1m", 500, old_start, end, adjusted=True)

        symbol, kwargs = fake.history_calls[-1]
        self.assertEqual(symbol, "7203.T")
        self.assertEqual(kwargs["interval"], "1m")
        self.assertTrue(kwargs["auto_adjust"])
        self.assertEqual(int(kwargs["start"].timestamp()), old_start)
        self.assertEqual(int(kwargs["end"].timestamp()), end + 1)
        self.assertNotIn("period", kwargs)

    def test_weekly_history_is_not_reaggregated_from_daily(self) -> None:
        fake = FakeYFinance(sample_frame())
        YFinanceJapanGateway(fake).history("7203.T", "1w", 20, adjusted=False)
        _, kwargs = fake.history_calls[-1]
        self.assertEqual(kwargs["interval"], "1wk")
        self.assertEqual(kwargs["period"], "max")
        self.assertFalse(kwargs["auto_adjust"])

    def test_daily_history_uses_bounded_download_batches_and_frame_validation(self) -> None:
        fake = FakeYFinance(sample_frame())
        gateway = YFinanceJapanGateway(fake)
        since_time = int(datetime.fromisoformat("2026-09-30T00:00:00+09:00").timestamp())

        with patch("yfinance_jp_core.SCANNER_HISTORY_BATCH_SIZE", 2):
            history = gateway.daily_history(
                ["130A", "7203.T", "9984.T", "AAPL"],
                10,
                since_time=since_time,
            )

        self.assertEqual(set(history), {"130A.T", "7203.T", "9984.T"})
        self.assertEqual([len(call[0]) for call in fake.download_calls], [2, 1])
        first_kwargs = fake.download_calls[0][1]
        self.assertEqual(first_kwargs["interval"], "1d")
        self.assertEqual(first_kwargs["group_by"], "ticker")
        self.assertFalse(first_kwargs["auto_adjust"])
        self.assertLessEqual(first_kwargs["threads"], 8)
        self.assertEqual(int(first_kwargs["start"].timestamp()), since_time)
        self.assertEqual(history["7203.T"][-1].close, 103.0)


class SidecarRouteTests(unittest.TestCase):
    def test_scanner_endpoints_are_exposed_without_changing_chart_routes(self) -> None:
        app = create_app()
        routes = {(route.method, route.resource.canonical) for route in app.router.routes()}
        self.assertIn(("GET", "/symbols"), routes)
        self.assertIn(("GET", "/history"), routes)
        self.assertIn(("GET", "/latest"), routes)
        self.assertIn(("GET", "/scanner/universe"), routes)
        self.assertIn(("POST", "/scanner/history"), routes)


class ScannerEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def test_scanner_universe_endpoint_pages_fake_yfinance(self) -> None:
        fake = FakeYFinance()
        first_page = [
            {
                "symbol": f"{code}.T",
                "shortName": f"Company {code}",
                "exchange": "JPX",
                "quoteType": "EQUITY",
                "regularMarketPrice": 1000 + code,
                "regularMarketVolume": 10_000,
                "marketCap": 1_000_000_000,
                "regularMarketTime": 1_790_836_200,
            }
            for code in range(1000, 1250)
        ]
        fake.screen_pages = {
            0: {
                "total": 251,
                "quotes": first_page,
            },
            250: {
                "total": 251,
                "quotes": [{
                    **first_page[0],
                    "symbol": "1250.T",
                    "shortName": "Company 1250",
                }],
            },
        }
        original = sidecar.GATEWAY
        sidecar.GATEWAY = YFinanceJapanGateway(fake)
        try:
            response = await sidecar.scanner_universe_handler(None)  # type: ignore[arg-type]
        finally:
            sidecar.GATEWAY = original

        payload = json.loads(response.text)
        self.assertEqual(response.status, 200)
        self.assertEqual(len(payload["instruments"]), 251)
        self.assertEqual(payload["instruments"][0]["symbol"], "1000.T")
        self.assertEqual([call[1] for call in fake.screen_calls], [0, 250])
        self.assertTrue(all(call[2] == 250 for call in fake.screen_calls))

    async def test_scanner_history_endpoint_batches_fake_yfinance(self) -> None:
        fake = FakeYFinance(sample_frame())
        original = sidecar.GATEWAY
        sidecar.GATEWAY = YFinanceJapanGateway(fake)
        request = FakeJsonRequest({
            "symbols": ["130A.T", "7203.T", "9984.T"],
            "limit": 10,
            "sinceTime": int(datetime.fromisoformat("2026-09-30T00:00:00+09:00").timestamp()),
        })
        try:
            with patch("yfinance_jp_core.SCANNER_HISTORY_BATCH_SIZE", 2):
                response = await sidecar.scanner_history_handler(request)  # type: ignore[arg-type]
        finally:
            sidecar.GATEWAY = original

        payload = json.loads(response.text)
        self.assertEqual(response.status, 200)
        self.assertEqual(set(payload["candles"]), {"130A.T", "7203.T", "9984.T"})
        self.assertEqual([len(call[0]) for call in fake.download_calls], [2, 1])
        self.assertEqual(payload["candles"]["7203.T"][-1]["close"], 103.0)
        self.assertTrue(payload["candles"]["7203.T"][-1]["isClosed"])


class SessionTests(unittest.TestCase):
    def test_tokyo_open_lunch_and_weekend_states(self) -> None:
        opened = session_metadata(datetime.fromisoformat("2026-10-01T10:00:00+09:00"))
        lunch = session_metadata(datetime.fromisoformat("2026-10-01T12:00:00+09:00"))
        weekend = session_metadata(datetime.fromisoformat("2026-10-03T10:00:00+09:00"))
        self.assertEqual(opened["state"], "open")
        self.assertEqual(lunch["state"], "lunch_break")
        self.assertEqual(weekend["state"], "closed")
        self.assertFalse(opened["holidayAware"])


if __name__ == "__main__":
    unittest.main()
