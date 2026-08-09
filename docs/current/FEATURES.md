# Current Feature Inventory

**Generated:** 2026-08-09  
**Documented main:** `9244a8600162c7065b8db4d3d11c1b01ee9a8885`

Status vocabulary used here:

- **Verified** — implementation exists and repository tests or explicit runtime contracts cover the behavior.
- **Implemented** — implementation exists, but this page does not claim complete runtime verification for every provider/environment.
- **Experimental** — implemented application behavior whose interface/runtime architecture is still evolving.
- **Partial** — only part of the desired capability exists.
- **Unsupported** — deliberately unavailable in the current implementation.

| Capability | Status | Current evidence / notes |
|---|---|---|
| Canvas 2D financial chart core | Verified | `src/core/chart.ts`, `src/core/pane.ts`, `src/core/time-scale.ts` |
| Candlestick price mode | Verified | `src/core/series.ts`, browser/unit tests |
| Heikin Ashi chart mode | Verified | `src/core/heikin-ashi.ts`, `tests/unit/heikin-ashi.test.ts` |
| OHLC bar / line / area modes | Implemented | `src/core/series.ts` |
| Calendar-aware Week / Month intervals | Verified | `src/interval.ts`, `src/calendar-candles.ts`, interval/aggregation tests |
| Indicators and registry | Verified | `src/indicators/`, `examples/workstation/main.ts` |
| Drawing tools and persistence hooks | Implemented | `src/core/drawings.ts`, workstation storage/persistence in `examples/workstation/main.ts` |
| Multi-chart workstation layouts | Verified | `examples/workstation/main.ts`, workstation browser tests |
| Chart templates/preferences | Implemented | `examples/workstation/main.ts` |
| Shared browser history cache | Verified | `examples/providers/browser-history-cache.ts`, `tests/unit/browser-history-cache.test.ts` |
| Binance Spot chart provider | Implemented | `examples/providers/binance.ts` |
| Binance USD-M chart provider | Implemented | `examples/providers/binance.ts` |
| DNSE chart provider | Implemented | `examples/providers/dnse.ts`, DNSE proxy in `examples/workstation/vite.config.ts` |
| FiinQuant chart provider | Verified at repository integration level | `examples/providers/fiinquant.ts`, `examples/sidecars/fiinquant/`, FiinQuant tests. Real provider access still depends on credentials/account limits. |
| FiinQuant adjusted history IndexedDB persistence | Verified | `examples/providers/fiinquant.ts`, `examples/providers/browser-history-cache.ts`, FiinQuant datafeed tests |
| FiinQuant cache-first daily/week/month chart load | Verified | `examples/providers/fiinquant.ts`, current tests around datafeed/cache behavior |
| FiinQuant direct-symbol fallback | Experimental | injected by `examples/workstation/scanner/vite-plugin-v5.ts`; actual history request remains validity check |
| FiinQuant watchlist quota protection | Experimental | injected by `examples/workstation/scanner/vite-plugin-v6.ts`; background FiinQuant watchlist feed work is suppressed |
| Vnstock chart provider | Verified at repository integration level | `examples/providers/vnstock.ts`, `examples/sidecars/vnstock/`, Vnstock tests |
| Vnstock polling realtime approximation | Implemented | `/latest` polling in `examples/providers/vnstock.ts`; not an exchange push stream |
| Synchronized multi-chart Replay | Verified | `examples/workstation/replay/`, replay tests and workstation browser coverage |
| Replay future-leak protection during timeframe projection | Verified | `examples/workstation/replay/replay-projection.ts`, replay unit tests |
| Replay + Heikin Ashi historical context preservation | Verified | seed-history behavior in `examples/workstation/replay/replay-session.ts` |
| Replay MarketHub source ownership | Verified | `examples/workstation/replay/replay-session.ts`, `examples/workstation/trading/paper.ts`, MarketHub tests |
| Paper trading | Implemented | `examples/workstation/trading/paper.ts`, `examples/workstation/trading/workspace.ts` |
| AI assistant in workstation | Implemented | `ASSISTANT.md`, `examples/workstation/assistant/`, `examples/sidecars/assistant/` |
| Scanner UI | Implemented | `examples/workstation/scanner/index.ts`, `style.css`, `api.ts` |
| Scanner two-stage engine | Verified | `examples/sidecars/scanner/engine.py`, scanner unit tests |
| Scanner SQLite cache/database | Verified | `examples/sidecars/scanner/db.py`, migrations, DB tests |
| Scanner FiinQuant source | Implemented | `examples/sidecars/scanner/providers.py`; requires FiinQuant credentials/runtime access |
| Scanner Binance Spot source | Implemented | `examples/sidecars/scanner/providers.py`; public Binance REST |
| Scanner Binance USD-M source | Implemented | `examples/sidecars/scanner/providers.py`; public Binance REST |
| Scanner price filter | Verified | Stage-1 DB query + scanner engine/tests |
| Scanner volume filter | Verified | Stage-1 DB query + scanner engine/tests |
| Scanner market-cap filter framework | Implemented | request/UI/DB support exists, but current built-in scanner providers report market cap unsupported |
| FiinQuant scanner market cap | Unsupported | provider capability has `market_cap=False` |
| Binance scanner market cap | Unsupported | provider capability has `market_cap=False` |
| `vn_eod` scanner market cap | Unsupported | local provider capability has `market_cap=False`; imported market cap remains NULL |
| Scanner Week/Month Heikin Ashi | Verified | `examples/sidecars/scanner/heikin_ashi.py`, scanner HA tests |
| Scanner current vs closed HA candle | Verified | request model + HA engine + UI |
| Scanner green / no-lower-wick / HA-close-change filters | Verified | scanner UI/model/engine and tests |
| CafeF adjusted EOD importer | Verified at parser/DB level | `examples/sidecars/scanner/cafef_eod.py`, `tests/test_cafef_eod.py` |
| CafeF local zero-network scan execution | Verified | `vn_eod` preloaded provider plus engine tests; local provider throws on attempted provider network methods |
| CafeF import audit metadata | Verified | `002_eod_import.sql`, DB/import APIs/tests |
| VN security-type classification | Verified at repository test level | `examples/sidecars/scanner/security_classifier.py`, CafeF/import tests |
| VN stock-universe freshness filter | Implemented | current CafeF import logic uses a 30-calendar-day active snapshot window for the local stock universe |
| Automatic OS-level CafeF daily import scheduling | Unsupported | importer command exists; Task Scheduler/cron integration is not built into the repo |
| PostgreSQL scanner storage | Unsupported | scanner currently uses SQLite |
| Redis/job queue scanner infrastructure | Unsupported | intentionally not present |
| TypeDoc API generation | Unsupported / not requested | not part of current documentation plan |
| MkDocs/GitHub Pages docs site | Unsupported / not requested | canonical docs remain repository Markdown |

## Important distinctions

### Implemented is not the same as available

Provider integrations may be present but unavailable at runtime because of credentials, account entitlements, upstream outages or local Python environment issues. The scanner exposes provider `available`/capability information instead of assuming that code presence means a source is usable.

### Heikin Ashi does not replace raw OHLC

The chart keeps raw market OHLC authoritative for datafeed/trading/indicator behavior and derives Heikin Ashi for display. The scanner likewise persists canonical daily OHLC and derives Week/Month Heikin Ashi locally.

### Local EOD scan and realtime chart are different paths

`vn_eod` is a scanner source, not a chart datafeed. Current result routing opens Vietnamese local-EOD scan results in the FiinQuant chart path rather than trying to chart from the scanner SQLite database.