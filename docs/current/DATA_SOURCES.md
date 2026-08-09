# Current Data Sources

**Generated:** 2026-08-09  
**Documented main:** `a65ead7073114a2418f29b779633390b47fb2995`  

This page separates chart datafeeds from scanner sources. They are different application boundaries even when they use the same upstream provider name.

## Matrix

| Source | Chart | Scanner | Realtime behavior | Persistent local cache/storage | Market cap in scanner |
|---|---:|---:|---|---|---:|
| Sample | Yes | No | deterministic demo data | none required | n/a |
| Binance Spot | Yes | Yes | chart provider uses Binance realtime behavior; scanner uses public REST refresh | browser IndexedDB history for chart; SQLite for scanner cache | No |
| Binance USD-M | Yes | Yes | chart provider uses Binance realtime behavior; scanner uses public REST refresh | browser IndexedDB history for chart; SQLite for scanner cache | No |
| DNSE | Yes | No | broker/example integration | workstation/provider-specific state | n/a |
| FiinQuant | Yes | Yes | chart sidecar + stream; scanner performs network refresh in batches | browser IndexedDB history for chart; SQLite for scanner cache | No |
| Vnstock | Yes | No | browser adapter polls sidecar `/latest` | browser IndexedDB history | n/a |
| `vn_eod` / CafeF adjusted EOD | No | Yes | no network during scan | scanner SQLite canonical adjusted `1d` OHLCV + import audit | No |

## Shared browser chart-history cache

Implementation: `examples/providers/browser-history-cache.ts`.

Database:

```text
l2chart.market.history.v1
```

The cache stores:

- candles keyed by source, symbol, interval and timestamp;
- per-series metadata;
- confirmed coverage ranges.

Coverage is explicit. A cache containing some candles is not automatically treated as covering an arbitrary requested historical range. Range consumers can calculate missing coverage and request only uncovered spans.

This matters especially for Replay: if a provider cannot backfill an uncovered historical gap, the application must not silently pretend partial history is complete.

Current source identifiers include:

- `binance:spot`;
- `binance:usdm`;
- `fiinquant:adjusted`;
- Vnstock's `vnstock:ohlcv:v1`.

The cache contains migration compatibility for the older Binance-specific IndexedDB database.

## FiinQuant chart source

Implementation:

- `examples/providers/fiinquant.ts`;
- `examples/sidecars/fiinquant/fiinquant_sidecar.py`;
- `examples/workstation/provider-runtime/vite-plugin.ts`.

### Route

```text
Browser Datafeed
    ↓
/fiinquant-api
    ↓
Vite same-origin proxy
    ↓
127.0.0.1:8720
    ↓
FIinQuant sidecar
    ↓
FiinQuantX
```

The default browser path is same-origin `/fiinquant-api`; the workstation proxy injects the server-side sidecar token for allowed loopback browser requests when configured.

### History

FIinQuant chart history is adjusted and persisted under the shared browser cache source `fiinquant:adjusted`.

Current important behavior in `examples/providers/fiinquant.ts`:

- range history reads confirmed cache coverage first;
- only missing ranges are fetched;
- an uncovered backfill failure is surfaced instead of treating partial local history as complete;
- latest `1d`, `1w` and `1M` requests can return usable cached data immediately;
- daily/week/month cached data is refreshed in the background with a two-minute attempt guard;
- Week/Month can be derived from cached daily data;
- deeper calendar warm-up is separated from the first usable preview.

The latest documented main includes the FiinQuant fast-timeframe-switch work merged in PR #16.

### Realtime / startup

The browser datafeed owns FiinQuant stream subscriptions. The provider runtime lazily starts the local sidecar and can prepare the managed Python environment and auto-login from the sidecar `.env`.

The current workstation also injects FiinQuant-specific startup and quota behavior through `examples/workstation/scanner/vite-plugin-v4.ts`, `vite-plugin-v5.ts` and `vite-plugin-v6.ts`.

Those patches currently ensure that:

- data operations wait for one shared startup gate;
- direct-looking symbols missing from metadata can still attempt a real chart load;
- FiinQuant background watchlist feed work does not consume symbol quota before visible charts.

## FiinQuant scanner source

Implementation: `FIinQuantProvider` in `examples/sidecars/scanner/providers.py`.

Scanner capabilities currently report:

- universes: HOSE, HNX, UPCOM;
- universe mapping to FiinQuant index names: VNINDEX, HNXIndex, UpcomIndex;
- bulk snapshot: yes;
- bulk history: yes;
- market cap: no;
- timezone: Asia/Ho_Chi_Minh;
- continuous market: no;
- snapshot TTL: 60 seconds;
- history TTL: 120 seconds;
- network refresh mode.

The scanner stores normalized exchange values HOSE/HNX/UPCOM even though the SDK universe query uses provider-specific index names.

This source requires FiinQuant credentials. Its presence in code does not guarantee that it is available in a given runtime.

## Vnstock chart source

Implementation:

- `examples/providers/vnstock.ts`;
- `examples/sidecars/vnstock/`.

Current browser adapter behavior:

- historical candles use the shared browser cache source `vnstock:ohlcv:v1`;
- range requests use coverage/missing-range semantics similar to FiinQuant;
- realtime-like updates poll `/latest` rather than consuming an exchange push stream;
- polling is grouped by interval and sent in batches of up to 50 subscribed symbols;
- default poll delay is 5 seconds, subject to sidecar health/config response;
- daily polled candles are normalized to the same trading-day timestamp key as historical daily candles before merge.

## Binance chart sources

Implementation: `examples/providers/binance.ts` plus shared cache integration.

The workstation exposes separate chart providers for:

- Binance Spot;
- Binance USD-M Futures.

Browser historical data participates in the shared IndexedDB cache. Legacy Binance cache compatibility is retained in `examples/providers/browser-history-cache.ts` and `examples/providers/binance-cache.ts`.

## Binance scanner sources

Implementation: `BinanceProvider` in `examples/sidecars/scanner/providers.py`.

Both scanner variants use public REST APIs and currently report market cap unsupported.

Common scanner characteristics:

- universe: USDT;
- continuous 24/7 market;
- timezone: UTC;
- bulk snapshot support;
- history is fetched per symbol rather than as a bulk-history capability;
- bounded scanner history concurrency;
- SQLite stores the scanner's normalized instruments/snapshots/daily history.

## DNSE chart source

Implementation: `examples/providers/dnse.ts`, with REST/WebSocket integration in `examples/workstation/vite.config.ts`.

DNSE is a workstation/reference provider, not part of the stable chart core. The Vite layer implements REST request signing/proxying and a WebSocket proxy route.

DNSE is not currently a scanner source.

## `vn_eod` / CafeF local scanner source

Implementation:

- `examples/sidecars/scanner/cafef_eod.py`;
- `examples/sidecars/scanner/local_eod_provider.py`;
- `examples/sidecars/scanner/db.py`;
- scanner migrations.

Capabilities explicitly set:

- id: `vn_eod`;
- label: `VN EOD (CafeF)`;
- universes: HOSE, HNX, UPCOM;
- timezone: Asia/Ho_Chi_Minh;
- non-continuous market;
- market cap: unsupported;
- refresh mode: `preloaded`.

The provider's `list_instruments`, `snapshots` and `daily_history` methods deliberately throw if called. That is a hard guard that scanner execution must use the preloaded SQLite data rather than silently reintroducing network requests.

### Import commands

Initial historical bootstrap:

```bash
python examples/sidecars/scanner/cafef_eod.py import-latest --mode upto
```

Daily completed-session update:

```bash
python examples/sidecars/scanner/cafef_eod.py import-latest --mode eod
```

Status:

```bash
python examples/sidecars/scanner/cafef_eod.py status
```

Reclassify an existing database without downloading data again:

```bash
python examples/sidecars/scanner/cafef_eod.py reclassify
```

The importer persists canonical adjusted daily OHLCV. Week/Month candles and Heikin Ashi are derived locally rather than duplicated as imported source history.

### Fresh stock universe

The current local stock-scanner universe uses a 30-calendar-day freshness window relative to the newest `vn_eod` snapshot and includes rows classified as `STOCK`. Other stored asset types remain available for audit/history but are excluded from the active stock scan.

### Scanner-to-chart routing

`vn_eod` is not a chart provider. Scanner result navigation routes a local Vietnamese result to the FiinQuant chart path.

## Storage boundaries

Do not confuse the two persistent data stores:

```text
Browser IndexedDB
  purpose: chart/replay history cache

Scanner SQLite
  purpose: scanner instruments/snapshots/canonical daily candles/HA/audit
```

They have different ownership and lifecycle. Scanner SQLite is not currently a generic chart-history backend.