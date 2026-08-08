from __future__ import annotations

import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from db import ScannerDB
from models import Instrument, MarketSnapshot, ScanFilters


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
        rows = self.db.stage1_candidates('fiinquant', ('HOSE',), ScanFilters(price_min=10_000))
        self.assertEqual([row['symbol'] for row in rows], ['AAA'])
        self.assertIsNone(rows[0]['market_cap'])

    def test_market_cap_null_rejected_when_filter_on(self):
        rows = self.db.stage1_candidates(
            'fiinquant', ('HOSE',), ScanFilters(price_min=10_000, market_cap_min=1)
        )
        self.assertEqual(rows, [])

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
