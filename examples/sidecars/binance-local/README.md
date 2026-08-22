# Binance Local Archive

Small local history service for the workstation.

## Rules

- Source: Binance Spot Public Data Archive (`data.binance.vision`).
- SQLite stores only native `30m` candles.
- `1h`, `2h`, `4h`, `1d`, `1w`, and `1M` are aggregated from local `30m` candles when read.
- Normal chart history, timeframe changes, Replay, and backtests never contact Binance.
- A missing exact symbol is imported once when selected.
- Existing symbols update only when the user explicitly presses the update action.
- No REST kline fallback, WebSocket, timer, scheduler, or automatic freshness check.

## Local data

```text
data/binance-archive/binance.sqlite3
```

The directory is ignored by Git. Deleting it resets the local Binance history database.

## Service

`npm run dev` starts the sidecar on loopback port `8750`.

Local-only reads:

```text
GET /health
GET /symbols?q=BTC&limit=30
GET /status?symbol=BTCUSDT
GET /history?symbol=BTCUSDT&interval=1h&limit=500
```

Explicit network operations:

```text
POST /import   {"symbol":"BTCUSDT"}
POST /refresh  {"symbol":"BTCUSDT"}
```

The importer uses monthly `30m` ZIPs for completed months and daily `30m` ZIPs for the current month. Published checksum files are verified when available. Completed archive files are recorded in SQLite so an interrupted import can resume without re-importing finished files.

## Tests

```text
npm run test:binance-local-sidecar
npx vitest run tests/unit/binance-local-datafeed.test.ts
```
