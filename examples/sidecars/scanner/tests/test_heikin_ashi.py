from __future__ import annotations

import sys
import unittest
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from heikin_ashi import aggregate_daily, compute_latest_metrics, to_heikin
from models import Candle, ScanRequest


class HeikinAshiTests(unittest.TestCase):
    def test_formula_and_no_lower_wick(self):
        raw = [
            Candle(1, 10, 12, 9, 11, 100),
            Candle(2, 11, 14, 11, 14, 120),
        ]
        aggregated = [
            type('Bar', (), {**raw[0].__dict__, 'bucket_end': 2})(),
            type('Bar', (), {**raw[1].__dict__, 'bucket_end': 3})(),
        ]
        series = to_heikin(aggregated)
        self.assertAlmostEqual(series[0].ha_close, 10.5)
        self.assertAlmostEqual(series[0].ha_open, 10.5)
        self.assertAlmostEqual(series[1].ha_open, 10.5)
        self.assertAlmostEqual(series[1].ha_close, 12.5)
        self.assertEqual(series[1].ha_low, 10.5)

    def test_metrics_current_and_closed(self):
        tz = ZoneInfo('UTC')
        start = int(datetime(2026, 1, 1, tzinfo=tz).timestamp())
        daily = [
            Candle(start + day * 86400, 10 + day, 12 + day, 9 + day, 11 + day, 100, True)
            for day in range(45)
        ]
        now = int(datetime(2026, 2, 15, tzinfo=tz).timestamp())
        metrics = compute_latest_metrics(daily, '1M', 'UTC', now=now)
        self.assertIn('current', metrics)
        self.assertIn('closed', metrics)
        self.assertLess(metrics['closed'].candle_time, metrics['current'].candle_time)

    def test_stock_week_closes_after_friday(self):
        tz = ZoneInfo('Asia/Ho_Chi_Minh')
        monday = int(datetime(2026, 8, 3, tzinfo=tz).timestamp())
        previous = [
            Candle(monday - 7 * 86400 + day * 86400, 8 + day, 10 + day, 7 + day, 9 + day, 100, True)
            for day in range(5)
        ]
        current = [
            Candle(monday + day * 86400, 10 + day, 12 + day, 9 + day, 11 + day, 100, True)
            for day in range(5)
        ]
        saturday = int(datetime(2026, 8, 8, tzinfo=tz).timestamp())
        metrics = compute_latest_metrics(
            previous + current,
            '1w',
            'Asia/Ho_Chi_Minh',
            now=saturday,
            continuous_market=False,
        )
        self.assertIn('closed', metrics)
        self.assertEqual(metrics['closed'].candle_time, monday)

    def test_request_rejects_multiple_timeframes(self):
        with self.assertRaises(ValueError):
            ScanRequest.from_json({
                'source': 'fiinquant',
                'universes': ['HOSE'],
                'filters': {},
                'heikinAshi': {'timeframe': ['1w', '1M']},
            })


if __name__ == '__main__':
    unittest.main()
