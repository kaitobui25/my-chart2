# Binance Local Archive V1 — independent 30m build

This build is a new provider and is fully independent from the existing Binance Spot and Binance USD-M providers.

```text
Binance Public Data Archive
        ↓ explicit import / manual refresh only
native Spot 30m archives
        ↓
data/binance-archive/binance.sqlite3
        ↓
30m direct read
1h / 4h / 1d / 1w / 1M local aggregation
        ↓
Binance Local Archive provider
        ↓
Chart + Replay + Backtest
```

## Build decisions

- Do not modify or replace the existing `Binance Spot` provider.
- Do not modify or replace the existing `Binance USD-M Futures` provider.
- New provider id: `binance-local`.
- New provider display name: `Binance Local Archive`.
- SQLite stores one canonical history series per symbol: native archive `30m`.
- Do not store or download `1m`, `3m`, `5m`, or `15m`.
- Do not persist duplicate higher-timeframe candle tables in V1.
- `1h`, `4h`, `1d`, `1w`, and `1M` aggregate from local `30m` rows on read.
- Week starts Monday 00:00 UTC.
- Month uses the calendar month boundary, never a fixed 30-day bucket.
- Existing local symbols make zero Binance requests during chart reads, timeframe changes, Replay, and backtests.
- Symbol search is local/syntactic and never contacts Binance.
- A new exact symbol is imported only when it is explicitly selected for a chart.
- Watchlist seeding never imports missing symbols.
- Old data never refreshes automatically.
- Manual **Update Data** extends only the active local symbol.
- Python standard library only for the local sidecar.

## Why 30m is canonical

The product only needs candles from 30 minutes upward. Keeping native `30m` reduces stored rows roughly 30x compared with `1m`, avoids downloading detail that will never be displayed, and still gives Replay a sufficiently fine local source for all supported local timeframes.

One canonical table also avoids duplicate timeframe storage, invalidation code, and derived-cache maintenance.

## Network boundary

Local-only operations:

```text
GET /health
GET /symbols
GET /status
GET /history
```

Explicit network operations:

```text
POST /import
POST /refresh
```

Only `/import` and `/refresh` may access `data.binance.vision`.

## Local data

```text
data/binance-archive/binance.sqlite3
```

The runtime directory is ignored by Git.
