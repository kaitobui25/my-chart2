from __future__ import annotations

import asyncio
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from db import ScannerDB
from heikin_ashi import HA_ALGO_VERSION, compute_latest_metrics
from models import ScanRequest, ScanResult
from providers import ScannerProvider

INSTRUMENT_TTL_SECONDS = 6 * 3600
HISTORY_BOOTSTRAP_BARS = 800
HISTORY_RETAIN_BARS = 1000
HISTORY_INCREMENT_OVERLAP_SECONDS = 4 * 86400


@dataclass
class ScanExecution:
    run_id: int
    status: str = 'running'
    results: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    error: str | None = None


class RequestPlanner:
    """Provider-level single-flight for bulk refresh work."""

    def __init__(self) -> None:
        self._provider_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

    def provider_lock(self, provider_id: str) -> asyncio.Lock:
        return self._provider_locks[provider_id]


class ScannerEngine:
    def __init__(self, db: ScannerDB, providers: dict[str, ScannerProvider]) -> None:
        self.db = db
        self.providers = providers
        self.planner = RequestPlanner()

    async def execute(
        self,
        run_id: int,
        request: ScanRequest,
        progress: Callable[[ScanExecution], Awaitable[None]] | None = None,
    ) -> ScanExecution:
        state = ScanExecution(run_id=run_id)
        provider = self.providers.get(request.source)
        if provider is None:
            return await self._fail(state, f'provider not configured: {request.source}', progress)
        if not provider.capabilities.available:
            return await self._fail(
                state,
                provider.capabilities.detail or f'{request.source} unavailable',
                progress,
            )

        async with self.planner.provider_lock(request.source):
            try:
                await self._refresh_instruments(provider, request)
                active_symbols = await asyncio.to_thread(
                    self.db.list_active_symbols, request.source
                )
                await asyncio.to_thread(
                    self.db.update_scan,
                    run_id,
                    universe_count=len(active_symbols),
                )
                await self._notify(state, progress)

                await self._refresh_snapshots(
                    provider, request.source, active_symbols, state
                )
                candidates = await asyncio.to_thread(
                    self.db.stage1_candidates,
                    request.source,
                    request.universes,
                    request.filters,
                )
                await asyncio.to_thread(
                    self.db.update_scan,
                    run_id,
                    stage1_count=len(candidates),
                )
                await self._notify(state, progress)

                refresh_count = await self._refresh_candidate_history(
                    provider, candidates, state
                )
                await asyncio.to_thread(
                    self.db.update_scan,
                    run_id,
                    history_refresh_count=refresh_count,
                )

                evaluated_ids = await self._refresh_ha(provider, request, candidates)
                await asyncio.to_thread(
                    self.db.update_scan,
                    run_id,
                    stage2_count=len(evaluated_ids),
                )
                await self._notify(state, progress)

                final_rows = await asyncio.to_thread(
                    self.db.query_final,
                    request.source,
                    request.filters,
                    request.heikin_ashi,
                    evaluated_ids,
                )
                now = int(time.time())
                results: list[dict] = []
                for row in final_rows:
                    stale = (
                        now - int(row.get('fetched_at') or 0)
                        > provider.capabilities.snapshot_ttl_seconds * 2
                    )
                    warnings = ['snapshot stale'] if stale else []
                    results.append(ScanResult(
                        instrument_id=int(row['instrument_id']),
                        symbol=str(row['symbol']),
                        name=str(row['name'] or ''),
                        exchange=str(row['exchange'] or ''),
                        price=None if row['price'] is None else float(row['price']),
                        volume=None if row['volume'] is None else float(row['volume']),
                        market_cap=None if row['market_cap'] is None else float(row['market_cap']),
                        timeframe=request.heikin_ashi.timeframe,
                        candle_kind=request.heikin_ashi.candle,
                        candle_time=int(row['candle_time']),
                        ha_open=float(row['ha_open']),
                        ha_high=float(row['ha_high']),
                        ha_low=float(row['ha_low']),
                        ha_close=float(row['ha_close']),
                        green=bool(row['green']),
                        no_lower_wick=bool(row['no_lower_wick']),
                        ha_close_change_pct=(
                            None
                            if row['ha_close_change_pct'] is None
                            else float(row['ha_close_change_pct'])
                        ),
                        ha_body_pct=(
                            None if row['ha_body_pct'] is None else float(row['ha_body_pct'])
                        ),
                        source_last_time=int(row['source_last_time']),
                        computed_at=int(row['computed_at']),
                        stale=stale,
                        warnings=warnings,
                    ).to_json())
                state.results = results
                state.status = 'complete'
                await asyncio.to_thread(
                    self.db.update_scan,
                    run_id,
                    result_count=len(results),
                    finished_at=int(time.time()),
                    status='complete',
                    error=None,
                )
                await self._notify(state, progress)
                return state
            except Exception as exc:  # noqa: BLE001
                return await self._fail(state, str(exc)[:500], progress)

    async def _refresh_instruments(
        self,
        provider: ScannerProvider,
        request: ScanRequest,
    ) -> None:
        age = await asyncio.to_thread(self.db.instrument_age, request.source)
        if age is not None and age <= INSTRUMENT_TTL_SECONDS:
            return
        instruments = await provider.list_instruments(provider.capabilities.default_universes)
        await asyncio.to_thread(
            self.db.upsert_instruments,
            request.source,
            instruments,
            True,
        )

    async def _refresh_snapshots(
        self,
        provider: ScannerProvider,
        provider_id: str,
        active_symbols: list[str],
        state: ScanExecution,
    ) -> None:
        coverage = await asyncio.to_thread(self.db.snapshot_coverage, provider_id)
        oldest = coverage.get('oldest_fetched_at')
        complete = (
            coverage.get('active_count') == coverage.get('snapshot_count')
            and int(coverage.get('active_count') or 0) > 0
        )
        fresh = (
            oldest is not None
            and int(time.time()) - int(oldest)
            <= provider.capabilities.snapshot_ttl_seconds
        )
        if complete and fresh:
            return
        try:
            snapshots = await provider.snapshots(active_symbols)
            await asyncio.to_thread(
                self.db.upsert_snapshots,
                provider_id,
                snapshots,
            )
            if len(snapshots) < len(active_symbols):
                state.warnings.append(
                    f'{provider_id}: snapshot returned '
                    f'{len(snapshots)}/{len(active_symbols)} symbols'
                )
        except Exception as exc:  # noqa: BLE001
            if int(coverage.get('snapshot_count') or 0) == 0:
                raise
            state.warnings.append(
                f'{provider_id}: snapshot refresh failed; using cached values: '
                f'{str(exc)[:180]}'
            )

    async def _refresh_candidate_history(
        self,
        provider: ScannerProvider,
        candidates: list[dict],
        state: ScanExecution,
    ) -> int:
        now = int(time.time())
        bootstrap: list[dict] = []
        incremental: list[dict] = []
        for candidate in candidates:
            instrument_id = int(candidate['instrument_id'])
            candle_state = await asyncio.to_thread(
                self.db.candle_state,
                instrument_id,
                '1d',
            )
            # The first request asks for a deep warm-up. If a newly listed asset
            # legitimately has fewer bars, it is still considered bootstrapped;
            # otherwise every scan would re-download the same short history.
            if candle_state is None:
                bootstrap.append(candidate)
                continue
            if (
                now - int(candle_state['updated_at'])
                > provider.capabilities.history_ttl_seconds
            ):
                next_candidate = dict(candidate)
                next_candidate['_last_time'] = int(candle_state['last_time'])
                incremental.append(next_candidate)

        refreshed = 0
        if bootstrap:
            symbols = [str(item['symbol']) for item in bootstrap]
            try:
                history = await provider.daily_history(
                    symbols,
                    HISTORY_BOOTSTRAP_BARS,
                )
                refreshed += await self._persist_history(
                    provider.capabilities.id,
                    bootstrap,
                    history,
                )
            except Exception as exc:  # noqa: BLE001
                state.warnings.append(
                    f'{provider.capabilities.id}: bootstrap history refresh failed: '
                    f'{str(exc)[:180]}'
                )

        if incremental:
            symbols = [str(item['symbol']) for item in incremental]
            since_time = max(
                0,
                min(int(item['_last_time']) for item in incremental)
                - HISTORY_INCREMENT_OVERLAP_SECONDS,
            )
            try:
                history = await provider.daily_history(
                    symbols,
                    64,
                    since_time=since_time,
                )
                refreshed += await self._persist_history(
                    provider.capabilities.id,
                    incremental,
                    history,
                )
            except Exception as exc:  # noqa: BLE001
                state.warnings.append(
                    f'{provider.capabilities.id}: incremental history refresh failed; '
                    f'using cache: {str(exc)[:180]}'
                )
        return refreshed

    async def _persist_history(
        self,
        provider_id: str,
        candidates: list[dict],
        history: dict[str, list],
    ) -> int:
        ids = await asyncio.to_thread(
            self.db.instrument_ids,
            provider_id,
            [str(item['symbol']) for item in candidates],
        )
        refreshed = 0
        for symbol, candles in history.items():
            instrument_id = ids.get(symbol)
            if instrument_id is None or not candles:
                continue
            await asyncio.to_thread(
                self.db.upsert_candles,
                instrument_id,
                candles,
                '1d',
                HISTORY_RETAIN_BARS,
            )
            refreshed += 1
        return refreshed

    async def _refresh_ha(
        self,
        provider: ScannerProvider,
        request: ScanRequest,
        candidates: list[dict],
    ) -> list[int]:
        evaluated: list[int] = []
        minimum_daily = 20 if request.heikin_ashi.timeframe == '1w' else 60
        for candidate in candidates:
            instrument_id = int(candidate['instrument_id'])
            daily = await asyncio.to_thread(
                self.db.read_candles,
                instrument_id,
                '1d',
                HISTORY_RETAIN_BARS,
            )
            if len(daily) < minimum_daily:
                continue

            # Recompute Stage-2 HA from local SQLite every scan. This is cheap
            # compared with network I/O and, crucially, catches an in-progress
            # daily candle whose OHLC changed while its timestamp stayed the same.
            metrics = compute_latest_metrics(
                daily,
                request.heikin_ashi.timeframe,
                provider.capabilities.timezone,
                continuous_market=provider.capabilities.continuous_market,
            )
            selected = metrics.get(request.heikin_ashi.candle)
            if selected is None:
                continue
            await asyncio.to_thread(
                self.db.upsert_ha_metrics,
                instrument_id,
                metrics.values(),
                HA_ALGO_VERSION,
            )
            evaluated.append(instrument_id)
        return evaluated

    async def _fail(
        self,
        state: ScanExecution,
        message: str,
        progress: Callable[[ScanExecution], Awaitable[None]] | None,
    ) -> ScanExecution:
        state.status = 'error'
        state.error = message
        await asyncio.to_thread(
            self.db.update_scan,
            state.run_id,
            finished_at=int(time.time()),
            status='error',
            error=message,
        )
        await self._notify(state, progress)
        return state

    @staticmethod
    async def _notify(
        state: ScanExecution,
        progress: Callable[[ScanExecution], Awaitable[None]] | None,
    ) -> None:
        if progress is not None:
            await progress(state)
