from __future__ import annotations

import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from breakout_volume import aggregate_closed_weeks, evaluate_breakout_volume
from models import BreakoutVolumeScan, Candle

TZ = ZoneInfo('Asia/Ho_Chi_Minh')


def weekly_daily(
    monday: datetime,
    close: float,
    weekly_volume: float,
) -> list[Candle]:
    daily_volume = weekly_volume / 5.0
    rows: list[Candle] = []
    for day in range(5):
        timestamp = int((monday + timedelta(days=day)).timestamp())
        day_close = close
        rows.append(Candle(
            timestamp,
            day_close * 0.99,
            day_close * 1.01,
            day_close * 0.98,
            day_close,
            daily_volume,
            True,
        ))
    return rows


def history_from_weeks(closes: list[float], volumes: list[float]) -> list[Candle]:
    start = datetime(2026, 4, 6, tzinfo=TZ)
    rows: list[Candle] = []
    for index, (close, volume) in enumerate(zip(closes, volumes)):
        rows.extend(weekly_daily(start + timedelta(days=index * 7), close, volume))
    return rows


class BreakoutVolumeTests(unittest.TestCase):
    def setUp(self):
        self.config = BreakoutVolumeScan(
            enabled=True,
            min_median_traded_value=5_000_000_000,
            min_median_volume=500_000,
            min_weekly_change_pct=4,
            min_rvol=1.5,
            strong_rvol=2.5,
        )
        self.now = int(datetime(2026, 6, 27, tzinfo=TZ).timestamp())

    def test_weekly_traded_value_sums_daily_close_times_volume(self):
        monday = datetime(2026, 8, 3, tzinfo=TZ)
        daily = weekly_daily(monday, 20_000, 600_000)
        saturday = int(datetime(2026, 8, 8, tzinfo=TZ).timestamp())
        weeks = aggregate_closed_weeks(daily, 'Asia/Ho_Chi_Minh', now=saturday)
        self.assertEqual(len(weeks), 1)
        self.assertAlmostEqual(weeks[0].volume or 0, 600_000)
        self.assertAlmostEqual(weeks[0].traded_value or 0, 12_000_000_000)

    def test_current_week_is_never_used(self):
        closes = [20_000 + index * 100 for index in range(12)]
        volumes = [600_000] * 12
        daily = history_from_weeks(closes, volumes)
        current_monday = datetime(2026, 6, 29, tzinfo=TZ)
        daily.append(Candle(
            int(current_monday.timestamp()),
            25_000,
            30_000,
            24_000,
            30_000,
            5_000_000,
            True,
        ))
        current_tuesday = int(datetime(2026, 6, 30, 12, tzinfo=TZ).timestamp())
        weeks = aggregate_closed_weeks(daily, 'Asia/Ho_Chi_Minh', now=current_tuesday)
        self.assertEqual(len(weeks), 12)
        self.assertLess(weeks[-1].time, int(current_monday.timestamp()))

    def test_new_signal_uses_median_liquidity_and_rvol(self):
        closes = [
            18_000, 18_300, 18_600, 18_900,
            19_200, 19_400, 19_600, 19_800,
            20_000, 20_200, 20_400,
            21_500,
        ]
        volumes = [600_000] * 11 + [1_600_000]
        signal = evaluate_breakout_volume(
            history_from_weeks(closes, volumes),
            'Asia/Ho_Chi_Minh',
            self.config,
            now=self.now,
        )
        self.assertIsNotNone(signal)
        assert signal is not None
        self.assertEqual(signal.signal_state, 'NEW')
        self.assertGreaterEqual(signal.weekly_change_pct, 4)
        self.assertAlmostEqual(signal.median_volume, 600_000)
        self.assertGreater(signal.close, signal.breakout_level)
        self.assertGreaterEqual(signal.rvol, 2.5)
        self.assertTrue(signal.strong)
        self.assertIsNone(signal.next_week_time)

    def test_median_volume_gate_rejects_illiquid_symbol(self):
        closes = [20_000 + index * 100 for index in range(11)] + [22_000]
        volumes = [200_000] * 11 + [1_000_000]
        signal = evaluate_breakout_volume(
            history_from_weeks(closes, volumes),
            'Asia/Ho_Chi_Minh',
            self.config,
            now=self.now,
        )
        self.assertIsNone(signal)

    def test_median_traded_value_gate_rejects_low_value_symbol(self):
        closes = [1_000 + index * 10 for index in range(11)] + [1_200]
        volumes = [600_000] * 11 + [1_600_000]
        signal = evaluate_breakout_volume(
            history_from_weeks(closes, volumes),
            'Asia/Ho_Chi_Minh',
            self.config,
            now=self.now,
        )
        self.assertIsNone(signal)

    def test_weekly_change_gate_rejects_move_below_four_percent(self):
        closes = [
            18_000, 18_200, 18_400, 18_600,
            18_800, 19_000, 19_200, 19_400,
            19_600, 19_800, 20_000, 20_700,
        ]
        volumes = [600_000] * 11 + [1_200_000]
        signal = evaluate_breakout_volume(
            history_from_weeks(closes, volumes),
            'Asia/Ho_Chi_Minh',
            self.config,
            now=self.now,
        )
        self.assertIsNone(signal)

    def test_rvol_gate_rejects_below_one_point_five(self):
        closes = [
            18_000, 18_200, 18_400, 18_600,
            18_800, 19_000, 19_200, 19_400,
            19_600, 19_800, 20_000, 21_000,
        ]
        volumes = [600_000] * 11 + [899_000]
        signal = evaluate_breakout_volume(
            history_from_weeks(closes, volumes),
            'Asia/Ho_Chi_Minh',
            self.config,
            now=self.now,
        )
        self.assertIsNone(signal)

    def test_follow_up_uses_original_baseline_and_breakout_level(self):
        closes = [
            18_000, 18_200, 18_400, 18_600,
            18_800, 19_000, 19_200, 19_400,
            19_600, 19_800, 21_000, 21_100,
        ]
        volumes = [600_000] * 10 + [1_200_000, 700_000]
        signal = evaluate_breakout_volume(
            history_from_weeks(closes, volumes),
            'Asia/Ho_Chi_Minh',
            self.config,
            now=self.now,
        )
        self.assertIsNotNone(signal)
        assert signal is not None
        self.assertEqual(signal.signal_state, 'FOLLOW_UP')
        self.assertAlmostEqual(signal.rvol, 2.0)
        self.assertAlmostEqual(signal.next_week_rvol or 0, 700_000 / 600_000)
        self.assertEqual(signal.next_week_close, 21_100)
        self.assertTrue(signal.next_week_holds_breakout)

    def test_follow_up_marks_failed_below_original_breakout_level(self):
        closes = [
            18_000, 18_200, 18_400, 18_600,
            18_800, 19_000, 19_200, 19_400,
            19_600, 19_800, 21_000, 19_500,
        ]
        volumes = [600_000] * 10 + [1_200_000, 700_000]
        signal = evaluate_breakout_volume(
            history_from_weeks(closes, volumes),
            'Asia/Ho_Chi_Minh',
            self.config,
            now=self.now,
        )
        self.assertIsNotNone(signal)
        assert signal is not None
        self.assertEqual(signal.signal_state, 'FOLLOW_UP')
        self.assertEqual(signal.next_week_close, 19_500)
        self.assertFalse(signal.next_week_holds_breakout)

    def test_request_defaults_leave_scanner04_disabled(self):
        from models import ScanRequest

        request = ScanRequest.from_json({
            'source': 'vn_eod',
            'universes': ['HOSE'],
            'filters': {},
            'heikinAshi': {'timeframe': '1w', 'candle': 'closed'},
        })
        self.assertFalse(request.breakout_volume.enabled)
        self.assertEqual(request.breakout_volume.min_median_volume, 500_000)

    def test_request_rejects_scanner04_on_non_eod_source(self):
        from models import ScanRequest

        with self.assertRaises(ValueError):
            ScanRequest.from_json({
                'source': 'fiinquant',
                'universes': ['HOSE'],
                'filters': {},
                'heikinAshi': {'timeframe': '1w', 'candle': 'closed'},
                'breakoutVolume': {'enabled': True},
            })


if __name__ == '__main__':
    unittest.main()
