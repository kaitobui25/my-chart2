# Recent Meaningful Changes

**Generated:** 2026-08-20  
**Documented main:** `1ddc163c8f29129011920f48ce16bc67343c8352`  

This is a bounded implementation-oriented recap, not a complete commit log. It omits formatting/no-op/temporary-workflow churn and focuses on behavior or architecture that matters when entering the project.

## 2026-08-19

### Institutional flow indicator (Dòng tiền tổ chức)

A new `institutional-flow` indicator renders monthly net foreign and proprietary ("tự doanh") cash flow as a signed, stacked histogram pinned to a fixed region at the top of the main pane. The series deliberately opts out of PriceScale so flow values can never distort stock-price autoscaling. It becomes eligible only when the chart runs on the Vnstock provider with a monthly (1M) interval and a listed 3-letter Vietnamese equity ticker; calendar months are aligned using Vietnamese time regardless of browser/OS timezone. The zero line is draggable (the moved position is patched back into the saved indicator params) and value labels use billion-implied formatting, with `tr` appended to million-scale values.

The indicator runtime context gained per-chart provider tracking and a direct-manipulation parameter-patch channel in addition to the existing symbol tracking. Data is fetched through the workstation `/stock-flow-api` route, which proxies to an external stockdata web service (`GET /api/chart-flow`, default `http://127.0.0.1:8765`, overridable with `STOCKDATA_WEB_URL`), with a 5-minute browser cache and an 8-second timeout.

Relevant implementation: `src/indicators/builtin/institutional-flow.ts`, `institutional-flow-model.ts`, `institutional-flow-client.ts`, `institutional-flow-series.ts`, `src/indicators/runtime-context.ts`, `examples/workstation/stock-flow/vite-plugin.ts`, `examples/workstation/vite.config.ts`, `tests/unit/institutional-flow-model.test.ts`, `tests/unit/institutional-flow-series.test.ts`, `tests/browser/institutional-flow.spec.ts`.

## 2026-08-13

### Auto-doc output collapsed into one commit

The `.github/workflows/daily-current-doc-sync.yml` workflow now collapses any local commits the OpenCode agent creates into one pending working-tree docs change (`git reset --mixed` to the target SHA) before validation. The validated commit step is the only place allowed to create a docs commit, and the workflow refuses to push if HEAD is not still the target SHA.

Relevant implementation: `.github/workflows/daily-current-doc-sync.yml`.

## 2026-08-12

### P/E indicator v1 merged into main

A P/E indicator (`pe`, registered via `src/indicators/all.ts`) now renders a FiinQuant daily P/E valuation line and Vnstock quarterly reported-P/E markers on eligible Vietnam equity tickers. Async data is scoped to the active chart symbol through the `setWatermark()` runtime-context adapter (`src/indicators/runtime-context.ts`), and unsupported instruments are excluded before any cache/network work. Daily valuation points and quarterly fundamentals are cached separately in IndexedDB (`l2chart.valuations.v1` and `l2chart.fundamentals.v1`), and valuation cache reads are coverage-aware so only missing ranges are refetched.

Relevant implementation: `src/indicators/builtin/pe.ts`, `pe-model.ts`, `pe-client.ts`, `pe-cache.ts`, `pe-valuation-client.ts`, `pe-valuation-cache.ts`, `pe-eligibility.ts`, `runtime-context.ts`, unit tests under `tests/unit/pe-*`.

### FiinQuant sidecar split with historical stock valuation

The FiinQuant sidecar was split into `fiinquant_sidecar_core.py` (FiinQuantX session, OHLC history cache, realtime subscriptions, gateway) and a thin `fiinquant_sidecar.py` facade that reuses that session and adds `GET /valuation/stock` (via `MarketDepth().get_stock_valuation()`), which the P/E indicator consumes. The existing history/realtime endpoints and cache behavior are preserved.

Relevant implementation: `examples/sidecars/fiinquant/fiinquant_sidecar.py`, `examples/sidecars/fiinquant/fiinquant_sidecar_core.py`, `examples/sidecars/fiinquant/test_fiinquant_valuation.py`.

### Vnstock sidecar gained quarterly P/E fundamentals

`GET /fundamentals/pe` on the Vnstock sidecar normalizes quarterly trailing-EPS/P/E rows through the Vnstock `Fundamental` API, with canonical `YYYY-Q#` periods winning over suffixed duplicates.

Relevant implementation: `examples/sidecars/vnstock/vnstock_sidecar.py`, `examples/sidecars/vnstock/test_vnstock_sidecar.py`.

### Replay preserves history before the selected candle

Replay now restores only *closed* target-timeframe history from before the first projected bucket as a display-only seed (`mergeReplayInitialCandles`), read from the browser history cache first. Projected candles always win in the merged dataset, so the selected/partial bucket is rebuilt from raw replay data and no future live-chart candle leaks into Replay. Older visible history is no longer part of the raw replay clock range.

Relevant implementation: `examples/workstation/replay/replay-session.ts`, `tests/unit/replay-history-seed.test.ts`, `tests/browser/workstation.spec.ts`.

### Developer terminal trace diagnostics

Dev/Playwright Vite runs now use `scripts/vite-dev.config.mjs`, which merges the workstation config with the `dev-trace-vite.mjs` plugin. The plugin injects a browser script that reports network-fetch timing, IndexedDB operations, long tasks and window errors to the Vite terminal via `/__l2chart_dev_trace`, with token/secret query parameters redacted. The launcher and Playwright config include the trace health check when reusing an existing dev server.

Relevant implementation: `scripts/dev-trace-vite.mjs`, `scripts/vite-dev.config.mjs`, `scripts/run-assistant.mjs`, `playwright.config.ts`, `tests/browser/dev-terminal-trace.spec.ts`.

## 2026-08-10

### Current-doc sync became scheduled and commits directly to main

The `.github/workflows/daily-current-doc-sync.yml` workflow now runs on a schedule (daily at 05:37 JST) in addition to manual `workflow_dispatch`. When validated documentation changes exist, it commits them directly to `main` instead of maintaining the rolling `[docs-sync]` pull request.

Sunday runs and runs whose baseline is not an ancestor of target use `full-reconciliation`; otherwise the mode is `incremental`. The run is skipped when `scripts/build-current-doc-context.mjs` reports zero meaningful changed paths or the documented SHA already equals target. CI's `docs-runtime` job now also enforces that the workflow stays direct-to-main: no `gh pr`, no `pull-requests: write` permission, no rolling `docs-sync/current` branch.

Relevant implementation: `.github/workflows/daily-current-doc-sync.yml`, `.github/workflows/ci.yml`, `agent/prompts/daily-current-doc-sync.md`.

### SSI FastConnect real-API probe experiment

An experiment was added to measure the real path to SSI FastConnect before integration: `scripts/ssi-probe.mjs` plus `agent/experiments/ssi-probe/` runbook and env example. It records auth latency, DNS/TLS baseline, cold/warm 500-candle daily latency, REST paging behavior, intraday `5m`/`1h` latency, board lists and `X-RATELIMIT-*` headers, and stores a redacted report at `agent/experiments/ssi-probe/results/latest.json`. The docs checker treats that report as runtime-only. SSI is still an experiment, not a chart provider.

Relevant implementation: `scripts/ssi-probe.mjs`, `agent/experiments/ssi-probe/README.md`, `agent/experiments/ssi-probe/ssi-probe.env.example`, `scripts/check-current-docs.mjs`.

### Scanner UI refresh and CafeF EOD update card

The workstation scanner was restyled with a Vietnamese sidebar layout (chips, segmented controls, result count) and gained a local EOD status card when `vn_eod` is selected: latest trade date, active stock count, per-symbol retention and a freshness badge with a **Cập nhật EOD** button. The scanner sidecar added `GET /eod/status` and `POST /eod/import-latest`, reusing the same CafeF importer service as the CLI (`cafef_eod._import_latest`) instead of a second Python process; only one EOD update may run at a time. Scanner filter preferences moved to `l2chart.scanner.filters.v2`.

Relevant implementation: `examples/sidecars/scanner/scanner_sidecar.py`, `examples/sidecars/scanner/README.md`, `examples/workstation/scanner/`.

### FiinQuant sidecar hardened historical-range caching

The sidecar `HistoryCache` now coalesces concurrent identical explicit-range history requests into one upstream call and applies a 30-second per-symbol/interval cooldown after FiinQuant upstream 504 gateway timeouts before allowing retries.

Relevant implementation: `examples/sidecars/fiinquant/fiinquant_sidecar.py`.

## 2026-08-09

### OpenCode doc sync became bounded and deterministic

The current-documentation synchronization now computes a deterministic `bounded_context` with `scripts/build-current-doc-context.mjs` and passes it to the OpenCode agent. The agent is capped at `DOC_SYNC_MAX_SOURCE_FILES` (25) implementation/test/config reads and stops immediately after its semantic edits. CI's `docs-runtime` job validates the bounded-context builder and the prompt's discovery rules.

Relevant implementation: `scripts/build-current-doc-context.mjs`, `.github/workflows/daily-current-doc-sync.yml`, `.github/workflows/ci.yml`, `agent/prompts/daily-current-doc-sync.md`.

### FiinQuant timeframe switching became cache-first for daily-family data

The relevant implementation milestone was merge commit `9244a8600162c7065b8db4d3d11c1b01ee9a8885` for PR #16, “Speed up FiinQuant timeframe switching”.

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