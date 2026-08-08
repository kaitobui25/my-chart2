from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from providers import FiinQuantProvider


class _DataWrapper:
    def __init__(self, data):
        self.data = data


class _MethodWrapper:
    def __init__(self, data):
        self._data = data

    def get_data(self):
        return self._data


class ProviderTests(unittest.TestCase):
    def test_fiinquant_records_accept_data_wrapper(self):
        records = FiinQuantProvider._raw_records(_DataWrapper([
            {'ticker': 'VIC', 'close': 100},
            {'ticker': 'FPT', 'close': 200},
        ]))
        self.assertEqual([row['ticker'] for row in records], ['VIC', 'FPT'])

    def test_fiinquant_records_accept_get_data_wrapper(self):
        records = FiinQuantProvider._raw_records(_MethodWrapper([
            {'Ticker': 'VHM', 'Close': 90},
        ]))
        self.assertEqual(records[0]['Ticker'], 'VHM')


if __name__ == '__main__':
    unittest.main()
