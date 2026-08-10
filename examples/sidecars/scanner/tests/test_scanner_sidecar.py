from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from db import ScannerDB
from models import Instrument, MarketSnapshot
from scanner_sidecar import CafeFEodUpdateBusy, ScannerRuntime


class FakeEngine:
    def __init__(self) -> None:
        self.providers = {}


class ScannerRuntimeEodTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = ScannerDB(Path(self.temp.name) / 'scanner.db', ROOT / 'migrations')
        self.runtime = ScannerRuntime(self.db, FakeEngine())

    async def asyncTearDown(self):
        await self.runtime.close()
        self.temp.cleanup()

    async def test_eod_status_exposes_local_coverage_and_retention(self):
        self.db.upsert_instruments(
            'vn_eod',
            [Instrument('vn_eod', 'AAA', 'AAA', 'HOSE', 'STOCK', True)],
            deactivate_missing=False,
        )
        self.db.upsert_snapshots(
            'vn_eod',
            [MarketSnapshot('AAA', 10, 1000, None, 1_786_035_600)],
        )
        import_id = self.db.begin_eod_import('vn_eod', 'cafef', 'eod', True, 'daily.zip', 'abc')
        self.db.finish_eod_import(
            import_id,
            status='complete',
            trade_date=1_786_035_600,
            symbol_count=1,
            inserted_candle_count=1,
        )

        status = await self.runtime.eod_status()

        self.assertEqual(status['provider'], 'vn_eod')
        self.assertEqual(status['latestTradeDate'], 1_786_035_600)
        self.assertEqual(status['activeSymbols'], 1)
        self.assertEqual(status['snapshotSymbols'], 1)
        self.assertEqual(status['retentionBars'], 1000)
        self.assertEqual(status['activeMaxAgeDays'], 30)
        self.assertFalse(status['updating'])

    async def test_update_eod_reuses_same_import_latest_service_as_cli(self):
        expected = {
            'ok': True,
            'mode': 'eod',
            'tradeDate': 1_786_035_600,
            'activeSymbols': 1,
            'candles': 1,
        }
        with patch('scanner_sidecar.import_latest_eod', return_value=expected) as importer:
            result = await self.runtime.update_eod()

        self.assertEqual(result, expected)
        importer.assert_called_once_with(self.db, 'eod')
        self.assertIsNone(self.runtime.eod_last_error)

    async def test_update_eod_rejects_duplicate_update(self):
        await self.runtime.eod_update_lock.acquire()
        try:
            with self.assertRaises(CafeFEodUpdateBusy):
                await self.runtime.update_eod()
        finally:
            self.runtime.eod_update_lock.release()


if __name__ == '__main__':
    unittest.main()
