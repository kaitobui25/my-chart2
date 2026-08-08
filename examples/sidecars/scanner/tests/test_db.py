from __future__ import annotations

import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from db import ScannerDB
from models import Candle, Instrument, MarketSnapshot, ScanFilters


class ScannerDBTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.db = ScannerDB(self.base / 'scanner.db', ROOT / 'migrations')
        ids = self.db.upsert_instruments(
            'fiinquant',
            [Instrument('fiinquant', 'AAA', 'AAA', 'HOSE', 'STOCK')],
        )
        self.instrument_id = ids['AAA']
        self.db.upsert_snapshots(
            'fiinquant',
            [MarketSnapshot('AAA', 25_000, 1_000_000, None, 1_700_000_000)],
        )

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def test_market_cap_null_allowed_when_filter_off(self):
        rows = self.db.stage1_candidates('fiinquant', ('HOSE',), ScanFilters(price_min=10_000), True)
        self.assertEqual([row['symbol'] for row in rows], ['AAA'])
        self.assertIsNone(rows[0]['market_cap'])

    def test_market_cap_null_rejected_when_filter_on(self):
        rows = self.db.stage1_candidates(
            'fiinquant', ('HOSE',), ScanFilters(price_min=10_000, market_cap_min=1), True
        )
        self.assertEqual(rows, [])

    def test_exchange_universe_filter_is_provider_neutral(self):
        self.db.upsert_instruments(
            'vn_eod',
            [
                Instrument('vn_eod', 'HOS', 'HOS', 'HOSE', 'STOCK'),
                Instrument('vn_eod', 'HNX', 'HNX', 'HNX', 'STOCK'),
            ],
        )
        self.db.upsert_snapshots(
            'vn_eod',
            [
                MarketSnapshot('HOS', 20_000, 1000, None, 1_700_000_000),
                MarketSnapshot('HNX', 20_000, 1000, None, 1_700_000_000),
            ],
        )
        rows = self.db.stage1_candidates('vn_eod', ('HOSE',), ScanFilters(), True)
        self.assertEqual([row['symbol'] for row in rows], ['HOS'])

    def test_bulk_eod_import_updates_adjusted_history(self):
        first = [Instrument('vn_eod', 'AAA', 'AAA', 'HOSE', 'STOCK')]
        self.db.import_eod_dataset(
            'vn_eod',
            first,
            {'AAA': [Candle(1_700_000_000, 10, 12, 9, 11, 1000, True)]},
            [MarketSnapshot('AAA', 11, 1000, None, 1_700_000_000)],
        )
        self.db.import_eod_dataset(
            'vn_eod',
            first,
            {'AAA': [Candle(1_700_000_000, 9, 11, 8, 10, 900, True)]},
            [MarketSnapshot('AAA', 10, 900, None, 1_700_000_000)],
        )
        instrument_id = self.db.instrument_ids('vn_eod', ['AAA'])['AAA']
        candles = self.db.read_candles(instrument_id)
        self.assertEqual(len(candles), 1)
        self.assertEqual(candles[0].open, 9)
        self.assertEqual(candles[0].close, 10)

    def test_backup_is_valid_database(self):
        backup = self.base / 'backup.db'
        self.db.backup(backup)
        connection = sqlite3.connect(backup)
        try:
            count = connection.execute('SELECT COUNT(*) FROM instruments').fetchone()[0]
        finally:
            connection.close()
        self.assertEqual(count, 1)


if __name__ == '__main__':
    unittest.main()
