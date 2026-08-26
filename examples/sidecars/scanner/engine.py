from __future__ import annotations

import asyncio
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from breakout_volume import evaluate_breakout_volume
from db import ScannerDB
from heikin_ashi import HA_ALGO_VERSION, compute_latest_metrics
from models import ScanFilters, ScanRequest, ScanResult
from price_units import KVND, kvnd_to_vnd
from providers import ScannerProvider

INSTRUMENT_TTL_SECONDS = 6 * 3600
HISTORY_BOOTSTRAP_BARS = 800
HISTORY_RETAIN_BARS = 1000
HISTORY_INCREMENT_OVERLAP_SECONDS = 4 * 86400


def _cafef_db_filters(filters: ScanFilters) -> ScanFilters:
    """Keep CafeF price filtering out of raw kVND SQL comparisons."""
    return ScanFilters(
        price_min=None,
        price_max=None,
        volume_min=filters.volume_min,
        volume_max=filters.volume_max,
        market_cap_min=filters.market_cap_min,
        market_cap_max=filters.market_cap_max,
    )


def _cafef_candidates_in_vnd(candidates: list[dict], filters: ScanFilters) -> list[dict]:
    """Convert CafeF snapshot price_kvnd to VND before applying price filters."""
    normalized: list[dict] = []
    for candidate in candidates:
        raw_price = candidate.get('price')
        if raw_price is None:
            if filters.price_min is not None or filters.price_max is not None:
                continue
            normalized.append(candidate)
            continue
        price_kvnd = float(raw_price)
        price_vnd = price_kvnd * KVND
        if filters.price_min is not None and price_vnd < filters.price_min:
            continue
        if filters.price_max is not None and price_vnd > filters.price_max:
            continue
        next_candidate = dict(candidate)
        next_candidate['price_kvnd'] = price_kvnd
        next_candidate['price'] = price_vnd
        normalized.append(next_candidate)
    return normalized


@dataclass
class ScanExecution:
    run_id: int
    status: str = 'running'
    results: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    error: str | None = None
    progress_pct: int = 0


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
                state.progress_pct = 5
                await self._notify(state, progress)

                if provider.capabilities.refresh_mode == 'network':
                    await self._refresh_instruments(provider, request)
                    state.progress_pct = 10
                    await self._notify(state, progress)

                active_symbols = await asyncio.to_thread(
                    self.db.list_active_symbols, request.source
                )
                if provider.capabilities.refresh_mode == 'preloaded' and not active_symbols:
                    raise RuntimeError(
                        f'{provider.capabilities.label}: no local EOD data. '
                        'Import CafeF adjusted EOD/Upto data first.'
                    )
                await asyncio.to_thread(
                    self.db.update_scan,
                    run_id,
                    universe_count=len(active_symbols),
                )
                state.progress_pct = 15
                await self._notify(state, progress)

                if provider.capabilities.refresh_mode == 'network':
                    await self._refresh_snapshots(
                        provider, request.source, active_symbols, state
                    )
                    state.progress_pct = 25
                    await self._notify(state, progress)

                breakout_enabled = request.breakout_volume.enabled
                candidate_universes = ('HOSE',) if breakout_enabled else request.universes
                candidate_filters = ScanFilters() if breakout_enabled else request.filters
                db_filters = (
                    _cafef_db_filters(candidate_filters)
                    if request.source == 'vn_eod'
                    else candidate_filters
                )
                candidates = await asyncio.to_thread(
                    self.db.stage1_candidates,
                    request.source,
                    candidate_universes,
                    db_filters,
                    provider.capabilities.universes_are_exchanges,
                )
                if request.source == 'vn_eod':
                    candidates = _cafef_candidates_in_vnd(candidates, candidate_filters)
                await asyncio.to_thread(
                    self.db.update_scan,
                    run_id,
                    stage1_count=len(candidates),
                )
                state.progress_pct = 30
                await self._notify(state, progress)

                if provider.capabilities.refresh_mode == 'network':
                    state.progress_pct = 35
                    await self._notify(state, progress)
                    refresh_count = await self._refresh_candidate_history(
                        provider, candidates, state
                    )
                else:
                    refresh_count = 0
                await asyncio.to_thread(
                    self.db.update_scan,
                    run_id,
                    history_refresh_count=refresh_count,
                )
                state.progress_pct = 45
                await self._notify(state, progress)

                if breakout_enabled:
                    results, evaluated_count = await self._run_breakout_volume(
                        provider,
                        request,
                        candidates,
                        state,
                    )
                    await asyncio.to_thread(
                        self.db.update_scan,
                        run_id,
                        stage2_count=evaluated_count,
                    )
                    state.progress_pct = 95
                    await self._notify(state, progress)
                    return await self._complete(state, results, progress)

                evaluated_ids = await self._refresh_ha(
                    provider,
                    request,
                    candidates,
                    state,
                )
                await asyncio.to_thread(
                    self.db.update_scan,
                    run_id,
                    stage2_count=len(evaluated_ids),
                )
                state.progress_pct = 95
                await self._notify(state, progress)

                final_rows = await asyncio.to_thread(
                    self.db.query_final,
                    request.source,
                    request.filters,
                    request.heikin_ashi,
                    evaluated_ids,
                )
                now = int(time.time())
                import_state = None
                if provider.capabilities.refresh_mode == 'preloaded':
                    import_state = await asyncio.to_thread(
                        self.db.latest_successful_import, request.source
                    )
                    if import_state is None:
                        state.warnings.append(
                            f'{provider.capabilities.label}: local data has no successful import audit metadata'
                        )

                results: list[dict] = []
                for row in final_rows:
                    if provider.capabilities.refresh_mode == 'preloaded':
                        reference_time = int(
                            (import_state or {}).get('trade_date')
                            or row.get('data_time')
                            or row.get('fetched_at')
                            or 0
                        )
                        stale = now - reference_time > provider.capabilities.snapshot_ttl_seconds
                        warnings = ['EOD data stale'] if stale else []
                    else:
                        stale = (
                            now - int(row.get('fetched_at') or 0)
                            > provider.capabilities.snapshot_ttl_seconds * 2
                        )
                        warnings = ['snapshot stale'] if stale else []
                    price = None if row['price'] is None else float(row['price'])
                    if request.source == 'vn_eod' and price is not None:
                        price = price * KVND
                    payload = ScanResult(
                        instrument_id=int(row['instrument_id']),
                        symbol=str(row['symbol']),
                        name=str(row['name'] or ''),
                        exchange=str(row['exchange'] or ''),
                        price=price,
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
                    ).to_json()
                    payload['mode'] = 'heikin_ashi'
                    results.append(payload)
                return await self._complete(state, results, progress)
            except Exception as exc:  # noqa: BLE001
                return await self._fail(state, str(exc)[:500], progress)

    async def _run_breakout_volume(
        self,
        provider: ScannerProvider,
        request: ScanRequest,
        candidates: list[dict],
        state: ScanExecution,
    ) -> tuple[list[dict], int]:
        now = int(time.time())
        import_state = await asyncio.to_thread(
            self.db.latest_successful_import, request.source
        )
        if import_state is None:
            state.warnings.append(
                f'{provider.capabilities.label}: local data has no successful import audit metadata'
            )
        reference_time = int((import_state or {}).get('trade_date') or 0)
        stale = (
            reference_time == 0
            or now - reference_time > provider.capabilities.snapshot_ttl_seconds
        )
        warnings = ['EOD data stale'] if stale else []

        results: list[dict] = []
        evaluated = 0
        total = max(1, len(candidates))
        for index, candidate in enumerate(candidates, start=1):
            instrument_id = int(candidate['instrument_id'])
            daily = await asyncio.to_thread(
                self.db.read_candles,
                instrument_id,
                '1d',
                HISTORY_RETAIN_BARS,
            )
            if daily:
                signal = evaluate_breakout_volume(
                    daily,
                    provider.capabilities.timezone,
                    request.breakout_volume,
                    now=now,
                )
                evaluated += 1
                if signal is not None:
                    source_last_time = max(item.time for item in daily)
                    results.append({
                        'mode': 'breakout_volume',
                        'instrumentId': instrument_id,
                        'symbol': str(candidate['symbol']),
                        'name': str(candidate.get('name') or ''),
                        'exchange': str(candidate.get('exchange') or ''),
                        'price': signal.close * KVND,
                        'volume': signal.volume,
                        'marketCap': None,
                        'timeframe': '1w',
                        'candleKind': 'closed',
                        'candleTime': signal.signal_time,
                        'weeklyChangePct': signal.weekly_change_pct,
                        'rvol': signal.rvol,
                        'breakoutLevel': signal.breakout_level * KVND,
                        'tradedValue': signal.traded_value,
                        'medianTradedValue': signal.median_traded_value,
                        'medianVolume': signal.median_volume,
                        'strong': signal.strong,
                        'signalState': signal.signal_state,
                        'nextWeekTime': signal.next_week_time,
                        'nextWeekVolume': signal.next_week_volume,
                        'nextWeekRvol': signal.next_week_rvol,
                        'nextWeekClose': (
                            None
                            if signal.next_week_close is None
                            else signal.next_week_close * KVND
                        ),
                        'nextWeekHoldsBreakout': signal.next_week_holds_breakout,
                        'sourceLastTime': source_last_time,
                        'computedAt': now,
                        'stale': stale,
                        'warnings': list(warnings),
                    })
            state.progress_pct = min(95, 45 + round(index / total * 50))
        results.sort(key=lambda row: (-float(row['rvol']), str(row['symbol'])))
        return results, evaluated

    async def _complete(
        self,
        state: ScanExecution,
        results: list[dict],
        progress: Callable[[ScanExecution], Awaitable[None]] | None,
    ) -> ScanExecution:
        state.results = results
        state.status = 'complete'
        state.progress_pct = 100
        await asyncio.to_thread(
            self.db.update_scan,
            state.run_id,
            result_count=len(results),
            finished_at=int(time.time()),
            status='complete',
            error=None,
        )
        await self._notify(state, progress)
        return state

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
        state: ScanExecution,
    ) -> list[int]:
        evaluated: list[int] = []
        minimum_daily = 20 if request.heikin_ashi.timeframe == '1w' else 60
        total = max(1, len(candidates))
        for index, candidate in enumerate(candidates, start=1):
            instrument_id = int(candidate['instrument_id'])
            daily = await asyncio.to_thread(
                self.db.read_candles,
                instrument_id,
                '1d',
                HISTORY_RETAIN_BARS,
            )
            if len(daily) >= minimum_daily:
                metrics = compute_latest_metrics(
                    daily,
                    request.heikin_ashi.timeframe,
                    provider.capabilities.timezone,
                    continuous_market=provider.capabilities.continuous_market,
                )
                selected = metrics.get(request.heikin_ashi.candle)
                if selected is not None:
                    await asyncio.to_thread(
                        self.db.upsert_ha_metrics,
                        instrument_id,
                        metrics.values(),
                        HA_ALGO_VERSION,
                    )
                    evaluated.append(instrument_id)
            state.progress_pct = min(95, 45 + round(index / total * 50))
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
