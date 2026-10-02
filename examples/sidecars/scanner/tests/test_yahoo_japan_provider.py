from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from providers import YahooJapanProvider  # noqa: E402
from models import ScanRequest  # noqa: E402


class FakeYahooJapanProvider(YahooJapanProvider):
    def __init__(self) -> None:
        super().__init__(base_url='http://example.invalid')
        self.calls: list[tuple[str, str, dict | None]] = []

    async def _json(self, method: str, path: str, *, payload=None):  # type: ignore[override]
        self.calls.append((method, path, payload))
        if path == '/scanner/universe':
            return {
                'instruments': [
                    {
                        'symbol': '7203.T',
                        'name': 'Toyota Motor',
                        'exchange': 'JPX',
                        'assetType': 'EQUITY',
                        'price': 3000,
                        'volume': 12_000_000,
                        'marketCap': 45_000_000_000_000,
                        'dataTime': 1_800_000_000,
                    },
                    {
                        'symbol': '9984.T',
                        'name': 'SoftBank Group',
                        'exchange': 'JPX',
                        'assetType': 'EQUITY',
                        'price': 6500,
                        'volume': 5_000_000,
                        'marketCap': 10_000_000_000_000,
                        'dataTime': 1_800_000_000,
                    },
                ]
            }
        if path == '/scanner/history':
            assert payload is not None
            return {
                'candles': {
                    symbol: [
                        {
                            'time': 1_700_000_000,
                            'open': 100,
                            'high': 110,
                            'low': 95,
                            'close': 105,
                            'volume': 1_000,
                            'isClosed': True,
                        }
                    ]
                    for symbol in payload['symbols']
                }
            }
        raise AssertionError(f'unexpected path: {path}')


class YahooJapanProviderTests(unittest.IsolatedAsyncioTestCase):
    def test_scan_request_accepts_yahoo_japan_source(self) -> None:
        request = ScanRequest.from_json({
            'source': 'yfinance_jp',
            'universes': ['JPX'],
            'filters': {},
            'heikinAshi': {
                'enabled': True,
                'timeframe': '1M',
                'green': True,
                'noLowerWick': True,
                'candle': 'current',
            },
        })
        self.assertEqual(request.source, 'yfinance_jp')
        self.assertEqual(request.universes, ('JPX',))

    async def test_capabilities_route_scanner_results_back_to_yahoo_chart(self) -> None:
        provider = FakeYahooJapanProvider()
        self.assertEqual(provider.capabilities.id, 'yfinance_jp')
        self.assertEqual(provider.capabilities.chart_provider, 'yfinance-jp')
        self.assertEqual(provider.capabilities.universes, ('JPX',))
        self.assertTrue(provider.capabilities.market_cap)
        self.assertTrue(provider.capabilities.universes_are_exchanges)

    async def test_reuses_universe_payload_for_instruments_and_snapshots(self) -> None:
        provider = FakeYahooJapanProvider()

        instruments = await provider.list_instruments(('JPX',))
        snapshots = await provider.snapshots([item.symbol for item in instruments])

        self.assertEqual([item.symbol for item in instruments], ['7203.T', '9984.T'])
        self.assertEqual([item.symbol for item in snapshots], ['7203.T', '9984.T'])
        self.assertEqual(snapshots[0].market_cap, 45_000_000_000_000)
        self.assertEqual(
            [(method, path) for method, path, _ in provider.calls],
            [('GET', '/scanner/universe')],
        )

    async def test_daily_history_uses_batch_endpoint(self) -> None:
        provider = FakeYahooJapanProvider()
        history = await provider.daily_history(['7203.T', '9984.T'], 800, since_time=1_600_000_000)

        self.assertEqual(set(history), {'7203.T', '9984.T'})
        self.assertEqual(history['7203.T'][0].close, 105)
        self.assertEqual(provider.calls[-1][0:2], ('POST', '/scanner/history'))
        self.assertEqual(provider.calls[-1][2], {
            'symbols': ['7203.T', '9984.T'],
            'limit': 800,
            'sinceTime': 1_600_000_000,
        })


if __name__ == '__main__':
    unittest.main()
