from __future__ import annotations

import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from db import ScannerDB
from engine import ScannerEngine
from local_eod_provider import LocalEodProvider
from models import (
    BreakoutVolumeScan,
    Candle,
    HeikinScan,
    Instrument,
    MarketSnapshot,
    ScanFilters,
    ScanRequest,
)


class ScannerModeIntersectionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.db = ScannerDB(Path(self.temp.name) / 'scanner.db', ROOT / 'migrations')
        self.provider = LocalEodProvider()
        self.engine = ScannerEngine(self.db, {'vn_eod': self.provider})
        self._seed_breakout_symbol()

    async def asyncTearDown(self) -> None:
        self.db.close()
        self.temp.cleanup()

    def _seed_breakout_symbol(self) -> None:
        tz = ZoneInfo('Asia/Ho_Chi_Minh')
        start = datetime(2026, 4, 6, tzinfo=tz)
        closes = [
            18_000, 18_300, 18_600, 18_900,
            19_200, 19_400, 19_600, 19_800,
            20_000, 20_200, 20_400, 21_500,
        ]
        weekly_volumes = [600_000] * 11 + [1_600_000]
        candles: list[Candle] = []
        for week, (close, weekly_volume) in enumerate(zip(closes, weekly_volumes)):
            monday = start + timedelta(days=week * 7)
            daily_volume = weekly_volume / 5
            for day in range(5):
                candle_time = int((monday + timedelta(days=day)).timestamp())
                candles.append(Candle(
                    candle_time,
                    close * 0.99,
                    close * 1.01,
                    close * 0.98,
                    close,
                    daily_volume,
                    True,
                ))

        latest = candles[-1]
        self.db.import_eod_dataset(
            'vn_eod',
            [Instrument('vn_eod', 'BOTH', 'Both scanners', 'HOSE', 'STOCK')],
            {'BOTH': candles},
            [MarketSnapshot('BOTH', latest.close, latest.volume, None, latest.time)],
        )
        import_id = self.db.begin_eod_import('vn_eod', 'test', 'upto', True, None, None)
        self.db.finish_eod_import(
            import_id,
            status='complete',
            trade_date=latest.time,
            symbol_count=1,
            inserted_candle_count=len(candles),
        )

    def _request(self, ha_change_min: float | None) -> ScanRequest:
        return ScanRequest(
            source='vn_eod',
            universes=('HOSE',),
            filters=ScanFilters(),
            heikin_ashi=HeikinScan(
                timeframe='1w',
                green=False,
                no_lower_wick=False,
                close_change_pct_min=ha_change_min,
                candle='closed',
                enabled=True,
            ),
            breakout_volume=BreakoutVolumeScan(enabled=True),
        )

    async def test_both_enabled_keeps_only_rows_matching_both_scanners(self) -> None:
        permissive = self._request(None)
        run_id = self.db.begin_scan('vn_eod', permissive.to_json())
        state = await self.engine.execute(run_id, permissive)

        self.assertEqual(state.status, 'complete')
        self.assertEqual([row['symbol'] for row in state.results], ['BOTH'])
        self.assertEqual(state.results[0]['mode'], 'breakout_volume')

        restrictive = self._request(999.0)
        run_id = self.db.begin_scan('vn_eod', restrictive.to_json())
        state = await self.engine.execute(run_id, restrictive)

        self.assertEqual(state.status, 'complete')
        self.assertEqual(state.results, [])

    def test_explicitly_disabling_both_scanners_is_rejected(self) -> None:
        payload = self._request(None).to_json()
        payload['heikinAshi']['enabled'] = False
        payload['breakoutVolume']['enabled'] = False

        with self.assertRaisesRegex(ValueError, 'Bật Scanner 03 hoặc Scanner 04'):
            ScanRequest.from_json(payload)


if __name__ == '__main__':
    unittest.main()
