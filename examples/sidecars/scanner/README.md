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
