# Binance Local Archive + SQLite V1

Build a crypto chart path where Binance Public Data Archive is used only to populate a local project database. After a symbol has been imported, normal chart use, timeframe switching, reopening the symbol, and Replay must read from the PC only. Network access happens only when the user explicitly imports a new symbol or presses a manual update button.

## Decision

V1 uses **Binance Spot public archive**, not Binance REST and not Binance WebSocket.

Remote source:

```text
https://data.binance.vision/
```

Canonical local store:

```text
<project-root>/data/binance-archive/binance.sqlite3
```

The SQLite file is local runtime data and must be ignored by Git.

## User-visible behavior

### Existing local symbol

Example: `BTC/USDT` has already been imported.

```text
Search/select BTC/USDT
        ↓
normalize -> BTCUSDT
        ↓
SQLite contains BTCUSDT
        ↓
load candles from local SQLite only
        ↓
NO Binance network request
```

This rule also applies to:

- changing timeframe;
- reopening BTC/USDT later;
- reopening the workstation;
- Replay/backtest;
- changing chart layout;
- indicators that only consume chart candles.

No freshness check may silently contact Binance.

### New symbol

Example: `ETH/USDT` is not installed locally.

```text
Search/select ETH/USDT
        ↓
normalize -> ETHUSDT
        ↓
SQLite has no ETHUSDT
        ↓
first import from Binance Public Data Archive
        ↓
verify + parse + write SQLite
        ↓
subsequent ETH/USDT use is local only
```

Do not make network calls for every search keystroke. Search should be local/syntactic; the archive import starts only after the user selects/submits an exact new pair.

### Manual update

Add an explicit action such as:

```text
Update Data
```

Pressing it updates only the currently selected local symbol.

No automatic daily refresh, startup refresh, interval refresh, Replay refresh, timer, or background job in V1.

If the user thinks the local data is old, the user presses the button.

## Why SQLite is the source of truth

The current chart already has provider-neutral `Datafeed.getHistory()` and Replay calls the active datafeed for raw history. Therefore the cleanest design is a new local datafeed whose `getHistory()` reads SQLite.

For this provider:

- SQLite is the canonical history store;
- browser IndexedDB is not required as the source of truth;
- Replay must not create another historical store;
- the same local history path feeds normal chart and Replay.

This keeps chart core and Replay provider-neutral.

## Archive strategy

Binance Public Data publishes kline ZIPs as daily and monthly files and supports the intervals used by this chart. V1 intentionally imports only **1m** as canonical raw history and derives all larger chart intervals locally.

Official archive layout example:

```text
data/spot/monthly/klines/BTCUSDT/1m/BTCUSDT-1m-2026-07.zip
```

Daily example:

```text
data/spot/daily/klines/BTCUSDT/1m/BTCUSDT-1m-2026-08-21.zip
```

The archive uses `1mo` for native month files, but V1 does not need to download native higher intervals because all chart intervals are derived from canonical local `1m` candles.

### Why canonical 1m

Benefits:

- one archive source per symbol instead of downloading the same history 11 times;
- Replay can use the smallest chart interval directly;
- higher timeframes are deterministic local derivatives;
- no network call is needed when a user switches timeframe;
- one consistent OHLC source avoids cross-timeframe archive discrepancies;
- manual update only needs to append missing `1m` history.

Tradeoff:

- initial import of long-lived symbols such as BTCUSDT is larger than importing only `1d`;
- local disk usage is intentionally traded for offline behavior.

This matches the stated goal: PC-first history and no repeated remote requests.

## Supported chart intervals

Current workstation interval set:

```text
1m 3m 5m 15m 30m 1h 2h 4h 1d 1w 1M
```

Storage/derivation policy:

| Chart interval | Source |
|---|---|
| `1m` | canonical archive rows in SQLite |
| `3m` | derive locally from `1m` |
| `5m` | derive locally from `1m` |
| `15m` | derive locally from `1m` |
| `30m` | derive locally from `1m` |
| `1h` | derive locally from `1m` |
| `2h` | derive locally from `1m` |
| `4h` | derive locally from `1m` |
| `1d` | derive locally from `1m`, UTC day boundary |
| `1w` | derive locally, Monday 00:00 UTC |
| `1M` | derive locally, first day of calendar month 00:00 UTC |

Reuse the repository's existing calendar interval rules. Do not implement month as a fixed 30-day bucket.

## Derived interval cache

Do not recompute millions of `1m` rows on every chart load.

Use lazy local materialization:

```text
first request BTCUSDT 4h
        ↓
SQLite has no/partial derived 4h coverage
        ↓
read needed BTCUSDT 1m range locally
        ↓
aggregate locally
        ↓
store derived 4h candles in SQLite
        ↓
return candles

next request BTCUSDT 4h
        ↓
direct SQLite read
```

No network is involved in derived interval generation.

When manual update appends new `1m` candles, invalidate/rebuild only derived buckets that overlap the newly added time range. Do not rebuild all BTC history.

## Local service architecture

A browser cannot read a project SQLite file directly. Use a small loopback sidecar.

Prefer Python standard library only:

- `sqlite3`;
- `urllib.request`;
- `zipfile`;
- `csv`;
- `hashlib`;
- `http.server` or the smallest existing project-compatible HTTP layer.

Avoid adding a native Node SQLite dependency in V1. The repo supports Node >=20, while relying on newer `node:sqlite` behavior would unnecessarily narrow runtime compatibility.

Target:

```text
Workstation browser
      |
BinanceLocalDatafeed (TypeScript)
      |
/binance-local-api
      |
Vite same-origin proxy
      |
127.0.0.1:8750
      |
Binance local archive sidecar
      |
SQLite -------------------------- normal chart / Replay
      |
Binance Public Data Archive ----- only import/update commands
```

Port `8750` follows the existing local provider ports (`8720` FiinQuant, `8730` scanner, `8740` Vnstock).

## Proposed files

```text
examples/providers/binance-local.ts
examples/sidecars/binance-local/
  binance_local_sidecar.py
  binance_local_core.py
  README.md
  test_binance_local.py
examples/workstation/provider-runtime/...
tests/unit/binance-local-datafeed.test.ts
```

Runtime data:

```text
data/binance-archive/
  binance.sqlite3
  tmp/
```

Add this runtime directory to `.gitignore`.

Temporary ZIP/CSV files are deleted after a successful transactional import. SQLite remains the durable copy.

## Local HTTP contract

Keep history reads separate from network-changing commands.

### `GET /health`

Local-only.

Returns:

- service status;
- DB path;
- DB schema version;
- DB size;
- installed symbol count.

### `GET /symbols?q=&limit=`

Local-only.

Returns installed symbols from SQLite.

For a syntactically valid exact query such as `ETH/USDT`, the browser may also present a normalized candidate `ETHUSDT` even when it is not installed. This must not contact Binance.

### `GET /symbol-status?symbol=BTCUSDT`

Local-only.

Returns:

- installed/not installed;
- first local candle;
- last local candle;
- last manual import/update time;
- canonical interval coverage;
- DB rows/size if cheap to calculate.

### `GET /history?symbol=&interval=&from=&to=&limit=`

Local-only.

Rules:

- never contacts Binance;
- reads canonical or derived SQLite candles;
- creates missing derived interval coverage from local `1m` only;
- returns normalized chart candles in ascending time order.

### `POST /import`

Explicit network command for a symbol not yet installed.

Input:

```json
{
  "symbol": "BTCUSDT"
}
```

Behavior:

1. validate normalized symbol;
2. discover available `1m` archive files;
3. download historical monthly archives;
4. fill the current partial month with available daily archives;
5. download the matching `.CHECKSUM` when available;
6. verify SHA-256;
7. parse CSV rows;
8. normalize timestamps;
9. insert one archive file in one SQLite transaction;
10. record the completed source file in the import ledger;
11. delete temporary ZIP/CSV;
12. return local coverage/status.

If interrupted, completed files stay committed and the next import resumes from the import ledger.

### `POST /refresh`

Explicit network command used only by the user's **Update Data** button.

Behavior:

1. require the symbol to already exist locally;
2. read the last canonical local `1m` time;
3. determine missing completed archive periods;
4. use monthly archives for fully completed missing months;
5. use daily archives for the remaining partial month;
6. append/update canonical rows transactionally;
7. invalidate only overlapping derived buckets;
8. update local metadata;
9. return the new last candle.

A failed refresh must not delete or corrupt the existing local dataset.

## SQLite schema V1

Keep it small and inspectable.

### `schema_meta`

```text
key TEXT PRIMARY KEY
value TEXT NOT NULL
```

Stores schema version and source-format version.

### `symbols`

```text
market TEXT NOT NULL
symbol TEXT NOT NULL
base_asset TEXT
quote_asset TEXT
first_time INTEGER
last_time INTEGER
last_import_at INTEGER
last_refresh_at INTEGER
PRIMARY KEY (market, symbol)
```

V1 market value:

```text
spot
```

Keep the market field now so USD-M can be added later without replacing the schema.

### `candles`

```text
market TEXT NOT NULL
symbol TEXT NOT NULL
interval TEXT NOT NULL
open_time INTEGER NOT NULL
open REAL NOT NULL
high REAL NOT NULL
low REAL NOT NULL
close REAL NOT NULL
volume REAL NOT NULL
source TEXT NOT NULL
PRIMARY KEY (market, symbol, interval, open_time)
```

`source` examples:

```text
archive:1m
derived:1m:v1
```

The composite primary key is sufficient for the main range query pattern.

### `coverage`

```text
market TEXT NOT NULL
symbol TEXT NOT NULL
interval TEXT NOT NULL
from_time INTEGER NOT NULL
to_time INTEGER NOT NULL
PRIMARY KEY (market, symbol, interval, from_time, to_time)
```

Use confirmed coverage so a partial import is never mistaken for complete history.

### `archive_imports`

```text
market TEXT NOT NULL
symbol TEXT NOT NULL
archive_path TEXT NOT NULL
sha256 TEXT
row_count INTEGER NOT NULL
first_time INTEGER
last_time INTEGER
imported_at INTEGER NOT NULL
PRIMARY KEY (market, symbol, archive_path)
```

This is the resume/audit ledger. A file is recorded only after its candle transaction succeeds.

## Timestamp normalization

This is mandatory because Binance Spot archive timestamp units changed.

Official Binance Public Data documentation notes that Spot archive timestamps from 2025-01-01 onward are in microseconds.

Normalize archive open time to Unix seconds before writing SQLite:

```text
microseconds -> / 1_000_000
milliseconds -> / 1_000
```

Do not infer the unit from the current date alone. Detect it safely from numeric magnitude and test both historical millisecond rows and newer microsecond rows.

The database uses Unix seconds, matching the chart's `Candle.time` contract.

## Archive integrity

For downloaded archive files:

1. use HTTPS only;
2. download `.CHECKSUM` when published;
3. SHA-256 verify before import;
4. reject malformed CSV rows;
5. validate finite OHLCV;
6. reject impossible OHLC relationships such as `high < low`;
7. import per file inside a SQLite transaction;
8. never mark coverage complete before commit.

Do not keep a corrupt/partial archive as valid local history.

## SQLite runtime policy

Recommended connection pragmas:

```text
journal_mode = WAL
synchronous = NORMAL
foreign_keys = ON
```

Writes happen only during import/refresh/derived materialization. Normal chart use is read-heavy.

Avoid `VACUUM` on every update. If ever exposed, make database maintenance a separate manual operation.

## Datafeed contract

Create `BinanceLocalDatafeed` implementing the existing provider-neutral `Datafeed` contract.

### `getHistory()`

Calls local `/history` only.

It must never fall back to Binance REST when data is missing. Missing local data should be reported as missing local coverage so the UI can offer Import/Update explicitly.

### `getCachedHistory()`

Can call the same local SQLite history path because SQLite itself is the persistent cache/source of truth.

No browser IndexedDB dependency is required for this provider.

### `subscribe()`

No realtime in V1.

Return a no-op unsubscribe function.

### `subscribeMany()`

No realtime/watchlist polling in V1.

Return a no-op unsubscribe function or omit the optional method if workstation behavior permits.

### `searchSymbols()`

Search installed SQLite symbols locally and support syntactic exact-pair candidates without remote lookup.

Normalize common user input:

```text
BTC/USDT -> BTCUSDT
btc-usdt -> BTCUSDT
btcusdt  -> BTCUSDT
```

Do not remove arbitrary characters in a way that turns malformed input into an unintended valid symbol; keep normalization explicit.

## Workstation integration

Add a provider entry such as:

```text
Binance Local
```

V1 should make the local provider the obvious PC-first option without deleting the existing Binance providers during the experiment.

Provider status should expose:

- Local / Offline-ready;
- installed symbol;
- local first/last candle date;
- DB size;
- Update Data action.

For a missing symbol:

```text
Not downloaded
```

and the exact selection/import action can start the first archive import.

For an installed stale symbol, do **not** auto-update. Show the last local date and let the user decide.

## Replay integration

Do not create Replay-specific Binance code.

Current Replay already calls the active `Datafeed.getHistory()` for its shared raw interval. Therefore selecting `Binance Local` should naturally make Replay read SQLite.

Required behavior:

```text
Replay start
    ↓
choose base interval
    ↓
BinanceLocalDatafeed.getHistory()
    ↓
local sidecar /history
    ↓
SQLite canonical/derived candles
```

No Replay operation may call `/import` or `/refresh` automatically.

If Replay asks for a range not locally covered, fail clearly with an offline/local coverage message. The user can stop Replay and press Import/Update manually.

Retain the existing 20,000 raw-bar Replay safety limit in V1 unless a separate task intentionally changes it.

## Manual update UX

Minimal V1 controls:

```text
Binance Local
BTC/USDT
Local through: 2026-08-20
[Update Data]
```

Button states:

```text
Update Data
Downloading…
Importing…
Up to date
Failed — local data kept
```

Do not add scheduling UI, refresh interval settings, automatic retry loops, or background synchronization.

## Import progress

A first BTCUSDT full `1m` import can be large. Progress is useful but keep the protocol simple.

The import command/status should report at least:

- archive files completed / total;
- rows imported;
- current archive file;
- local first/last candle;
- error if stopped.

A lightweight polling status endpoint is acceptable while an explicit import/update is running. It is local loopback polling, not Binance polling.

Do not spawn parallel archive downloads aggressively. V1 should prefer predictable sequential or very low-concurrency downloading to reduce failures and remote load.

## Failure and resume rules

### Network lost during first import

- keep all previously committed archive files in SQLite;
- do not mark the current incomplete file imported;
- next explicit import resumes from `archive_imports`.

### Network lost during manual refresh

- old chart data remains usable;
- report refresh failure;
- no automatic retries after the explicit operation ends.

### Sidecar unavailable

- mark `Binance Local` unavailable;
- do not silently switch to online Binance.

### Missing archive file

- treat expected 404 for the newest not-yet-published daily archive as not available yet;
- do not create fake coverage;
- other unexpected gaps should be reported.

## Source update/replacement policy

Binance notes that archived files can be replaced later when data issues are found.

V1 does not continuously revalidate old files.

Normal **Update Data** focuses on extending local coverage forward.

A future separate `Repair/Revalidate History` action can compare historical checksums and re-import changed archives if this becomes necessary. Do not add that complexity to V1.

## V1 scope

### In scope

- Binance Spot;
- USDT-style pairs such as BTCUSDT/ETHUSDT;
- static Binance Public Data Archive;
- canonical local `1m` candles;
- all current chart timeframes derived locally;
- SQLite inside project folder;
- first-symbol import;
- manual update button;
- normal chart local reads;
- Replay local reads;
- import resume ledger;
- checksum verification;
- offline operation after import.

### Explicit non-goals

- no Binance REST `/api/v3/klines` fallback;
- no WebSocket;
- no realtime candle;
- no auto-refresh at startup;
- no daily scheduler;
- no cloud database;
- no remote symbol search on each keystroke;
- no bulk predownload of all Binance symbols;
- no USD-M futures in V1;
- no order book/DOM;
- no live watchlist prices;
- no automatic archive revalidation of years of old files;
- no migration of Vietnam providers to SQLite in this task.

## Build order

### Phase 1 — local storage core

1. Add ignored runtime path `data/binance-archive/`.
2. Add SQLite schema/migration bootstrap.
3. Add repository-local DB path resolution.
4. Add canonical candle range read/write tests.
5. Add archive import ledger and coverage semantics.

### Phase 2 — archive importer

6. Implement deterministic Binance archive path builder.
7. Implement monthly/daily file discovery for Spot `1m`.
8. Implement ZIP + optional CHECKSUM download.
9. Implement SHA-256 validation.
10. Implement CSV parser and OHLCV validation.
11. Implement millisecond/microsecond timestamp normalization.
12. Import each archive file transactionally.
13. Delete temporary files after success.
14. Implement resumable first-symbol import.
15. Implement forward-only manual refresh.

### Phase 3 — local interval engine

16. Read canonical `1m` ranges.
17. Reuse/match existing interval bucket semantics.
18. Aggregate `3m` through `1M` locally.
19. Persist derived candles/coverage lazily.
20. Invalidate only affected derived tail buckets after refresh.
21. Test UTC day/week/month boundaries.

### Phase 4 — loopback service

22. Add health/status/history/symbol endpoints.
23. Add explicit import and refresh commands.
24. Add operation progress/status.
25. Guarantee history/symbol/status endpoints never touch network.
26. Bind loopback only.

### Phase 5 — TypeScript datafeed

27. Add `BinanceLocalDatafeed`.
28. Local-only history parsing.
29. Local installed-symbol search + exact candidate normalization.
30. No-op realtime methods.
31. Clear error for missing local coverage rather than online fallback.

### Phase 6 — workstation UI

32. Add `Binance Local` provider selection.
33. Add local coverage/status display.
34. Add first-import flow for unknown exact symbol.
35. Add manual **Update Data** button.
36. Do not auto-refresh on provider/symbol/timeframe changes.
37. Keep existing Binance Spot/USD-M providers intact during V1 evaluation.

### Phase 7 — Replay

38. Verify Replay reads the active local datafeed unchanged.
39. Verify multi-timeframe Replay derives only from local history.
40. Verify Replay never triggers import/update/network.
41. Verify missing local Replay coverage fails explicitly.

### Phase 8 — regression

42. `npm run typecheck`.
43. `npm run build:demo`.
44. local sidecar unit tests.
45. existing unit tests.
46. Replay regression tests.
47. browser smoke test with Binance Local selected.

## Required tests

### Archive parser

- pre-2025 millisecond Spot timestamps;
- 2025+ microsecond Spot timestamps;
- malformed rows;
- invalid numeric OHLCV;
- checksum pass/fail;
- duplicate row idempotency.

### Database

- first import creates symbol and canonical coverage;
- second import resumes/skips completed archive files;
- local range query returns ordered candles;
- interrupted file does not create false coverage;
- derived interval cache is local and deterministic;
- refresh invalidates only affected derived tail.

### Network policy

Use injected/mocked downloader/fetch counters.

Must prove:

- selecting installed BTCUSDT makes **zero** Binance requests;
- timeframe switch makes **zero** Binance requests;
- Replay makes **zero** Binance requests;
- restarting workstation and selecting installed BTCUSDT makes **zero** Binance requests;
- selecting new ETHUSDT starts an explicit archive import;
- pressing Update Data starts an explicit archive refresh;
- failed local coverage never falls back to online Binance REST.

This network-policy test is a release blocker for V1.

### Replay

- Replay BTCUSDT uses SQLite history;
- mixed target intervals use one local raw source as today;
- local calendar aggregation does not leak future OHLC;
- missing coverage produces an explicit local/offline error.

## Acceptance criteria

V1 is accepted when all of the following are true:

1. User imports BTC/USDT once.
2. BTCUSDT `1m` history is stored in `<project-root>/data/binance-archive/binance.sqlite3`.
3. Restarting the workstation still loads BTC/USDT from SQLite.
4. Switching every supported timeframe does not contact Binance.
5. Higher intervals come from local `1m` data and can be cached locally.
6. Replay/backtest BTC/USDT runs from local SQLite only.
7. Searching/selecting already-installed BTC/USDT makes zero Binance requests.
8. Selecting a new exact pair such as ETH/USDT can trigger its first explicit archive import.
9. Data never auto-refreshes merely because it is old.
10. User can explicitly press **Update Data** to extend only the active symbol.
11. A failed update leaves the previous SQLite data intact and usable.
12. No login, API key, Binance account, REST kline call, or WebSocket is required.
13. Existing non-local providers still work as before.

## Implementation guardrails

- Simple is best.
- SQLite is the single PC history source for this provider.
- No silent network fallback.
- No automatic refresh.
- One canonical `1m` source, local higher-timeframe derivation.
- Reuse current `Datafeed`, interval, aggregation, and Replay contracts instead of forking chart core.
- Keep downloader/network code behind explicit import/update commands.
- Prefer Python standard library over new native dependencies.
- Keep source-specific code outside stable chart core.
- Preserve existing providers until the local path has been proven in real use.

## References used for this plan

Repository:

- `src/datafeed.ts`
- `src/interval.ts`
- `src/candle-aggregation.ts`
- `docs/current/DATA_SOURCES.md`
- `docs/current/REPLAY.md`
- `examples/providers/binance.ts`

Binance official public archive:

- `https://github.com/binance/binance-public-data`
- `https://data.binance.vision/`

Relevant official archive facts used above:

- public downloadable market data is provided as daily/monthly files;
- all needed kline intervals are available;
- `1mo` is used for month archive naming;
- `.CHECKSUM` files are published for integrity verification;
- archived files may later be replaced after discovered issues;
- Spot archive timestamps from 2025-01-01 onward use microseconds.
