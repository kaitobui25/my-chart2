# my-chart2 — Current State

**Generated:** 2026-08-09  
**Documented main:** `9244a8600162c7065b8db4d3d11c1b01ee9a8885`  
**Documentation role:** canonical snapshot of the implementation at the commit above.

`docs/current/` describes what the repository currently implements. Historical design and build plans under `agent/plan/` are useful context but are not implementation evidence.

## What this project currently is

`my-chart2` contains a provider-neutral Canvas 2D financial chart core plus a full browser workstation. The workstation currently composes charting, indicators and drawings with multiple market-data providers, synchronized Replay, paper trading, an AI assistant sidecar, and a two-stage market scanner.

The stable chart package remains under `src/`; provider- and workstation-specific behavior lives under `examples/`.

## Major capabilities

- Price display modes: candles, Heikin Ashi, OHLC bars, line and area. Evidence: `src/core/series.ts`, `src/core/heikin-ashi.ts`.
- Calendar-aware `1W` and `1M` intervals in addition to intraday/daily intervals. Evidence: `src/interval.ts`, `src/calendar-candles.ts`.
- Multi-chart workstation with drawings, indicators, templates, watchlists and provider switching. Evidence: `examples/workstation/main.ts`.
- Shared synchronized Replay across visible charts for one symbol, with independent timeframe projection and no future OHLC leakage from higher-timeframe candles. Evidence: `examples/workstation/replay/replay-session.ts`, `examples/workstation/replay/replay-projection.ts`.
- Paper trading driven by `MarketHub`; Replay can exclusively own a symbol's quote source so live quotes cannot interfere during replay. Evidence: `examples/workstation/trading/paper.ts`.
- Browser history persistence through the provider-neutral IndexedDB database `l2chart.market.history.v1`. Evidence: `examples/providers/browser-history-cache.ts`.
- Market-data adapters for Sample, Binance Spot, Binance USD-M Futures, DNSE, FiinQuant and Vnstock. Evidence: `examples/providers/`.
- FiinQuant cache-first chart history with lazy/background refresh for daily/week/month data, plus range-aware browser cache coverage used by Replay. Evidence: `examples/providers/fiinquant.ts`.
- Vnstock chart provider with shared browser history cache and polling-based latest-candle updates. Evidence: `examples/providers/vnstock.ts`, `examples/sidecars/vnstock/`.
- TradingView-style scanner UI with price, volume, optional market-cap and Week/Month Heikin Ashi filters. Evidence: `examples/workstation/scanner/index.ts`.
- Scanner backend using aiohttp + SQLite with a two-stage filter pipeline. Evidence: `examples/sidecars/scanner/engine.py`, `examples/sidecars/scanner/db.py`.
- Vietnamese-stock local scanner source `vn_eod`: adjusted CafeF EOD data is imported once, then scans run locally without market-data network calls. Evidence: `examples/sidecars/scanner/cafef_eod.py`, `examples/sidecars/scanner/local_eod_provider.py`.
- AI assistant integration backed by a loopback sidecar. Evidence: `ASSISTANT.md`, `examples/sidecars/assistant/`, `examples/workstation/vite.config.ts`.

## Current high-level architecture

```text
Browser workstation (127.0.0.1:53173)
│
├─ L2Chart core / indicators / drawings
│    └─ src/**
│
├─ Market-data Datafeeds
│    ├─ Sample
│    ├─ Binance Spot / USD-M
│    ├─ DNSE
│    ├─ FiinQuant ── browser IndexedDB cache
│    └─ Vnstock   ── browser IndexedDB cache
│
├─ ReplaySession ── ReplayClock ── ReplayProjection
│       └─ MarketHub source lock ── Paper Trading
│
├─ Scanner UI ── /scanner-api ── scanner sidecar :8730
│       └─ SQLite scanner.db
│            ├─ FiinQuant scanner provider
│            ├─ Binance scanner providers
│            └─ vn_eod / CafeF adjusted EOD
│
└─ Assistant UI ── /assistant-api ── assistant sidecar :8788

FIinQuant chart traffic:
Browser ── /fiinquant-api ── FiinQuant sidecar :8720 ── FiinQuantX
```

See `docs/current/ARCHITECTURE.md` for boundaries and data flow.

## Important current behavior

### FiinQuant is chart-first

The workstation contains startup/quota guards around FiinQuant. Valid direct-looking symbols can still be opened even if FiinQuant symbol metadata omits them; actual history loading remains the final validity check. Background watchlist work is suppressed for FiinQuant so merely displaying a watchlist does not consume symbol quota before charts do. Evidence: `examples/workstation/scanner/vite-plugin-v4.ts`, `examples/workstation/scanner/vite-plugin-v5.ts`, `examples/workstation/scanner/vite-plugin-v6.ts`.

Latest daily/week/month FiinQuant requests are cache-first when usable cached candles exist. A background refresh updates daily-family data with a two-minute retry guard. Week/month data can be derived from cached daily history while deeper warm-up happens separately. Evidence: `examples/providers/fiinquant.ts`.

### Vietnamese scanning is decoupled from realtime charting

The preferred local EOD path is:

```text
CafeF adjusted EOD/Upto ZIP
        ↓
    cafef_eod.py
        ↓
scanner SQLite (canonical adjusted 1d)
        ↓
Stage 1 SQL filters
        ↓
Week/Month aggregation + Heikin Ashi
        ↓
scanner result
        ↓
open symbol in FiinQuant chart
```

`vn_eod` scans do not call CafeF or FiinQuant while a scan is executing. Market cap is unsupported/NULL for this source. Evidence: `examples/sidecars/scanner/README.md`, `examples/sidecars/scanner/engine.py`.

## Operational entry points

- Install JavaScript dependencies: `npm install` or CI-style `npm ci`.
- Start the workstation: `npm run dev`.
- Windows convenience launcher: `open-ai-chart.bat`.
- Build workstation: `npm run build:demo`.
- Full repository verification: `npm run verify`.
- Scanner tests: `npm run test:scanner-sidecar`.
- Bootstrap CafeF local scanner history: `python examples/sidecars/scanner/cafef_eod.py import-latest --mode upto`.
- Daily CafeF update: `python examples/sidecars/scanner/cafef_eod.py import-latest --mode eod`.

See `docs/current/OPERATIONS.md` before changing startup/runtime behavior.

## Known boundaries / limitations

- FiinQuant and Vnstock integrations are example/application integrations, not part of the provider-neutral `lamlong-chart` public package API.
- Scanner market cap is not universally available; it is explicitly unsupported for FiinQuant and `vn_eod` in the current scanner capability definitions.
- `vn_eod` freshness depends on importing CafeF EOD packages; scanning itself is local but data ingestion is not automatic OS scheduling.
- Replay requires all visible replay participants to use the same symbol. A replay range estimated above 20,000 raw source bars is rejected rather than silently truncated.
- The current workstation contains layered Vite transform patches under `examples/workstation/scanner/vite-plugin-v*.ts` for FiinQuant startup/quota/direct-symbol behavior. They work as runtime integration code but are an architectural maintenance hotspot.
- GitHub Agentic Workflow documentation sync introduced on the documentation branch is not part of this documented `main` SHA; this snapshot intentionally describes main before that automation is merged.

## Where to read next

- `docs/current/ARCHITECTURE.md` — module ownership and flows.
- `docs/current/FEATURES.md` — implementation/status inventory.
- `docs/current/DATA_SOURCES.md` — providers, sidecars and caches.
- `docs/current/SCANNER.md` — scanner architecture and CafeF local EOD flow.
- `docs/current/REPLAY.md` — synchronized Replay behavior.
- `docs/current/OPERATIONS.md` — startup, ports, commands and runtime data.
- `docs/current/RECENT_CHANGES.md` — recent meaningful implementation changes.