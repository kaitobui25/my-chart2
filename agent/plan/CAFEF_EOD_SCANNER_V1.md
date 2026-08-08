# CafeF EOD Scanner V1

## Goal

Keep FiinQuant as the realtime Vietnamese-stock chart source, but move Vietnamese-stock scanning to a local EOD pipeline:

`CafeF adjusted EOD -> importer -> scanner SQLite -> local filters/HA -> scanner results -> click result -> FiinQuant chart`

The scanner must not depend on FiinQuant network requests for Vietnamese-stock scans.

## Scope

### In scope
- Add a provider-neutral local scanner source named `vn_eod`.
- Use CafeF adjusted EOD/Upto ZIP packages as the first `vn_eod` importer.
- Persist canonical adjusted 1D OHLCV into the scanner SQLite database.
- Reuse the existing Stage-1 SQL filters and Week/Month Heikin Ashi engine.
- Treat market cap as unsupported/NULL.
- Keep scan execution local after import.
- Add import audit/freshness metadata.
- Keep result-to-chart behavior: clicking a Vietnamese scanner result opens that symbol with FiinQuant.
- Add unit tests for parser, DB import, local scan behavior, freshness and source routing.

### Out of scope
- Replacing FiinQuant as the chart provider.
- Intraday CafeF data.
- PostgreSQL, Redis, ORM or job queues.
- Market-cap enrichment.
- Automatic OS scheduling in V1; provide an importer command that Task Scheduler/cron can call later.
- Scraping one CafeF page per symbol.

## Source contract

CafeF publishes downloadable AmiBroker/MetaStock data packages from its data-download page. V1 uses the adjusted trading-data packages:

- Daily EOD package: `CafeF.SolieuGD.<ddmmyyyy>.zip`
- Historical package: `CafeF.SolieuGD.Upto<ddmmyyyy>.zip`

The importer must not hard-code a single archive member filename or a single delimiter/header layout. It must:

1. Open ZIP archives safely.
2. Consider only text-like members (`.txt`, `.csv`, `.dat`, or extensionless text files).
3. Decode with a bounded fallback list (`utf-8-sig`, `utf-8`, `cp1258`, `latin-1`).
4. Detect delimiter from comma/semicolon/tab/pipe.
5. Detect common header aliases for ticker/date/open/high/low/close/volume/exchange.
6. Support the common AmiBroker/MetaStock positional OHLCV layouts when no usable header is present.
7. Reject invalid OHLC rows instead of silently repairing them.
8. Deduplicate by `(symbol, trading_date)` with the last valid record winning inside one import.

## Canonical data rules

- Provider id: `vn_eod`.
- Asset type: `STOCK`.
- Timezone/calendar: `Asia/Ho_Chi_Minh`, non-continuous market.
- Canonical interval stored in SQLite: `1d` only.
- Store timestamps at local trading-date midnight converted to Unix seconds.
- All imported EOD bars are closed.
- Price fields must be finite and > 0.
- `high >= max(open, close, low)` and `low <= min(open, close, high)`.
- Volume may be NULL; if present it must be finite and >= 0.
- `market_cap` remains NULL.
- Latest imported close/volume becomes `market_snapshot` for Stage 1.
- Week/Month bars and Heikin Ashi continue to be derived locally from canonical 1D data.

## Exchange mapping

Normalize exchange values to exactly:

- `HOSE`
- `HNX`
- `UPCOM`

If the archive row has no exchange field, infer exchange from the archive member/file name when possible. If neither row nor filename identifies the exchange, preserve the instrument with an empty exchange rather than guessing.

## Database changes

Keep existing tables unchanged unless required for compatibility. Add migration `002_eod_import.sql`.

### `eod_import_runs`

Fields:
- `id` INTEGER PK
- `provider` TEXT NOT NULL
- `source` TEXT NOT NULL
- `mode` TEXT NOT NULL (`eod` or `upto`)
- `adjusted` INTEGER NOT NULL
- `trade_date` INTEGER NULL
- `source_url` TEXT NULL
- `source_sha256` TEXT NULL
- `started_at` INTEGER NOT NULL
- `finished_at` INTEGER NULL
- `member_count` INTEGER NOT NULL DEFAULT 0
- `row_count` INTEGER NOT NULL DEFAULT 0
- `symbol_count` INTEGER NOT NULL DEFAULT 0
- `inserted_candle_count` INTEGER NOT NULL DEFAULT 0
- `status` TEXT NOT NULL
- `error` TEXT NULL

Indexes:
- provider/date/status lookup
- latest successful import lookup

DB API additions should be cohesive, not raw SQL spread across importer code:
- begin import audit
- finish import audit
- latest successful import
- bulk persist EOD rows

Bulk persistence must run in a small number of SQLite transactions and must not execute one commit per candle.

## Scanner source design

Extend `ProviderId` with `vn_eod`.

Add an explicit provider refresh mode/capability instead of identifying local behavior with `if provider == 'vn_eod'` throughout the engine.

Recommended capability:

- `refresh_mode = 'network' | 'preloaded'`

Existing sources:
- FiinQuant -> `network`
- Binance Spot -> `network`
- Binance USD-M -> `network`

New source:
- VN EOD -> `preloaded`

For `preloaded` sources, scanner execution must:

1. Read active symbols from SQLite.
2. Fail clearly if no imported universe exists.
3. Skip provider network refresh of instruments.
4. Skip provider network refresh of snapshots.
5. Skip provider network refresh of history.
6. Run Stage 1 from SQLite.
7. Recompute selected Week/Month HA from local 1D candles.
8. Query final results from SQLite.

This keeps network policy centralized in `ScannerEngine` instead of leaking into UI/importer code.

## Stage-1 filters

Make universe filtering provider-neutral for exchange-based stock sources.

Current FiinQuant-only exchange filtering must become capability-driven so both `fiinquant` and `vn_eod` can filter `HOSE/HNX/UPCOM` without special-case duplication.

Price/volume behavior stays unchanged.

Market-cap inputs stay disabled for `vn_eod` because market cap is unsupported.

## Freshness semantics

Realtime sources use TTL seconds as today.

`vn_eod` freshness is EOD/session based:
- A successful import records its trading date.
- Scanner results expose stale state based on the latest successful EOD import, not a 60/120-second network TTL.
- Weekend/non-trading-day use must not become stale merely because no new session exists.

V1 may implement a conservative age threshold for UI display if a full Vietnam holiday calendar is not available, but it must not cause network refresh because `vn_eod` is preloaded.

## CafeF importer

Add `examples/sidecars/scanner/cafef_eod.py` with separable responsibilities:

### Downloader
- Fetch CafeF data-download HTML.
- Discover the newest adjusted EOD/Upto links rather than synthesizing arbitrary URLs when possible.
- Allow explicit `--url` for deterministic/manual imports.
- Use bounded timeout and a descriptive User-Agent.
- Enforce max archive size.
- Hash downloaded bytes with SHA-256.

### Archive parser
Pure/testable functions:
- archive bytes -> members
- member text -> normalized records
- normalized records -> validated EOD records

No database writes inside parser functions.

### Import service
- Start audit row.
- Parse and validate archive.
- Bulk upsert instruments/candles/snapshots.
- Finish audit row.
- On failure, preserve previously imported scanner data and mark audit failed.

### CLI
Examples:

```bash
python cafef_eod.py import-latest
python cafef_eod.py import-latest --mode eod
python cafef_eod.py import-url <zip-url> --mode upto
python cafef_eod.py import-file <zip-file> --mode upto
python cafef_eod.py status
```

Environment:
- `SCANNER_DB_PATH` continues to control scanner DB location.
- Optional `CAFEF_DOWNLOAD_PAGE` override for tests/mirrors.

## Bootstrap and daily operation

### First run
Use adjusted `Upto 3 sàn` package and import sufficient history. Keep scanner retention at the existing bounded history policy unless later requirements need deeper history.

### Daily run
Use adjusted `EOD 3 sàn` once after CafeF publishes the completed session.

### Reconciliation
Because adjusted historical prices can change after corporate actions, support periodic Upto re-import. Upsert semantics must rewrite historical canonical candles when adjusted OHLCV changes.

Recommended operational policy:
- EOD import every trading day.
- Upto reconciliation weekly or after suspected corporate-action data changes.

## UI behavior

Add `VN EOD (CafeF)` as an available scanner source when local data is imported/configured.

Do not automatically force the scanner source to match the active chart source. Scanner source and chart source are separate concepts.

When a `vn_eod` result is clicked:
- switch chart provider to `fiinquant` if needed;
- open the same symbol.

Binance result routing remains unchanged.

The results table should retain the existing columns. Freshness should reflect local EOD import status.

## Maintainability rules

- No CafeF-specific parsing logic in `engine.py`.
- No SQLite SQL in UI code.
- No network calls inside DB classes.
- No DB writes inside pure parser functions.
- Keep provider refresh behavior capability-driven.
- Keep 1D as the only persisted candle interval for scanner calculations.
- Prefer typed dataclasses for imported EOD records and importer results.
- Centralize column aliases and exchange normalization.
- Bound all downloads, parser inputs and database retention.
- Fail loudly on unsupported archive formats; never manufacture OHLC values.

## Build order

1. Add this plan.
2. Confirm branch cleanup/main-only state.
3. Add schema migration and DB import APIs.
4. Add provider refresh-mode capability and `vn_eod` source.
5. Refactor ScannerEngine for network vs preloaded refresh paths.
6. Generalize Stage-1 universe filtering.
7. Build CafeF downloader/parser/import service/CLI.
8. Update scanner UI source typing/routing.
9. Add/extend unit tests.
10. Run Python scanner tests.
11. Run TypeScript/unit/build checks.
12. Inspect CI on main and fix regressions.

## Test matrix

### Parser
- headered CSV
- headerless MetaStock/AmiBroker layout
- comma/tab/semicolon separators
- BOM/encoding fallback
- invalid OHLC rejected
- duplicate symbol/date deduped
- exchange normalization/inference
- ZIP path traversal names ignored safely
- non-text members ignored

### DB/import
- initial Upto bootstrap
- EOD upsert
- adjusted historical rewrite
- latest snapshot follows newest candle
- audit success/failure
- failed import leaves old data intact

### Engine
- `vn_eod` performs zero provider network-refresh methods
- empty local DB fails clearly
- HOSE/HNX/UPCOM filters work for `vn_eod`
- Week/Month HA results match existing fixtures
- market-cap constraints remain unavailable for `vn_eod`

### UI/routing
- scanner source can stay `vn_eod` while chart uses FiinQuant
- clicking VN EOD result opens symbol through FiinQuant
- Binance behavior unchanged

## Acceptance criteria

V1 is complete when:

1. One adjusted CafeF Upto ZIP can bootstrap VN scanner history into `scanner.db`.
2. One adjusted CafeF EOD ZIP can incrementally update that DB.
3. A `vn_eod` scan makes no CafeF/FiinQuant/Binance network request during scan execution.
4. Existing Price/Volume + HA Week/Month filters return results from local SQLite.
5. HOSE/HNX/UPCOM filtering works.
6. Clicking a VN result opens the matching FiinQuant chart.
7. Import status/failures are auditable.
8. Existing FiinQuant/Binance scanner/chart behavior does not regress.
9. Scanner Python tests and project CI pass.
