# yfinance Japan sidecar

Small local `aiohttp` service for Tokyo Stock Exchange price data through `yfinance`.

## Behavior

- TSE codes are normalized to Yahoo Finance's `.T` suffix. Both numeric codes such as `7203` and alphanumeric four-character codes such as `130A` are accepted.
- Chart intervals are `1m`, `5m`, `15m`, `1h`, `4h`, `1d`, `1w`, and `1M`.
- `1w` is requested from yfinance as native `1wk`; `1M` is requested as native `1mo`. `4h` is the only derived interval and is built from yfinance `1h` bars within each Tokyo trading day.
- `/history` forwards explicit `from`/`to` timestamps to yfinance without adding a sidecar lookback cap. Yahoo/yfinance can still reject ranges outside its own limits. When no range is supplied, the sidecar uses provider-safe defaults (`5d` for `1m`, `1mo` for the other intraday intervals, and `max` for daily/weekly/monthly history) instead of sending invalid intraday `period=max` requests.
- `adjusted=false` is the default and returns unadjusted OHLC (`auto_adjust=False`). Pass `adjusted=true` to request split/dividend-adjusted OHLC (`auto_adjust=True`). The response always echoes the selected mode.
- Session metadata uses `Asia/Tokyo` and the TSE regular sessions `09:00-11:30` and `12:30-15:30`. It is weekday/time aware only; `holidayAware` is `false` because this sidecar does not ship an exchange-holiday calendar.
- Consumers should poll `/latest` every 60 seconds; `/health` exposes `pollIntervalSeconds: 60`.

## Endpoints

```text
GET /health
GET /symbols?q=7203&limit=20
GET /history?symbol=7203.T&interval=1d&limit=500&adjusted=false
GET /history?symbol=130A&interval=1w&from=1735689600&to=1767225599&adjusted=true
GET /latest?symbols=7203.T,130A.T&interval=1m&adjusted=false
```

`/symbols` uses Yahoo Finance search for company-name queries and filters results to `.T` symbols. A valid four-character TSE code is also returned as a direct candidate if Yahoo search is temporarily unavailable.

## Run

```powershell
python -m pip install -r requirements.txt
python yfinance_jp_sidecar.py
```

The default address is `http://127.0.0.1:8760`. Override it with `HOST` and `PORT`.

## Tests

```powershell
python -m unittest -v test_yfinance_jp.py
```
