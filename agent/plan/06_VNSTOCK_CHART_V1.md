# Vnstock Chart V1

Add Vnstock as an independent Vietnamese-market data provider without coupling chart core, Replay, indicators, or scanner logic to Vnstock-specific APIs.

## Goals
- Add `vnstock` as a selectable workstation price provider alongside Demo, DNSE, FiinQuant, Binance Spot, and Binance USD-M.
- Support Vietnam symbol search across HOSE/HNX/UPCOM through Vnstock reference data.
- Support historical OHLCV through the existing `Datafeed` contract.
- Reuse browser IndexedDB history caching so Replay and chart backfill do not repeatedly hit the provider.
- Support realtime-ish chart/watchlist updates through sidecar polling in V1; keep transport replaceable by WebSocket later.
- Keep Vnstock credentials-free for the default free-source path.
- Keep FiinQuant optional: a FiinQuant failure must not prevent the workstation from starting or using Vnstock.

## Non-goals V1
- No market-cap enrichment.
- No financial statements, foreign flow, proprietary trading, shareholders, or news.
- No PostgreSQL migration.
- No paid Vnstock WebSocket integration.
- No scanner integration in this change; scanner can add a Vnstock adapter after chart-provider behavior is stable.

## Architecture

```text
Workstation UI
    |
VnstockDatafeed (TypeScript)
    |
/vnstock-api
    |
Python Vnstock sidecar
    |
KBS primary -> VCI fallback
```

Chart core only sees normalized `Candle` and `SymbolSearchResult` values.

## Provider contract

### Browser datafeed
Create `examples/providers/vnstock.ts` implementing:
- `getHistory(symbol, interval, limit?, range?)`
- `searchSymbols(query, limit?)`
- `subscribe(symbol, interval, onCandle)`
- `subscribeMany(symbols, interval, onCandle)`
- `health()`
- `clearCache()`
- `dispose()`

Use the shared `BrowserHistoryCache` with source key `vnstock:ohlcv:v1`.

### Sidecar
Create `examples/sidecars/vnstock/` with:
- `vnstock_sidecar.py`
- `requirements.txt`
- `.env.example`
- `README.md`
- `test_vnstock_sidecar.py`

HTTP endpoints:
- `GET /health`
- `GET /symbols?q=&limit=`
- `GET /history?symbol=&interval=&limit=&from=&to=`
- `GET /latest?symbols=&interval=` for polling/multiplex refresh

Every history/latest response must normalize provider output to:

```json
{
  "time": 0,
  "open": 0,
  "high": 0,
  "low": 0,
  "close": 0,
  "volume": 0
}
```

Unix timestamps are seconds. Vietnam calendar/timezone is `Asia/Ho_Chi_Minh`.

## Source policy
- Primary: KBS where supported and healthy.
- Fallback: VCI on provider error or empty unsupported response.
- Keep source selection in Python; browser code never depends on KBS/VCI schemas.
- Expose effective source in `/health`/response metadata for diagnostics.

## Interval policy
Native request where available:
- 1m
- 5m
- 15m
- 1h
- 1d

Local/browser aggregation when required:
- 4h from 1h
- 1w from 1d
- 1M from 1d

Prefer canonical 1d for calendar intervals so chart and future scanner HA calculations stay consistent.

## History/cache policy
1. Read IndexedDB first.
2. Calculate missing range only.
3. Request missing data from sidecar.
4. Persist normalized candles and coverage.
5. On provider failure, keep successful cached history.
6. Never clear good cache because one refresh failed.

## Realtime V1
Use sidecar polling, not one browser timer per symbol.
- Browser subscriptions are multiplexed.
- One polling coordinator batches active symbols.
- Default polling interval: 5 seconds, configurable by environment.
- `subscribeMany` must share the same coordinator.
- Later WebSocket transport can replace polling without changing chart core.

## Workstation integration
Add `vnstock` to provider selection and Vietnam provider family.
- Timezone offset: UTC+7.
- Default watchlist remains shared with other Vietnam providers.
- Provider status should show sidecar availability, effective source, cache status, and polling mode.
- No login fields.

Add Vite proxy. Port `8730` is already owned by the scanner sidecar, so Vnstock uses `8740`:

```text
/vnstock-api -> http://127.0.0.1:8740
```

## Launcher behavior
The workstation must not be hard-blocked by optional providers.

Target startup:

```text
Assistant sidecar
Vnstock sidecar (best effort / provider-specific status)
FiinQuant sidecar (best effort / provider-specific status)
Workstation starts regardless of one optional market provider failing
```

A provider failure should make only that provider unavailable.

## Validation
Python:
- health
- symbol search normalization
- history normalization
- invalid symbols
- KBS -> VCI fallback
- timestamp normalization
- invalid OHLC rejection

TypeScript:
- datafeed history parsing
- cache hit/missing-range behavior
- cached fallback
- symbol search
- polling subscription multiplexing
- timezone/provider switch integration

Regression:
- `npm run typecheck`
- `npm run build:demo`
- `npm test`

## Build order
1. Sidecar contract + normalization.
2. KBS primary / VCI fallback adapter.
3. Sidecar tests.
4. `VnstockDatafeed` + browser cache.
5. Polling/subscription multiplexing.
6. Workstation provider integration.
7. Vite proxy.
8. Launcher decoupling for optional providers.
9. Replay/watchlist regression.
10. Full typecheck/build/tests.

## Acceptance criteria
- User can select Vnstock without FiinQuant login.
- Search can return Vietnam symbols beyond the current hard-coded list.
- FPT/HPG/VIC historical chart loads from Vnstock.
- Replay works using the same history datafeed path.
- Watchlist uses shared Vnstock polling rather than one independent poller per row.
- Cached chart remains usable when Vnstock temporarily fails.
- FiinQuant failure does not prevent the workstation from opening.
