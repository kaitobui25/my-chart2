# Current Scanner

**Generated:** 2026-08-14  
**Documented main:** `114f9e18697b73759cbacccae6eed8936d902335`  

The scanner is an application subsystem outside the stable chart package. It combines a browser UI with a local Python/aiohttp sidecar and SQLite cache/database.

## Entry points

Browser UI:

- `examples/workstation/scanner/index.ts`
- `examples/workstation/scanner/api.ts`
- `examples/workstation/scanner/types.ts`
- `examples/workstation/scanner/style.css`

Backend:

- `examples/sidecars/scanner/scanner_sidecar.py`
- `examples/sidecars/scanner/engine.py`
- `examples/sidecars/scanner/providers.py`
- `examples/sidecars/scanner/db.py`
- `examples/sidecars/scanner/heikin_ashi.py`
- `examples/sidecars/scanner/models.py`

Default sidecar address:

```text
127.0.0.1:8730
```

Default SQLite path:

```text
examples/sidecars/scanner/data/scanner.db
```

`SCANNER_DB_PATH` can override the database location.

## HTTP API

Current endpoints in `examples/sidecars/scanner/scanner_sidecar.py`:

- `GET /health`
- `GET /sources`
- `GET /eod/status`
- `POST /eod/import-latest`
- `POST /scan`
- `GET /runs/{run_id}`
- `POST /backup`

Scans are asynchronous. `POST /scan` creates a run and returns HTTP 202; the UI polls the run endpoint until completion/error.

`GET /eod/status` reports CafeF local coverage: latest imported trade date, active/snapshot symbol counts, per-symbol retention and active-max-age constants, plus whether an EOD update is running. `POST /eod/import-latest` runs the same CafeF import used by the CLI; it returns HTTP 409 while an update is already running and HTTP 502 on import failure.

## UI filters

The current scanner UI exposes:

- Source.
- Universe(s).
- Price min/max.
- Volume min/max.
- Market cap min/max when the selected source advertises support.
- Heikin Ashi timeframe: exactly one of Week (`1w`) or Month (`1M`).
- Candle kind: current or closed.
- Minimum HA-close percentage change versus the previous HA close.
- Green candle requirement.
- No-lower-wick requirement.

Unsupported market-cap controls are disabled in the UI and submitted as NULL constraints.

Results display symbol, exchange/name, price, volume, market cap, HA timeframe/state, no-lower-wick state, HA close change, HA body percentage, candle time and freshness.

Clicking a result calls the workstation scanner bridge to open the symbol.

## Provider capability model

The engine does not hard-code one refresh path for every source. Each `ScannerProvider` exposes capabilities including:

- id/label;
- available/detail;
- market-cap support;
- bulk snapshot/history support;
- universes/default universes;
- timezone/calendar behavior;
- concurrency limits;
- freshness TTLs;
- continuous-market flag;
- refresh mode.

The key refresh-mode split is:

```text
network   -> scanner may refresh instruments/snapshots/history from provider
preloaded -> scanner must use already-imported SQLite data
```

Current `vn_eod` uses `preloaded`; FiinQuant/Binance sources use network refresh behavior.

## Two-stage execution

The main flow in `examples/sidecars/scanner/engine.py` is:

```text
provider + request
      ↓
refresh instruments if network source and stale
      ↓
list active symbols
      ↓
refresh snapshots if network source and needed
      ↓
Stage 1 SQL candidates
(price / volume / market cap / universe)
      ↓
refresh candidate daily history if network source
      ↓
compute selected Week/Month HA locally
      ↓
Stage 2 final HA filter query
      ↓
results + freshness/warnings
```

The design deliberately applies cheap Stage-1 filters before expensive historical refresh/HA work.

## Network-source caching policy

Current engine constants:

- instrument metadata TTL: 6 hours;
- deep history bootstrap target: 800 daily bars;
- retained daily history: 1000 bars per instrument;
- incremental refresh overlap: 4 days.

If a candidate has no daily history, it enters bootstrap refresh. If cached history exists but is older than the provider history TTL, an overlapping recent refresh is requested.

Provider refresh failure does not automatically erase valid cached data. Snapshot/history refresh paths add warnings and can continue with cache where the implementation has enough previous data.

## SQLite schema

Migration `examples/sidecars/scanner/migrations/001_initial.sql` creates:

### `instruments`

Provider/symbol identity plus name, exchange, asset type, active state and last-seen time.

Unique key:

```text
(provider, symbol)
```

### `market_snapshot`

One latest snapshot per instrument:

- price;
- volume;
- market cap (nullable);
- provider data time;
- fetched time.

### `candles`

Canonical candle cache keyed by:

```text
(instrument_id, interval, time)
```

The current scanner design stores canonical daily (`1d`) history for its Week/Month HA calculations rather than requiring duplicate imported Week/Month source history.

### `ha_latest`

Latest computed HA metrics keyed by:

```text
(instrument_id, timeframe, kind)
```

Stored fields include HA OHLC, green, no-lower-wick, HA-close-change percentage, HA-body percentage, algorithm version, source-last-time and compute time.

### `scan_runs`

Audit/progress data for a scanner request:

- universe count;
- Stage-1 count;
- history refresh count;
- Stage-2 count;
- result count;
- serialized filters;
- status/error/timestamps.

Migration `002_eod_import.sql` adds `eod_import_runs` for local EOD ingestion audit.

## Heikin Ashi scanner contract

Implementation: `examples/sidecars/scanner/heikin_ashi.py`.

The scanner derives HA from canonical market OHLC rather than storing imported synthetic candles.

Current filter concepts:

- `green`: HA close > HA open;
- `no_lower_wick`: evaluated with the scanner's numeric tolerance;
- `ha_close_change_pct`: current selected HA close versus previous HA close;
- `ha_body_pct` is stored/displayed as an additional metric;
- `kind` selects current or last closed target candle.

Minimum daily history before evaluating a candidate in the engine is currently:

- 20 daily candles for Week HA;
- 60 daily candles for Month HA.

These are engine eligibility minimums, not a claim that they provide infinite historical warm-up.

## FiinQuant scanner source

`FIinQuantProvider` in `examples/sidecars/scanner/providers.py`:

- obtains universes with FiinQuant `TickerList`;
- maps HOSE/HNX/UPCOM to provider-specific index identifiers;
- stores normalized exchange values back as HOSE/HNX/UPCOM;
- fetches snapshots/history in bounded batches;
- uses adjusted daily trading data;
- does not currently expose market cap.

Credentials come from environment or the FiinQuant sidecar `.env` read by scanner startup.

## Binance scanner sources

`BinanceProvider` supports:

- `binance_spot`;
- `binance_usdm`.

It uses public REST endpoints. Active/tradable exchange metadata creates instruments, 24-hour ticker data supplies Stage-1 snapshot values, and daily klines supply candidate history.

Both built-in Binance scanner sources currently advertise market cap unsupported.

## Vietnamese local EOD source

`LocalEodProvider` (`vn_eod`) explicitly implements a zero-network scan contract.

Capabilities:

- HOSE/HNX/UPCOM;
- Asia/Ho_Chi_Minh;
- preloaded refresh mode;
- no market cap;
- no provider history/snapshot calls while scanning.

Its network-style provider methods deliberately raise `vn_eod is preloaded; scanner execution must not request provider data` if called.

### Import pipeline

Implementation: `examples/sidecars/scanner/cafef_eod.py`.

```text
CafeF adjusted archive
    ↓
ZIP/member parsing
    ↓
row validation + normalization
    ↓
deduplicate symbol/date rows
    ↓
bulk SQLite persistence
    ↓
import audit
    ↓
rebuild/update local active stock universe
```

The importer supports daily EOD and historical Upto packages. It accepts deterministic local-file or explicit-URL imports in addition to discovering the latest package.

### Scanner UI status card and EOD update

When `VN EOD (CafeF)` is selected, the workstation scanner panel shows a compact local-data status card: latest imported trade date, active stock count, per-symbol retention and a freshness badge with a **Cập nhật EOD** button. Its **Cập nhật EOD** button calls `POST /eod/import-latest`, which reuses the same importer service as the CLI (`cafef_eod._import_latest`, equivalent to `python cafef_eod.py import-latest --mode eod`) rather than spawning a second Python process.

The network download and ZIP parsing run off the aiohttp event loop. Only one CafeF EOD update may run at a time; a concurrent `POST /eod/import-latest` returns HTTP 409. The UI disables scan/update controls while its own update is active.

### Validation boundary

The importer rejects invalid OHLC instead of silently fixing market prices. Canonical price values must be finite/positive and obey high/low consistency. Volume may be NULL but cannot be a negative/invalid finite value when present.

### Import audit

`eod_import_runs` records provider/source/mode, adjusted flag, trade date, source URL/hash, start/end time, member/row/symbol/inserted-candle counts, status and error.

This allows later inspection of where local scanner data came from rather than treating SQLite contents as unaudited cache.

### Active stock classification/freshness

Current CafeF/local-universe behavior keeps a security active for stock scanning when:

1. its local snapshot is within 30 calendar days of the newest `vn_eod` snapshot; and
2. its classifier result is `STOCK`.

Current classifier families documented by the scanner sidecar:

- `STOCK`: exactly three alphanumeric characters;
- `CW`: HOSE covered-warrant pattern such as `CHPG2632`;
- `ETF`: `E1VFVN30` or `FUE...` families;
- `FUND`: `FUC...` families;
- otherwise `UNKNOWN`.

Non-stock/fresh and stale rows can remain in SQLite for history/audit while being excluded from the active stock universe.

## `vn_eod` result routing

The local scanner source is intentionally decoupled from chart data.

Current behavior:

```text
vn_eod result
    ↓ click
scanner bridge
    ↓
switch/open FiinQuant chart
```

This means CafeF is used for cheap local screening while FiinQuant remains the Vietnamese realtime chart path.

## Freshness shown to the user

Network-source result freshness is derived from snapshot fetch timing against provider TTL.

For preloaded `vn_eod`, the engine uses the latest successful import's trade date when available. A missing successful import audit produces a warning. Local EOD data older than the preloaded source freshness threshold is marked stale.

Do not confuse the five-day `vn_eod` result staleness threshold in provider capabilities with the separate 30-calendar-day active-universe inclusion rule used by the CafeF importer.

## Backup

The sidecar exposes `POST /backup`; `ScannerDB` owns the database backup implementation. The runtime database is rebuildable from providers/imports, but import/run audit makes backups useful for investigation.

## Current maintenance concerns

1. Scanner architecture is reasonably separated at the Python provider/engine/DB boundary, but workstation integration has accumulated layered `vite-plugin-v*.ts` transforms that also carry non-scanner FiinQuant runtime patches.
2. Current built-in scanner sources do not supply market cap even though the generic filter/database/UI contract supports it.
3. `vn_eod` ingestion remains an explicit command; automatic daily Task Scheduler/cron installation is not implemented.
4. The local source depends on CafeF package format/discovery remaining compatible with importer parsing rules; parser tests cover known layouts but upstream format changes remain an external risk.