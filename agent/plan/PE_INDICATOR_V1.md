# P/E Indicator V1

## Goal

Add a non-blocking P/E indicator for Vietnam equities on Day / Week / Month charts.
The candle path stays authoritative and renders first. P/E is optional and is only
loaded when the user enables the indicator.

## Data source

- Vnstock `Fundamental().equity(symbol).ratio(period="quarter", orient="time_series")`.
- Sidecar normalizes only the fields required by the indicator:
  - reporting period
  - period end
  - trailing EPS
  - reported quarterly P/E
- The indicator never treats the quarterly API P/E as a daily series.
- Daily / weekly / monthly P/E is derived from the chart close and the latest TTM
  EPS that was knowable at that bar.

## Data flow

```text
indicator enabled
      |
      v
candles already render / remain interactive
      |
      v
read P/E fundamentals from IndexedDB
      |
      +-- hit --> render immediately
      |
      +-- miss --> manual enable: fetch now
                  restored indicator / ticker change: wait 30s, then fetch
                              |
                              v
                    Vnstock local sidecar
                              |
                              v
                    normalize + merge cache
                              |
                              v
                         recompute P/E
```

Network work is never awaited by the chart candle load path.

## Cache

Use a dedicated IndexedDB database, separate from candle history:

- DB: `l2chart.fundamentals.v1`
- store: `pe`
- key: normalized ticker
- cached payload: quarterly fundamentals plus `fetchedAt` and
  `firstObservedAt` per quarter

The calculated line is not persisted because it is cheap to derive and depends on
the currently displayed candle provider/timeframe.

## Replay / no-look-ahead policy

Vnstock Free ratios expose reporting periods but not an exact filing timestamp.
For replay, each quarter therefore gets a conservative availability timestamp.
The first time a quarter is actually observed from the API is also stored.

`effectiveAt = min(conservativeAvailability, firstObservedAt)`

The conservative fallback is intentionally later than quarter end:

- Q1: +30 calendar days
- Q2: +60 calendar days
- Q3: +30 calendar days
- Q4: +90 calendar days

If a quarter is not yet effective at a replay bar, it must not be used. No backward
fill before availability. If historical Free data is missing, the indicator stays
blank rather than inventing values.

## Price-unit normalization

Some Vietnam price providers expose VND while others expose thousands of VND.
Do not hard-code `* 1000` into P/E calculation. Infer a unit multiplier from the
latest available Vnstock `(reported P/E * trailing EPS)` versus the current chart
price, choosing from conservative power-of-ten candidates. This keeps the P/E
indicator independent of the active candle provider.

## Rendering

- Separate indicator pane; do not share the price Y-axis.
- Main P/E line: calculated value per bar.
- Quarterly Vnstock P/E: yellow circular marker, visually thicker/larger than the
  main line.
- No crosshair: legend shows only the latest quarterly Vnstock P/E available at the
  current chart horizon.
- Crosshair: legend and an on-line label show the calculated P/E for that bar.
- Marker X position is the reporting-period bar; a marker is hidden in Replay until
  the quarter is actually effective.
- Intraday charts keep the indicator enabled but render no P/E line; V1 supports
  Day / Week / Month only.

## Lifecycle

### Manual enable on an already loaded ticker

1. Create pane immediately.
2. Read IndexedDB asynchronously.
3. If cache is missing, request Vnstock immediately.
4. User can pan, zoom, search, draw and change timeframe throughout.

### Indicator already enabled, then ticker changes

1. Ticker context changes: clear old P/E immediately and cancel old timer/request
   generation.
2. New candles render first.
3. Read new ticker from IndexedDB.
4. Cache hit: render P/E immediately.
5. Cache miss: schedule API fetch 30 seconds later.
6. Changing ticker or removing P/E cancels the delayed work.

### Replay

The same indicator instance remains active. Every replay candle update recomputes
against the cached quarterly fundamentals and the no-look-ahead availability rule.

## Code boundaries

```text
examples/sidecars/vnstock/vnstock_sidecar.py
  Vnstock-only API access and normalization

src/indicators/builtin/pe-model.ts
  pure period/effective-time/unit/P-E calculation

src/indicators/builtin/pe-cache.ts
  IndexedDB persistence and merge policy

src/indicators/builtin/pe-client.ts
  async sidecar client + in-flight de-duplication

src/indicators/runtime-context.ts
  small chart instrument-context tracker used by async indicators

src/indicators/builtin/pe.ts
  indicator lifecycle + rendering only
```

## Error isolation

- 429 / timeout / sidecar offline only makes P/E unavailable.
- Never mark the active price provider unhealthy because fundamentals failed.
- Stale symbol responses are ignored by generation token.
- Requests for the same ticker are de-duplicated in flight.

## Tests

- Sidecar: ratio aliases, malformed values, duplicate period rows, quota handling.
- Model: conservative availability, no look-ahead, Day/Week/Month bar evaluation,
  negative/zero EPS, price-unit inference, marker visibility.
- Cache: merge preserves first observation and updates latest values.
- Lifecycle: manual miss fetches immediately; restored/symbol-change miss waits 30s;
  cache hit avoids wait; ticker change cancels delayed fetch; removed indicator ignores
  late responses.
- Existing typecheck, unit tests, build, package checks and browser suite remain green.
