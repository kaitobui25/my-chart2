# Scanner V1

Build a TradingView-style two-stage scanner for the workstation with Python/aiohttp + SQLite. Keep chart core provider-neutral.

## Requirements
- Sources: FiinQuant, Binance Spot, Binance USD-M.
- Cheap filters first: active/tradable, price, volume, optional market cap.
- Market cap may be NULL. NULL is never treated as zero; it only fails when an enabled market-cap constraint requires a value.
- Heikin Ashi scan chooses exactly one timeframe per scan: 1W OR 1M.
- HA filters: green, no lower wick, HA-close change vs previous HA close >= X%.
- Candle mode: current or last closed.
- Results can open the symbol in the active chart.

## Architecture
Workstation Scanner UI -> /scanner-api -> scanner sidecar -> request planner -> SQLite/provider adapters.

Providers expose capabilities (market-cap, bulk snapshot/history, timezone/calendar, concurrency) so scanner engine stays provider-neutral.

## Performance
1. **Stage 1 first:** use bulk/latest snapshots and SQL filters before any history request.
2. **Canonical 1D:** persist canonical `1d` candles for 1W/1M scans; derive week/month locally instead of requesting/storing duplicate 1W/1M history.
3. **Batch providers:** prefer bulk calls. FiinQuant uses ticker lists in batches; Binance uses bulk ticker endpoints for Stage 1.
4. **Request planner:** fetch only missing/stale candidate history, single-flight provider work, and use bounded concurrency.
5. **Network cache hard, compute cheap:** bootstrap daily history once, then request only overlapping recent/missing daily bars. Recompute the selected HA timeframe locally from SQLite for Stage-2 on each scan. This intentionally spends cheap local CPU so an open daily candle whose OHLC changed without changing timestamp can never leave a stale current HA signal.
6. **New listings:** once an initial deep-history request has completed, a symbol with fewer than the target warm-up bars is treated as bootstrapped and switches to incremental refresh instead of repeatedly downloading the same short history.
7. **SQLite:** WAL, serialized writes, batch transactions/upserts, `PRAGMA user_version` migrations, bounded retention, and safe backup API/VACUUM INTO.
8. **Stale fallback:** successful cached data is not erased when a provider refresh fails; freshness is exposed in scan output.

## SQLite schema
### instruments
id PK, provider, symbol, name, exchange, asset_type, active, last_seen_at; UNIQUE(provider,symbol).

### market_snapshot
instrument_id PK, price, volume, market_cap NULL, data_time, fetched_at.

### candles
instrument_id, interval, time, open, high, low, close, volume, is_closed, updated_at; PK(instrument_id,interval,time). V1 stores canonical 1d.

### ha_latest
instrument_id, timeframe(1w|1M), kind(current|closed), candle_time, ha_open/high/low/close, green, no_lower_wick, ha_close_change_pct, ha_body_pct, algo_version, source_last_time, computed_at; PK(instrument_id,timeframe,kind).

### scan_runs
id, provider, started_at, finished_at, universe_count, stage1_count, history_refresh_count, stage2_count, result_count, filters_json, status, error.

## Heikin Ashi contract
HA close=(O+H+L+C)/4. First HA open=(O+C)/2. Next HA open=(previous HA open+previous HA close)/2. HA high=max(H,HA open,HA close). HA low=min(L,HA open,HA close). Green means HA close>HA open. No-lower-wick uses numeric tolerance. HA close change %=(current HA close/previous HA close-1)*100.

Calendar policy is provider-specific: FiinQuant uses Asia/Ho_Chi_Minh trading-session calendar; Binance is continuous 24/7 UTC. A Vietnamese stock week is considered closed after the final Friday session boundary rather than waiting for the next Monday.

## API
- GET /health
- GET /sources
- POST /scan
- GET /runs/{id}
- POST /backup

POST /scan uses a single `heikinAshi.timeframe` value, never an array.

## UI
Scanner controls: Source, Universe, Price min/max, Volume min/max, Market cap min/max, HA timeframe Week OR Month, Green, No lower wick, HA close-change threshold, Current/Closed, Scan. Results show symbol/exchange/price/volume/market-cap/selected HA timeframe/state/change/candle time/freshness and can open the symbol in the chart. If the scan source differs from the active chart source, opening a result switches the chart provider first.

## Build order
1. Contracts/capabilities.
2. SQLite + migration.
3. Canonical candle aggregation.
4. HA engine + fixtures/tests.
5. FiinQuant provider.
6. Binance providers.
7. Request planner.
8. Two-stage engine + audit.
9. HTTP API.
10. Workstation UI + chart bridge.
11. Stale fallback/errors/progress/tests.

## Non-goals V1
No PostgreSQL, Redis, ORM, job queue, historical scan warehouse, forced market-cap enrichment, or simultaneous 1W+1M HA scan.
