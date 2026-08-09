# Recent Meaningful Changes

**Generated:** 2026-08-09  
**Documented main:** `9063e77e13e19bc885c1731e844314aa582fe1f8`  

This is a bounded implementation-oriented recap, not a complete commit log. It omits formatting/no-op/temporary-workflow churn and focuses on behavior or architecture that matters when entering the project.

## 2026-08-09

### OpenCode doc sync became bounded and deterministic

The current-documentation synchronization now computes a deterministic `bounded_context` with `scripts/build-current-doc-context.mjs` and passes it to the OpenCode agent. The agent is capped at `DOC_SYNC_MAX_SOURCE_FILES` (25) implementation/test/config reads and stops immediately after its semantic edits. CI's `docs-runtime` job validates the bounded-context builder and the prompt's discovery rules.

Relevant implementation: `scripts/build-current-doc-context.mjs`, `.github/workflows/daily-current-doc-sync.yml`, `.github/workflows/ci.yml`, `agent/prompts/daily-current-doc-sync.md`.

### FiinQuant timeframe switching became cache-first for daily-family data

The latest documented main is merge commit `9244a8600162c7065b8db4d3d11c1b01ee9a8885` for PR #16, “Speed up FiinQuant timeframe switching”.

Current `examples/providers/fiinquant.ts` can return usable cached daily/week/month data immediately, refresh latest daily-family data in the background, derive calendar previews from cached daily history and warm deeper calendar history separately. A shared two-minute attempt guard prevents repeated refresh work during rapid switching.

This changes the practical FiinQuant chart path from “every timeframe switch waits for a fresh provider request” toward “render from trusted browser cache first, refresh separately when possible”.

## 2026-08-08

### VN EOD scanner gained asset classification and fresh active-universe filtering

The CafeF local scanner path now classifies stored Vietnamese securities and restricts the active stock scan universe to fresh `STOCK` rows. The current active window is 30 calendar days relative to the newest local `vn_eod` snapshot.

Non-stock/stale rows remain in SQLite for audit/history instead of being discarded just because the stock scanner excludes them.

Relevant implementation: `examples/sidecars/scanner/security_classifier.py`, `examples/sidecars/scanner/cafef_eod.py`, scanner tests.

### CafeF adjusted EOD became a preloaded zero-network scanner source

A local import pipeline was added around CafeF adjusted EOD/Upto archives.

Current flow:

```text
CafeF adjusted archive
→ validated importer
→ scanner SQLite canonical 1d
→ local Stage 1
→ local Week/Month Heikin Ashi
→ scanner result
→ FiinQuant chart
```

The `vn_eod` provider explicitly throws if scanner execution tries to call provider-style network methods. Import runs are audited in the `eod_import_runs` table.

Relevant implementation: `examples/sidecars/scanner/cafef_eod.py`, `examples/sidecars/scanner/local_eod_provider.py`, `examples/sidecars/scanner/migrations/002_eod_import.sql`.

### Scanner V1 became an implemented subsystem

The repository gained the aiohttp/SQLite scanner backend, provider capability layer, Stage-1/Stage-2 engine, Heikin Ashi computation, scanner API and workstation scanner panel.

The scanner supports FiinQuant, Binance Spot, Binance USD-M and the later-added local `vn_eod` source.

Relevant implementation: `examples/sidecars/scanner/`, `examples/workstation/scanner/`.

### FiinQuant scanner universe/runtime fixes

Scanner FiinQuant universe discovery was corrected to map HOSE/HNX/UPCOM to provider-specific index identifiers while preserving normalized exchange values in SQLite. Scanner startup/runtime path handling also received recovery/health improvements.

Relevant implementation: `examples/sidecars/scanner/providers.py`, `examples/workstation/scanner/`.

### Vnstock chart provider was integrated

The repository added a Vnstock sidecar and browser datafeed with history normalization, shared browser cache and polling-based latest-candle updates. The sidecar is lazy/on-demand in current workstation startup rather than an unconditional launcher prerequisite.

Relevant implementation: `examples/providers/vnstock.ts`, `examples/sidecars/vnstock/`, `examples/workstation/scanner/vite-plugin-v2.ts`.

### FiinQuant Replay gained persistent provider-neutral browser history cache

The older provider-specific browser cache model was replaced/extended by `BrowserHistoryCache` in `examples/providers/browser-history-cache.ts`.

FiinQuant range history now records coverage and lets Replay reuse already-downloaded adjusted candles before asking the sidecar/provider to backfill an old range. Partial cache plus failed missing-range backfill is treated as an error instead of valid complete history.

### Replay moved to one synchronized raw market-time clock

Per-tile Replay timing was replaced by a shared `ReplayClock` orchestrated by `SyncedReplaySession`.

Visible charts for the same symbol can use different timeframes but advance on one raw market-time cursor. Raw candles are incrementally projected into each target timeframe without future OHLC leakage. Replay also claims MarketHub source ownership so live quotes cannot interfere with paper trading during an historical replay.

Relevant implementation: `examples/workstation/replay/replay-clock.ts`, `examples/workstation/replay/replay-session.ts`, `examples/workstation/replay/replay-projection.ts`.

### One-click/local provider startup was simplified

The development launcher/provider runtime was reworked so the normal launcher can reuse existing services, start the assistant, lazily prepare/start FiinQuant when needed and keep optional provider failures isolated from basic workstation startup.

Current launcher: `scripts/run-assistant.mjs`.

## 2026-08-07

### Heikin Ashi became a first-class chart display mode

Heikin Ashi was added as a derived chart price mode while raw provider OHLC remains authoritative for datafeed/trading/indicator logic.

Relevant implementation: `src/core/heikin-ashi.ts`, `src/core/series.ts`.

### Week and Month became calendar-aware chart intervals

The project added explicit interval/calendar helpers and Week/Month aggregation. Month is not treated as a fixed 30-day bucket; week/month boundaries are derived using calendar-aware logic.

Relevant implementation: `src/interval.ts`, `src/calendar-candles.ts`, `src/candle-aggregation.ts`.

## How this file should be maintained

Daily documentation sync should add only meaningful user-visible, data-flow, architectural or operational changes. Tiny refactors, formatting, temporary helper workflows and no-op commits should not become permanent entries.

Keep this document bounded to roughly the latest 50 meaningful change entries; older detail remains available from Git history and historical plans.