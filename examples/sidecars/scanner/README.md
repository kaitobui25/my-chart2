# Scanner sidecar

Local scanner service for the workstation. It uses only `aiohttp` plus Python's standard `sqlite3` and stores its rebuildable cache in `data/scanner.db`.

The normal workstation launcher starts this sidecar automatically. Manual start:

```bash
python scanner_sidecar.py
```

Endpoints:

- `GET /health`
- `GET /sources`
- `POST /scan`
- `GET /runs/{id}`
- `POST /backup`

FiinQuant credentials are read from `../fiinquant/.env`. Binance sources use public REST APIs and require no API key.

Heikin Ashi accepts exactly one timeframe per scan: `1w` or `1M`.

## Vietnamese stocks: CafeF EOD -> local scanner

`vn_eod` is a preloaded scanner source. It does not call CafeF, FiinQuant or another market-data provider while a scan is running. CafeF adjusted EOD data is imported into the same `scanner.db`, then Price/Volume filters, Week/Month aggregation and Heikin Ashi are computed locally.

FiinQuant remains the realtime chart source. Clicking a `vn_eod` result switches the chart to FiinQuant and opens the selected ticker.

### First bootstrap

Import the latest adjusted CafeF historical `Upto 3 sàn` package:

```bash
python cafef_eod.py import-latest --mode upto
```

### Daily update

After CafeF publishes the completed session:

```bash
python cafef_eod.py import-latest --mode eod
```

### Inspect import state

```bash
python cafef_eod.py status
```

### Deterministic/manual import

```bash
python cafef_eod.py import-url "https://.../CafeF.SolieuGD.07082026.zip" --mode eod
python cafef_eod.py import-file "C:\\data\\CafeF.SolieuGD.Upto07082026.zip" --mode upto
```

`SCANNER_DB_PATH` can override the database location. `CAFEF_DOWNLOAD_PAGE` can override CafeF's download page for a mirror/test environment.

The importer stores canonical adjusted `1d` OHLCV only. Week/Month candles and Heikin Ashi are derived locally. Market cap remains `NULL`/unsupported. A periodic `upto` re-import is recommended because corporate actions can revise adjusted historical prices.
