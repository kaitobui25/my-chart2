# Scanner sidecar

Local scanner service for the workstation. It uses only `aiohttp` plus Python's standard `sqlite3` and stores its rebuildable cache in `data/scanner.db`.

The normal workstation launcher starts this sidecar automatically. Manual start:

```bash
python scanner_sidecar.py
```

Endpoints:

- `GET /health`
- `GET /sources`
- `GET /eod/status`
- `POST /eod/import-latest`
- `POST /scan`
- `GET /runs/{id}`
- `POST /backup`

FiinQuant credentials are read from `../fiinquant/.env`. Binance sources use public REST APIs and require no API key.

Heikin Ashi accepts exactly one timeframe per scan: `1w` or `1M`.

## Vietnamese stocks: CafeF EOD -> local scanner

`vn_eod` is a preloaded scanner source. It does not call CafeF, FiinQuant or another market-data provider while a scan is running. CafeF adjusted EOD data is imported into the same `scanner.db`, then Price/Volume filters, Week/Month aggregation and Heikin Ashi are computed locally.

FiinQuant remains the realtime chart source. Clicking a `vn_eod` result switches the chart to FiinQuant and opens the selected ticker.

### Scanner UI update button

When `VN EOD (CafeF)` is selected, the scanner shows a compact local-data status card with the latest imported trading date, active stock count and per-symbol retention. The **Cập nhật EOD** button calls the scanner sidecar's `POST /eod/import-latest` endpoint.

The endpoint reuses the same importer service as this CLI command rather than spawning a second Python process:

```bash
python cafef_eod.py import-latest --mode eod
```

Only one CafeF EOD update may run at a time. The network download and ZIP parsing run off the aiohttp event loop, and the UI disables scan/update controls while its own update is active.

### First bootstrap

Import the latest adjusted CafeF historical `Upto 3 sàn` package:

```bash
python cafef_eod.py import-latest --mode upto
```

### Daily update

After CafeF publishes the completed session, either use the scanner's **Cập nhật EOD** button or run:

```bash
python cafef_eod.py import-latest --mode eod
```

Every CafeF import recalculates the scanner's active VN universe from local snapshots. A security must be within 30 calendar days of the newest `vn_eod` snapshot and classify as `STOCK` to remain active in the stock scanner. Older securities and fresh `ETF`/`CW`/`FUND`/`UNKNOWN` rows stay in SQLite with their candles and snapshots for history/audit, but are excluded from stock scans.

The audited symbol classifier currently uses these families:

- `STOCK`: exactly three alphanumeric characters.
- `CW`: HOSE `C` + three-character underlying code + four digits, for example `CHPG2632`.
- `ETF`: `E1VFVN30` or `FUE...`.
- `FUND`: `FUC...`, including `FUCVREIT` and the `FUCTVGF...` family.
- anything else: `UNKNOWN`.

To apply the classifier to an existing fresh `vn_eod` database without downloading CafeF again:

```bash
python cafef_eod.py reclassify
```

### Inspect import state

```bash
python cafef_eod.py status
```

`status` reports `activeMaxAgeDays: 30` together with the active/snapshot coverage. Import commands also report an `assetTypes` breakdown before non-stock rows are excluded from the active stock universe.

### Deterministic/manual import

```bash
python cafef_eod.py import-url "https://.../CafeF.SolieuGD.07082026.zip" --mode eod
python cafef_eod.py import-file "C:\\data\\CafeF.SolieuGD.Upto07082026.zip" --mode upto
```

`SCANNER_DB_PATH` can override the database location. `CAFEF_DOWNLOAD_PAGE` can override CafeF's download page for a mirror/test environment.

The importer stores canonical adjusted `1d` OHLCV only. Week/Month candles and Heikin Ashi are derived locally. Market cap remains `NULL`/unsupported. A periodic `upto` re-import is recommended because corporate actions can revise adjusted historical prices.
