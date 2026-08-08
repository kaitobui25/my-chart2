# Vnstock sidecar

Local Python adapter that exposes Vnstock market data through the provider-neutral workstation `Datafeed` contract.

## Endpoints

- `GET /health`
- `GET /symbols?q=FPT&limit=20`
- `GET /history?symbol=FPT&interval=1d&limit=500`
- `GET /history?symbol=FPT&interval=1d&from=<unix>&to=<unix>&limit=500`
- `GET /latest?symbols=FPT,HPG,VIC&interval=1d`

Responses normalize candles to Unix seconds plus `open/high/low/close/volume`.

## Install

Use Python 3.11+:

```bash
python -m venv .venv
# Windows: .venv\Scripts\python -m pip install -r requirements.txt
# macOS/Linux: .venv/bin/python -m pip install -r requirements.txt
```

For the workstation launcher/integration, set `VNSTOCK_PYTHON` to that Python executable when Vnstock is not installed in the Python environment already used by the project.

Windows example:

```powershell
$env:VNSTOCK_PYTHON="C:\path\to\my-chart2\examples\sidecars\vnstock\.venv\Scripts\python.exe"
npm run dev
```

The workstation integration forces the Vnstock sidecar to port **8740**. Port 8730 is reserved by the scanner sidecar.

## Data policy

The adapter uses the Vnstock 4 Unified UI. Market data source routing remains inside Vnstock (KBS/VCI) rather than leaking provider-specific schemas into TypeScript.

Intervals exposed to the chart:

- native: `1m`, `5m`, `15m`, `1h`, `1d`
- derived locally: `4h` from hourly bars, `1w` and `1M` from daily bars

Historical data is cached in browser IndexedDB under `vnstock:ohlcv:v1`. A temporary provider failure does not erase previously cached history.

## Tests

```bash
python -m unittest discover -s examples/sidecars/vnstock -v
```

The unit tests do not require network access or a live Vnstock session.
