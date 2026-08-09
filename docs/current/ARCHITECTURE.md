# Current Architecture

**Generated:** 2026-08-09  
**Documented main:** `9244a8600162c7065b8db4d3d11c1b01ee9a8885`

This page describes implementation boundaries at the documented commit. It does not describe future plans.

## 1. Stable chart core

The provider-neutral library lives under `src/`.

Main responsibilities:

- `src/core/chart.ts` — chart lifecycle, data ownership, pane/time-scale interaction and the main price series.
- `src/core/series.ts` — renderable price/indicator series; the main price mode supports candles, Heikin Ashi, bars, line and area.
- `src/core/heikin-ashi.ts` — pure Heikin Ashi transformation.
- `src/interval.ts` — interval codes and calendar-aware interval boundaries.
- `src/calendar-candles.ts` and `src/candle-aggregation.ts` — pure OHLC aggregation/projection helpers.
- `src/datafeed.ts` — provider-neutral market-data contract.
- `src/indicators/` — indicator registry and calculations.

`src/index.ts` exports the provider-neutral package surface. Provider SDK authentication, sidecars, scanner code and workstation behavior are intentionally outside this boundary.

## 2. Workstation application

The browser workstation is under `examples/workstation/` and composes the chart core with application behavior.

`examples/workstation/main.ts` owns the central UI/application composition: chart tiles, provider selection, chart preferences/templates, watchlists, replay wiring, drawing persistence and MarketHub/paper-trading integration.

The Vite application runs on `127.0.0.1:53173` in development. `examples/workstation/vite.config.ts` installs the provider runtime, DNSE proxy, assistant proxy/integration and scanner integration plugins.

## 3. Market-data boundary

Provider adapters implement the chart `Datafeed` boundary under `examples/providers/`.

```text
Workstation Tile
    │
    ▼
Datafeed interface
    │
    ├─ SampleDatafeed
    ├─ BinanceDatafeed
    ├─ DNSEDatafeed
    ├─ FiinQuantDatafeed
    └─ VnstockDatafeed
```

The core chart does not own provider credentials or network lifecycle.

### Browser history persistence

`examples/providers/browser-history-cache.ts` is the shared provider-neutral browser history cache.

Current IndexedDB database:

```text
l2chart.market.history.v1
```

It stores candles plus confirmed coverage ranges keyed by source/symbol/interval. Current source identifiers include Binance Spot, Binance USD-M, adjusted FiinQuant history and Vnstock history.

The cache is important to Replay because a previously downloaded historical range can be reused without asking a provider to backfill the same old period again.

## 4. FiinQuant path

```text
Browser
  │
  │ same-origin /fiinquant-api
  ▼
Vite proxy / provider runtime
  │
  ▼
127.0.0.1:8720
FIinQuant Python sidecar
  │
  ▼
FIinQuantX
```

Evidence: `examples/workstation/vite.config.ts`, `examples/workstation/provider-runtime/vite-plugin.ts`, `examples/sidecars/fiinquant/fiinquant_sidecar.py`.

The provider runtime can lazily prepare a local Python 3.11+ virtual environment, start the sidecar, wait for health, and auto-login from the sidecar `.env` when credentials/token are configured.

The browser side additionally shares one startup gate across chart/history/health/navigation work. Layered Vite transforms under `examples/workstation/scanner/vite-plugin-v4.ts` through `vite-plugin-v6.ts` currently patch startup, direct-symbol and FiinQuant watchlist-quota behavior into the workstation module.

This transform chain is implementation reality but is also a maintenance hotspot because behavior is injected into `main.ts` rather than expressed through a normal imported service boundary.

## 5. Vnstock path

```text
Browser
  │
  ▼
VnstockDatafeed
  │
  ▼
/vnstock-api
  │
  ▼
Vnstock sidecar
```

`examples/providers/vnstock.ts` uses the shared browser history cache for historical ranges and polls `/latest` for subscribed symbols. Poll subscriptions are grouped by interval and chunked, with a maximum batch of 50 symbols in the current browser adapter.

Daily realtime candles are normalized to the same trading-day key as history before cache merge.

## 6. Binance path

Binance chart adapters are browser-side provider integrations under `examples/providers/binance.ts`; the shared browser history cache is exposed through `examples/providers/binance-cache.ts` compatibility helpers and `examples/providers/browser-history-cache.ts`.

The workstation distinguishes Binance Spot and Binance USD-M Futures as separate providers.

## 7. DNSE path

DNSE is an application example adapter under `examples/providers/dnse.ts`.

The Vite config owns a same-origin REST signing proxy and WebSocket proxy. Credentials may come from workstation environment configuration or request headers according to the current proxy logic. DNSE remains outside the stable chart core.

## 8. Replay subsystem

Replay is split into focused modules:

```text
SyncedReplaySession
    │
    ├─ ReplayClock
    │     └─ shared market-time cursor / play / pause / step / 1x 2x 5x 10x
    │
    └─ ReplayProjection per visible chart
          └─ raw source candle -> chart timeframe candle
```

Evidence: `examples/workstation/replay/replay-session.ts`, `examples/workstation/replay/replay-clock.ts`, `examples/workstation/replay/replay-projection.ts`.

All visible replay participants must use the same symbol. The session chooses a common raw base interval; the special Week+Month combination falls back to daily raw candles because weeks cannot be safely folded into calendar months.

Replay loads one common historical range and rejects an estimated raw range over 20,000 bars.

Before Replay starts, completed target-timeframe history is retained as seed context so recursive Heikin Ashi values do not restart at the replay selection point.

## 9. MarketHub and paper trading

`examples/workstation/trading/paper.ts` defines `MarketHub` and the browser `PaperTradingEngine`.

MarketHub is the quote bus shared by visible data sources and paper trading. It supports an exclusive source lock per symbol.

Replay claims that lock for the replayed symbol. While the lock is held, quotes from other sources for that symbol are ignored. This prevents live/watchlist updates from changing paper-trading prices during replay.

Paper trading state is browser-persisted under `l2chart.paper.v1`.

## 10. Scanner subsystem

Scanner code is deliberately outside the chart core.

```text
Scanner UI
examples/workstation/scanner/
        │
        │ /scanner-api
        ▼
Scanner Vite integration
        │
        ▼
Scanner sidecar :8730
examples/sidecars/scanner/
        │
        ├─ provider capability layer
        ├─ two-stage engine
        ├─ Heikin Ashi engine
        └─ ScannerDB
              │
              ▼
        data/scanner.db
```

The sidecar uses Python aiohttp and standard `sqlite3`.

The scanner engine is provider-neutral through `ScannerProvider` capabilities. It distinguishes network-refresh sources from preloaded/local sources.

Current scanner source families:

- FiinQuant.
- Binance Spot.
- Binance USD-M Futures.
- `vn_eod`, the local Vietnamese EOD source.

## 11. Local Vietnamese EOD scanner path

```text
CafeF adjusted EOD/Upto archive
          │
          ▼
cafef_eod.py
          │ validate/normalize/audit
          ▼
ScannerDB canonical adjusted 1d candles
          │
          ├─ snapshot / active-stock universe
          └─ local Week/Month + Heikin Ashi
                    │
                    ▼
                results
                    │
                    ▼
      FiinQuant chart on row click
```

`vn_eod` uses `refresh_mode='preloaded'`, so the scanner engine skips provider instrument/snapshot/history network refresh while scanning. If no local active symbols exist, the scan fails with an import-first message.

Active Vietnamese scanner symbols are derived from fresh local snapshots and the security classifier. Non-stock asset types can remain stored for audit/history while being excluded from stock scans.

## 12. Assistant subsystem

The assistant remains an application feature rather than part of the chart core.

```text
Assistant UI
   │
   │ /assistant-api
   ▼
Vite proxy
   │
   ▼
127.0.0.1:8788
assistant sidecar / Codex integration
```

The workstation bridge exposes a read-only snapshot of the active tile including at most 240 recent candles, indicators, replay state and chart metadata. See `ASSISTANT.md` and `examples/workstation/vite.config.ts`.

## 13. Architectural boundaries to preserve

When modifying the project, preserve these current design boundaries unless a deliberate architecture change is intended:

1. Raw market OHLC remains authoritative; Heikin Ashi is derived display/scan data.
2. Provider-specific networking/authentication stays outside `src/`.
3. Replay uses raw source candles and projects them per chart timeframe.
4. Scanner storage/requests remain outside the stable chart package.
5. Local EOD scanning should not accidentally reintroduce per-scan CafeF/FiinQuant network dependency.
6. MarketHub source ownership must prevent Replay/live quote mixing for the same symbol.
7. Browser history cache coverage must remain explicit so a partial cache is not silently treated as complete history.