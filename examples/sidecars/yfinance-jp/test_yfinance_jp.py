from __future__ import annotations

import unittest
from datetime import datetime
from pathlib import Path
import sys

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
from yfinance_jp_sidecar import parse_adjusted  # noqa: E402


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


class FakeYFinance:
    def __init__(self, frame: pd.DataFrame | None = None) -> None:
        self.frame = frame if frame is not None else pd.DataFrame()
        self.history_calls: list[tuple[str, dict]] = []
        self.search_calls: list[tuple[str, int]] = []
        self.search_quotes: list[dict] = []

    def Ticker(self, symbol: str) -> FakeTicker:
        return FakeTicker(symbol, self)

    def Search(self, query: str, max_results: int, news_count: int, raise_errors: bool) -> FakeSearch:
        self.search_calls.append((query, max_results))
        return FakeSearch(self.search_quotes)


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
