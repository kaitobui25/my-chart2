from __future__ import annotations

from models import Candle, Instrument, MarketSnapshot, ProviderCapabilities
from providers import ScannerProvider


class LocalEodProvider(ScannerProvider):
    """Scanner source backed entirely by preloaded SQLite EOD data."""

    def __init__(self) -> None:
        self.capabilities = ProviderCapabilities(
            id='vn_eod',
            label='VN EOD (CafeF)',
            market_cap=False,
            bulk_snapshot=False,
            bulk_history=False,
            universes=('HOSE', 'HNX', 'UPCOM'),
            default_universes=('HOSE', 'HNX', 'UPCOM'),
            timezone='Asia/Ho_Chi_Minh',
            max_history_concurrency=0,
            continuous_market=False,
            snapshot_ttl_seconds=5 * 86400,
            history_ttl_seconds=5 * 86400,
            refresh_mode='preloaded',
            detail='Import adjusted CafeF EOD/Upto data into scanner.db before scanning.',
        )

    @staticmethod
    def _unexpected_network_call() -> RuntimeError:
        return RuntimeError('vn_eod is preloaded; scanner execution must not request provider data')

    async def list_instruments(self, universes: tuple[str, ...]) -> list[Instrument]:
        raise self._unexpected_network_call()

    async def snapshots(self, symbols: list[str]) -> list[MarketSnapshot]:
        raise self._unexpected_network_call()

    async def daily_history(
        self,
        symbols: list[str],
        limit: int,
        since_time: int | None = None,
    ) -> dict[str, list[Candle]]:
        raise self._unexpected_network_call()
