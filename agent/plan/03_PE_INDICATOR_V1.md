# P/E Indicator V1

## Goal

Add a non-blocking P/E indicator for Vietnam equities on Day / Week / Month charts.
Candles remain authoritative for chart loading and always render first. The P/E
indicator is optional and only loads valuation data after it is enabled.

## Source contract

P/E deliberately has two independent sources with different semantics.

### Blue line — FiinQuant raw historical valuation

Use the official FiinQuant stock-valuation endpoint through the local sidecar:

```python
client.MarketDepth().get_stock_valuation(
    tickers=[symbol],
    from_date="YYYY-MM-DD",
    to_date="YYYY-MM-DD",
)
```

The upstream response provides daily `pe` and `pb`. The blue line uses raw `pe`;
it never derives P/E from chart close or EPS.

Mapping to chart bars:

- Day: raw P/E for that trading day.
- Week: last valid daily P/E inside that week.
- Month: last valid daily P/E inside that month.
- Never average P/E across a week or month.
- Never forward-fill a missing daily value into another bucket.
- Intraday: indicator remains enabled but blue line is blank.

### Yellow dots — Vnstock raw quarterly P/E

Use:

```python
Fundamental().equity(symbol).ratio(period="quarter", orient="time_series")
```

The yellow marker Y coordinate is the raw Vnstock `peRatio` / `priceToEarning`.
It is intentionally independent of the FiinQuant blue line. A yellow dot is
allowed to sit above or below the blue line because the providers may use different
source data or methodology.

No-hover legend continues to show the latest available raw quarterly Vnstock P/E.
Hovering the blue line shows the raw FiinQuant P/E for that chart bar.

## Data flow

```text
P/E enabled
    |
    +---------------------------+
    |                           |
    v                           v
FiinQuant valuation cache    Vnstock quarter cache
IndexedDB                    IndexedDB
    |                           |
    +-- hit -> blue line         +-- hit -> yellow dots
    |                           |
    +-- miss -> fetch policy     +-- miss -> fetch policy
            |                           |
            v                           v
 /fiinquant-api/valuation/stock   /vnstock-api/fundamentals/pe
            |                           |
            v                           v
 raw daily PE/PB                  raw quarterly PE
```

Neither source is awaited by the candle-loading path. A failure in one source does
not suppress the other source.

## FiinQuant sidecar

The established FiinQuant history/realtime implementation is preserved in
`fiinquant_sidecar_core.py`. `fiinquant_sidecar.py` is a thin facade that reuses the
same authenticated SDK session and adds:

```text
GET /valuation/stock?symbol=MBB&from=<unix>&to=<unix>
```

Response contract:

```json
{
  "symbol": "MBB",
  "source": "fiinquant-stock-valuation",
  "cadence": "1d",
  "points": [
    { "time": 1786035600, "pe": 6.47, "pb": 1.20 }
  ]
}
```

The valuation gateway has a one-request semaphore and also consumes one existing
history slot. This prevents multiple background valuation loads from occupying all
HTTP capacity used by active candle requests.

The existing `/fiinquant-api` Vite proxy remains responsible for sidecar token
injection. Indicator code never stores FiinQuant usernames, passwords, or tokens.

## IndexedDB

### Vnstock quarterly cache

Existing store remains unchanged:

- DB: `l2chart.fundamentals.v1`
- store: `pe`
- key: normalized ticker
- payload: quarterly fundamentals plus `fetchedAt` and `firstObservedAt`

Old quarters are retained when they roll out of Vnstock Free's recent-period
window.

### FiinQuant daily valuation cache

Use a separate database because daily market valuation and quarterly fundamentals
have different lifecycles:

- DB: `l2chart.valuations.v1`
- store: `stock-daily`
- key: normalized ticker
- payload:
  - `source`
  - `fetchedAt`
  - merged requested coverage ranges
  - deduplicated daily `{time, pe, pb}` points

P/B is retained because FiinQuant returns it in the same valuation response; this
does not create extra requests and allows a future P/B indicator to reuse the same
cache.

Coverage is incremental. If IndexedDB already covers 2016-2026, later loads do not
redownload the full history. Only uncovered ranges are requested. A stale live tail
is refreshed with a short recent range and merged by timestamp.

## Loading policy

### Manual indicator enable on an already loaded ticker

1. Create the P/E pane immediately.
2. Read both IndexedDB stores asynchronously.
3. Render whichever source is already cached.
4. A missing source may request immediately.
5. User interaction and candles are never blocked.

### Indicator already enabled, then ticker changes

1. Ticker context changes and old P/E is cleared immediately.
2. Outstanding generation/timers for the old ticker become stale.
3. New candles render first.
4. The next indicator recompute reads both IndexedDB stores.
5. Cached source renders immediately.
6. A cache miss waits 30 seconds before upstream fetch.
7. Switching ticker again or removing P/E invalidates the delayed work.

If an already-loaded ticker later exposes older candle coverage, missing valuation
coverage can be fetched immediately in the background because this is an extension
of an established ticker cache, not the ticker-switch path.

## Replay / no-look-ahead

### Blue line

Replay uses historical FiinQuant daily P/E points directly. The line is mapped only
to candles currently exposed by Replay, so future valuation points are never shown.
There is no inferred EPS publication timestamp and no Close/EPS reconstruction.

### Yellow dots

Vnstock Free exposes reporting period but not exact filing timestamp. The quarterly
marker therefore retains the conservative visibility rule:

`effectiveAt = max(periodEnd, min(conservativeAvailability, firstObservedAt))`

Fallback windows:

- Q1: +30 calendar days
- Q2: +60 calendar days
- Q3: +30 calendar days
- Q4: +90 calendar days

This rule only controls whether a raw Vnstock yellow marker may be visible in
Replay. It never changes the marker's Y value and never affects the FiinQuant line.

## Rendering

- Separate P/E pane.
- Blue line: raw FiinQuant P/E; line width 1.5 px.
- Yellow marker: raw Vnstock quarterly P/E; radius 4 px.
- Yellow markers are visible on Day / Week / Month.
- No crosshair: legend shows latest available quarterly Vnstock P/E.
- Crosshair: legend and on-line bubble show raw FiinQuant P/E for that bar.
- The two series are not forced to intersect.

## Code boundaries

```text
examples/sidecars/fiinquant/fiinquant_sidecar_core.py
  existing FiinQuant candle/realtime implementation

examples/sidecars/fiinquant/fiinquant_sidecar.py
  thin facade + stock-valuation endpoint

examples/sidecars/vnstock/vnstock_sidecar.py
  Vnstock quarterly fundamentals endpoint

src/indicators/builtin/pe-model.ts
  pure Day/Week/Month mapping + quarterly marker visibility

src/indicators/builtin/pe-valuation-cache.ts
  FiinQuant daily PE/PB IndexedDB + coverage merge

src/indicators/builtin/pe-valuation-client.ts
  async FiinQuant valuation client + missing-range requests

src/indicators/builtin/pe-cache.ts
  Vnstock quarterly IndexedDB

src/indicators/builtin/pe-client.ts
  Vnstock quarterly sidecar client

src/indicators/runtime-context.ts
  chart ticker tracking for async indicators

src/indicators/builtin/pe.ts
  dual-source lifecycle + rendering only
```

## Error isolation

- FiinQuant valuation failure leaves the blue line unavailable but does not remove
  cached/raw Vnstock yellow dots.
- Vnstock failure does not remove the FiinQuant blue line.
- Neither failure changes the health of the active candle provider.
- Requests are asynchronous and stale ticker responses are ignored by generation.
- FiinQuant range requests and Vnstock requests are independently de-duplicated.

## Validation

Focused validation covers:

- raw FiinQuant daily P/E mapping
- Day / Week / Month last-value semantics
- no daily forward-fill and no P/E averaging
- raw Vnstock yellow-marker Y coordinate
- Replay marker visibility
- IndexedDB coverage merging and point de-duplication
- missing-range-only valuation fetches
- 30-second cache-miss policy
- FiinQuant sidecar normalization, authentication and endpoint contract
- production workstation build

The standard browser, sidecar, docs and secrets CI jobs must also stay green. Any
pre-existing repository-wide typecheck failure must be reported separately rather
than hidden by the feature validation.
