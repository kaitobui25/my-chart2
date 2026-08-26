from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine import _cafef_candidates_in_vnd, _cafef_db_filters
from models import ScanFilters
from price_units import KVND, kvnd_to_vnd


class CafeFPriceUnitTests(unittest.TestCase):
    def test_kvnd_contract(self):
        self.assertEqual(KVND, 1_000.0)
        self.assertEqual(kvnd_to_vnd(7.61), 7_610.0)
        self.assertEqual(kvnd_to_vnd(8.89), 8_890.0)

    def test_scanner02_filters_cafef_price_after_kvnd_conversion(self):
        raw = [{'symbol': 'HTN', 'price': 8.89, 'volume': 679_400.0}]
        filters = ScanFilters(price_min=8_000, price_max=9_000, volume_min=500_000)
        db_filters = _cafef_db_filters(filters)
        self.assertIsNone(db_filters.price_min)
        self.assertIsNone(db_filters.price_max)
        self.assertEqual(db_filters.volume_min, 500_000)

        rows = _cafef_candidates_in_vnd(raw, filters)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['price_kvnd'], 8.89)
        self.assertEqual(rows[0]['price'], 8.89 * KVND)

        rejected = _cafef_candidates_in_vnd(raw, ScanFilters(price_min=9_000))
        self.assertEqual(rejected, [])


if __name__ == '__main__':
    unittest.main()
