from __future__ import annotations

import asyncio
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


class _TickerClient:
    def __init__(self):
        self.calls = []

    def TickerList(self, **kwargs):
        self.calls.append(kwargs)
        payloads = {
            'VNINDEX': ['VIC', 'FPT'],
            'HNXIndex': [{'ticker': 'SHS', 'name': 'Sai Gon Ha Noi Securities'}],
            'UpcomIndex': _DataWrapper([{'Ticker': 'MCH'}]),
        }
        return payloads[kwargs['ticker']]


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

    def test_fiinquant_universes_use_sdk_index_names_and_keep_exchange(self):
        client = _TickerClient()
        provider = FiinQuantProvider('user', 'password')
        provider._client = client

        instruments = asyncio.run(provider.list_instruments(('HOSE', 'HNX', 'UPCOM')))

        self.assertEqual(client.calls, [
            {'ticker': 'VNINDEX'},
            {'ticker': 'HNXIndex'},
            {'ticker': 'UpcomIndex'},
        ])
        exchanges = {item.symbol: item.exchange for item in instruments}
        self.assertEqual(exchanges, {
            'FPT': 'HOSE',
            'MCH': 'UPCOM',
            'SHS': 'HNX',
            'VIC': 'HOSE',
        })

    def test_fiinquant_rejects_unknown_universe(self):
        client = _TickerClient()
        provider = FiinQuantProvider('user', 'password')
        provider._client = client

        with self.assertRaisesRegex(ValueError, 'unsupported FiinQuant universe'):
            asyncio.run(provider.list_instruments(('UNKNOWN',)))


if __name__ == '__main__':
    unittest.main()
