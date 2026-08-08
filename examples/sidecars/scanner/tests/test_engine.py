from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from db import ScannerDB
from engine import ScannerEngine
from models import Candle, HeikinScan, Instrument, MarketSnapshot, ProviderCapabilities, ScanFilters, ScanRequest
from providers import ScannerProvider


class FakeProvider(ScannerProvider):
    def __init__(self) -> None:
        self.history_symbols: list[str] = []
        self.capabilities = ProviderCapabilities(
            id='fiinquant',
            label='Fake FiinQuant',
            market_cap=False,
            bulk_snapshot=True,
            bulk_history=True,
            universes=('HOSE',),
            default_universes=('HOSE',),
            timezone='Asia/Ho_Chi_Minh',
            max_history_concurrency=1,
            continuous_market=False,
            snapshot_ttl_seconds=3600,
            history_ttl_seconds=3600,
        )

    async def list_instruments(self, universes):
        return [
            Instrument('fiinquant', 'GOOD', 'Good', 'HOSE', 'STOCK'),
            Instrument('fiinquant', 'JUNK', 'Junk', 'HOSE', 'STOCK'),
        ]

    async def snapshots(self, symbols):
        return [
            MarketSnapshot('GOOD', 50_000, 2_000_000, None, 1_700_000_000),
            MarketSnapshot('JUNK', 2_000, 10, None, 1_700_000_000),
        ]

    async def daily_history(self, symbols, limit, since_time=None):
        self.history_symbols.extend(symbols)
        start = 1_600_000_000
        return {
            symbol: [
                Candle(start + index * 86400, 10 + index * 0.01, 11 + index * 0.01,
                       9 + index * 0.01, 10.5 + index * 0.01, 1000 + index, True)
                for index in range(limit)
            ]
            for symbol in symbols
        }


class EngineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = ScannerDB(Path(self.temp.name) / 'scanner.db', ROOT / 'migrations')
        self.provider = FakeProvider()
        self.engine = ScannerEngine(self.db, {'fiinquant': self.provider})

    async def asyncTearDown(self):
        self.db.close()
        self.temp.cleanup()

    async def test_stage1_filters_junk_before_history(self):
        request = ScanRequest(
            source='fiinquant',
            universes=('HOSE',),
            filters=ScanFilters(price_min=10_000, volume_min=100_000),
            heikin_ashi=HeikinScan(timeframe='1w', green=False, no_lower_wick=False),
        )
        run_id = self.db.begin_scan('fiinquant', request.to_json())
        state = await self.engine.execute(run_id, request)
        self.assertEqual(state.status, 'complete')
        self.assertEqual(set(self.provider.history_symbols), {'GOOD'})
        audit = self.db.get_scan(run_id)
        self.assertEqual(audit['universe_count'], 2)
        self.assertEqual(audit['stage1_count'], 1)


if __name__ == '__main__':
    unittest.main()
