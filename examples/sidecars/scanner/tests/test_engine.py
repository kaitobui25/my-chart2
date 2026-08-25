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
    ProviderCapabilities,
    ScanFilters,
    ScanRequest,
)
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


class CountingLocalEodProvider(LocalEodProvider):
    def __init__(self) -> None:
        super().__init__()
        self.instrument_calls = 0
        self.snapshot_calls = 0
        self.history_calls = 0

    async def list_instruments(self, universes):
        self.instrument_calls += 1
        return await super().list_instruments(universes)

    async def snapshots(self, symbols):
        self.snapshot_calls += 1
        return await super().snapshots(symbols)

    async def daily_history(self, symbols, limit, since_time=None):
        self.history_calls += 1
        return await super().daily_history(symbols, limit, since_time)


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

    async def test_preloaded_vn_eod_scan_makes_zero_provider_data_calls(self):
        provider = CountingLocalEodProvider()
        engine = ScannerEngine(self.db, {'vn_eod': provider})
        start = 1_700_000_000
        candles = [
            Candle(
                start + index * 86400,
                10 + index * 0.05,
                11 + index * 0.05,
                9.5 + index * 0.05,
                10.7 + index * 0.05,
                1_000_000 + index,
                True,
            )
            for index in range(90)
        ]
        latest = candles[-1]
        self.db.import_eod_dataset(
            'vn_eod',
            [Instrument('vn_eod', 'LOCAL', 'Local', 'HOSE', 'STOCK')],
            {'LOCAL': candles},
            [MarketSnapshot('LOCAL', latest.close, latest.volume, None, latest.time)],
        )
        import_id = self.db.begin_eod_import('vn_eod', 'test', 'upto', True, None, None)
        self.db.finish_eod_import(import_id, status='complete', trade_date=latest.time, symbol_count=1, inserted_candle_count=len(candles))

        request = ScanRequest(
            source='vn_eod',
            universes=('HOSE',),
            filters=ScanFilters(price_min=1, volume_min=1),
            heikin_ashi=HeikinScan(timeframe='1w', green=False, no_lower_wick=False),
        )
        run_id = self.db.begin_scan('vn_eod', request.to_json())
        state = await engine.execute(run_id, request)

        self.assertEqual(state.status, 'complete')
        self.assertEqual(provider.instrument_calls, 0)
        self.assertEqual(provider.snapshot_calls, 0)
        self.assertEqual(provider.history_calls, 0)
        audit = self.db.get_scan(run_id)
        self.assertEqual(audit['universe_count'], 1)
        self.assertEqual(audit['stage1_count'], 1)
        self.assertEqual(audit['history_refresh_count'], 0)
        self.assertEqual(audit['stage2_count'], 1)
        self.assertEqual(audit['result_count'], 1)

    async def test_breakout_volume_scanner_runs_local_hose_and_skips_ha_rules(self):
        provider = CountingLocalEodProvider()
        engine = ScannerEngine(self.db, {'vn_eod': provider})
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
                timestamp = int((monday + timedelta(days=day)).timestamp())
                candles.append(Candle(
                    timestamp,
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
            [
                Instrument('vn_eod', 'BREAK', 'Breakout', 'HOSE', 'STOCK'),
                Instrument('vn_eod', 'OTHER', 'Other', 'HNX', 'STOCK'),
            ],
            {'BREAK': candles, 'OTHER': candles},
            [
                MarketSnapshot('BREAK', latest.close, latest.volume, None, latest.time),
                MarketSnapshot('OTHER', latest.close, latest.volume, None, latest.time),
            ],
        )
        import_id = self.db.begin_eod_import('vn_eod', 'test', 'upto', True, None, None)
        self.db.finish_eod_import(
            import_id,
            status='complete',
            trade_date=latest.time,
            symbol_count=2,
            inserted_candle_count=len(candles) * 2,
        )

        request = ScanRequest(
            source='vn_eod',
            universes=('HNX',),
            filters=ScanFilters(price_min=999_999_999, volume_min=999_999_999),
            heikin_ashi=HeikinScan(
                timeframe='1M',
                green=True,
                no_lower_wick=True,
                close_change_pct_min=999,
                candle='current',
            ),
            breakout_volume=BreakoutVolumeScan(enabled=True),
        )
        run_id = self.db.begin_scan('vn_eod', request.to_json())
        state = await engine.execute(run_id, request)

        self.assertEqual(state.status, 'complete')
        self.assertEqual(provider.instrument_calls, 0)
        self.assertEqual(provider.snapshot_calls, 0)
        self.assertEqual(provider.history_calls, 0)
        self.assertEqual(len(state.results), 1)
        self.assertEqual(state.results[0]['symbol'], 'BREAK')
        self.assertEqual(state.results[0]['mode'], 'breakout_volume')
        self.assertEqual(state.results[0]['candleKind'], 'closed')
        self.assertEqual(state.results[0]['signalState'], 'NEW')
        self.assertGreaterEqual(state.results[0]['rvol'], 2.5)
        audit = self.db.get_scan(run_id)
        self.assertEqual(audit['stage1_count'], 1)
        self.assertEqual(audit['result_count'], 1)

    async def test_preloaded_vn_eod_empty_database_fails_clearly(self):
        provider = CountingLocalEodProvider()
        engine = ScannerEngine(self.db, {'vn_eod': provider})
        request = ScanRequest(
            source='vn_eod',
            universes=('HOSE',),
            filters=ScanFilters(),
            heikin_ashi=HeikinScan(timeframe='1w', green=False, no_lower_wick=False),
        )
        run_id = self.db.begin_scan('vn_eod', request.to_json())
        state = await engine.execute(run_id, request)
        self.assertEqual(state.status, 'error')
        self.assertIn('no local EOD data', state.error or '')
        self.assertEqual(provider.instrument_calls, 0)
        self.assertEqual(provider.snapshot_calls, 0)
        self.assertEqual(provider.history_calls, 0)


if __name__ == '__main__':
    unittest.main()
