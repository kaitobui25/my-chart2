# Current Replay

**Generated:** 2026-08-10  
**Documented main:** `15cff0e61ca04534487683f3f4f946a34ac3a1fd`  

Replay is a workstation subsystem built around one shared raw market-time clock. It is not implemented as independent timers inside each chart tile.

## Modules

- `examples/workstation/replay/replay-clock.ts` — playback timeline, cursor, speed and timer.
- `examples/workstation/replay/replay-session.ts` — session state, participants, history loading, source ownership and orchestration.
- `examples/workstation/replay/replay-projection.ts` — incremental raw-candle projection into each participant timeframe.
- `src/candle-aggregation.ts` — pure OHLC aggregation helpers used by projection.
- `examples/workstation/trading/paper.ts` — MarketHub source locking used to isolate Replay prices from live prices.

## State model

`SyncedReplaySession` uses these phases:

```text
idle
  ↓
selecting
  ↓
loading
  ↓
paused ↔ playing
  ↓
idle
```

The shared `ReplayClock` itself has idle/paused/playing phases.

## Participant rule

Replay gathers all visible replay participants from the workstation environment.

Current requirements before selection starts:

- at least one chart participant exists;
- every participant uses the same normalized symbol;
- every participant has enough visible/history data to select a replay point.

Different timeframes are allowed. Different symbols are not.

## Shared base interval

Replay chooses one raw base interval for all visible charts.

Rules implemented in `chooseReplayBaseInterval`:

1. If every visible chart uses the same interval, that interval becomes the base.
2. If the visible set mixes only `1w` and `1M`, Replay uses `1d` as the raw base because a calendar week can cross two calendar months and cannot be safely folded into month buckets.
3. Otherwise Replay chooses the shortest interval among the participants by approximate interval duration.

The common source is then projected independently into each target chart timeframe.

## History window

Replay derives the common usable history window across all participants.

It converts each participant's last candle-open time into an interval end boundary, then intersects the participant windows.

The raw fetch starts early enough to cover the beginning of currently-open larger target buckets. This avoids losing the opening OHLC portion of a target candle.

Before requesting the provider, Replay estimates raw source-bar count. If it exceeds 20,000 bars, the session rejects the range rather than silently truncating it.

## Provider history and browser cache

Replay calls the active chart `Datafeed.getHistory()` for the shared raw interval/range.

Therefore Replay inherits provider cache behavior rather than maintaining a separate provider-specific historical database.

Important examples:

- FiinQuant range history uses `examples/providers/browser-history-cache.ts` coverage first and only asks the sidecar/provider for missing ranges.
- Vnstock range history uses the same coverage/missing-range pattern.
- Binance browser history participates in the shared browser IndexedDB cache.

For FiinQuant, this is important because already-downloaded old adjusted history can be replayed from browser storage without forcing the provider to accept the same old `from_date` again.

If a requested FiinQuant range is only partially cached and an uncovered backfill fails, the datafeed reports an error rather than letting Replay proceed with an incomplete history window.

## Projection and future-data protection

Each participant owns a `ReplayProjection` for its target interval.

At each raw clock tick:

```text
one newly revealed raw candle
          ↓
ReplayProjection.push()
          ↓
current target-timeframe candle
          ↓
participant.updateReplayCandle()
```

A higher-timeframe partial candle is built only from raw candles that have already been revealed by the shared clock. Future raw high/low/close values are therefore not copied into an earlier Replay step.

Week/Month aggregation uses calendar-aware interval boundaries rather than fixed 7-day/30-day epoch buckets.

## Heikin Ashi context

Heikin Ashi is recursive: the next HA open depends on the previous HA open/close.

Replay therefore does not restart a target chart's history exactly at the raw Replay source window. For each participant, it preserves completed target-timeframe candles from before the raw source start as seed history.

That seed is merged with the projected Replay data before the participant receives its initial replay dataset.

This keeps Heikin Ashi context stable instead of recalculating the first visible Replay HA candle as if it were the first candle ever.

Raw market OHLC remains the Replay source. Heikin Ashi stays a derived chart-display mode.

## Clock controls

Current `ReplayClock` speeds:

```text
1x → 2x → 5x → 10x → 1x
```

The clock provides:

- play;
- pause;
- toggle playback;
- single step;
- speed cycle/set;
- stop/reset.

Playback uses a shared timer. A single clock step advances every visible participant to the same raw market-time point.

## MarketHub ownership

Before Replay begins publishing replay prices, `SyncedReplaySession` claims an exclusive MarketHub source for the replayed symbol.

`MarketHub.update()` ignores any quote for a locked symbol whose source does not match the exclusive owner.

As a result:

```text
Replay owns VIC
    ↓
Replay quote VIC → accepted
live/watchlist VIC → ignored
```

On stop/cancel the Replay source is released.

This separation is required because `PaperTradingEngine` consumes MarketHub quotes. Without the source lock, a live quote could fill/update a paper position while the chart is visually replaying an older market period.

## Raw replay quote publication

Each shared source tick publishes one raw replay candle/quote through the session environment to MarketHub.

Chart participants separately receive their projected target-timeframe candle. This keeps the trading/quote source on raw market values rather than synthetic Heikin Ashi display values.

## Stop/reload behavior

Stopping Replay:

- increments the load token to invalidate in-flight loads;
- releases MarketHub source ownership;
- stops/resets the shared clock;
- tells participants to leave Replay;
- clears projections, source history, symbol/base interval and errors;
- optionally reloads live chart data according to caller intent.

The workstation also stops Replay around changes that would invalidate the shared session, such as relevant layout/provider/symbol/timeframe transitions.

## Current tested contracts

Repository tests cover Replay clock/session behavior, projection/aggregation and MarketHub ownership. Browser coverage also exercises synchronized workstation Replay behavior.

Relevant tests include:

- `tests/unit/replay-clock.test.ts`
- `tests/unit/replay-session.test.ts`
- `tests/unit/candle-aggregation.test.ts`
- `tests/unit/market-hub.test.ts`
- `tests/browser/workstation.spec.ts`

## Current limitations

- All visible participants must share one symbol.
- Very large raw Replay ranges above the 20,000-bar estimate are rejected.
- Replay quality is bounded by the historical coverage the active provider/cache can supply.
- Replay does not create an independent immutable historical warehouse; it relies on active datafeed history and browser cache coverage.
- Replay is application/workstation behavior, not part of the minimal provider-neutral chart core API.