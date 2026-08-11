from __future__ import annotations

import unittest
from contextlib import redirect_stdout
from datetime import datetime
from io import StringIO
from zoneinfo import ZoneInfo

from vnstock_sidecar import (
    POLL_INTERVAL_SECONDS,
    Candle,
    VnstockQuotaError,
    _call_vnstock,
    aggregate_candles,
    normalize_candle,
)

VN_TZ = ZoneInfo('Asia/Ho_Chi_Minh')


def ts(year: int, month: int, day: int, hour: int = 9) -> int:
    return int(datetime(year, month, day, hour, tzinfo=VN_TZ).timestamp())


class NormalizeCandleTests(unittest.TestCase):
    def test_accepts_common_ohlcv_fields(self) -> None:
        candle = normalize_candle({
            'time': ts(2026, 8, 7),
            'open': 100,
            'high': 105,
            'low': 99,
            'close': 103,
            'volume': 123456,
        })
        self.assertIsNotNone(candle)
        assert candle is not None
        self.assertEqual(candle.close, 103)
        self.assertEqual(candle.volume, 123456)

    def test_rejects_invalid_ohlc_geometry(self) -> None:
        candle = normalize_candle({
            'time': ts(2026, 8, 7),
            'open': 100,
            'high': 101,
            'low': 99,
            'close': 103,
            'volume': 100,
        })
        self.assertIsNone(candle)

    def test_negative_volume_becomes_missing_not_bad_price(self) -> None:
        candle = normalize_candle({
            'time': ts(2026, 8, 7),
            'open': 100,
            'high': 105,
            'low': 99,
            'close': 103,
            'volume': -1,
        })
        self.assertIsNotNone(candle)
        assert candle is not None
        self.assertIsNone(candle.volume)


class AggregateTests(unittest.TestCase):
    def test_week_uses_first_open_last_close_extremes_and_volume(self) -> None:
        raw = [
            Candle(ts(2026, 8, 3), 10, 12, 9, 11, 100),
            Candle(ts(2026, 8, 4), 11, 14, 10, 13, 200),
            Candle(ts(2026, 8, 7), 13, 15, 12, 14, 300),
        ]
        bars = aggregate_candles(raw, '1w')
        self.assertEqual(len(bars), 1)
        self.assertEqual((bars[0].open, bars[0].high, bars[0].low, bars[0].close), (10, 15, 9, 14))
        self.assertEqual(bars[0].volume, 600)

    def test_month_does_not_mix_calendar_months(self) -> None:
        raw = [
            Candle(ts(2026, 7, 31), 10, 11, 9, 10.5, 100),
            Candle(ts(2026, 8, 3), 11, 12, 10, 11.5, 200),
        ]
        bars = aggregate_candles(raw, '1M')
        self.assertEqual(len(bars), 2)
        self.assertEqual(bars[0].close, 10.5)
        self.assertEqual(bars[1].open, 11)

    def test_four_hour_group_never_crosses_trading_day(self) -> None:
        raw = [
            Candle(ts(2026, 8, 6, 9), 10, 11, 9, 10.5, 10),
            Candle(ts(2026, 8, 6, 10), 10.5, 12, 10, 11, 20),
            Candle(ts(2026, 8, 6, 11), 11, 13, 10.5, 12, 30),
            Candle(ts(2026, 8, 6, 13), 12, 14, 11, 13, 40),
            Candle(ts(2026, 8, 7, 9), 20, 21, 19, 20.5, 50),
        ]
        bars = aggregate_candles(raw, '4h')
        self.assertEqual(len(bars), 2)
        self.assertEqual(bars[0].open, 10)
        self.assertEqual(bars[0].close, 13)
        self.assertEqual(bars[0].volume, 100)
        self.assertEqual(bars[1].open, 20)


class QuotaHandlingTests(unittest.TestCase):
    def test_rate_limit_exit_is_silent_and_becomes_a_regular_error(self) -> None:
        terminal = StringIO()

        def limited_call() -> None:
            print('GIỚI HẠN API ĐÃ ĐẠT TỐI ĐA')
            raise SystemExit('Rate limit exceeded. Process terminated.')

        with redirect_stdout(terminal):
            with self.assertRaisesRegex(VnstockQuotaError, 'retry later'):
                _call_vnstock(limited_call)

        self.assertEqual(terminal.getvalue(), '')
        self.assertEqual(POLL_INTERVAL_SECONDS, 300.0)


if __name__ == '__main__':
    unittest.main()
