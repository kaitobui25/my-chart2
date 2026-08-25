# Scanner 04 — Closed-week Breakout + Volume V1

## Goal

Add Scanner 04 to the existing Market Scanner for HOSE stocks using only local CafeF adjusted daily OHLCV already stored in `scanner.db`.

The scanner must derive weekly OHLCV locally and must never use the current/incomplete week.

## Scope

- Source: `vn_eod` / CafeF adjusted EOD local SQLite only.
- Universe: all active HOSE stocks.
- Input history: daily OHLCV from `scanner.db`; require at least 12 fully closed weekly buckets per symbol.
- Weekly bars are derived locally from daily bars.
- No block trade, active buy/sell, or free-float data.
- Existing Heikin Ashi scanner remains unchanged when Scanner 04 is disabled.

## Closed-week rule

Only weekly buckets whose end time is already in the past are eligible.

- Never evaluate an incomplete/current week.
- W0 = latest fully closed week when checking a new signal.
- W-1..W-8 = eight fully closed weeks immediately before W0.

## Weekly aggregation

For each weekly bucket:

- open = first daily open
- high = max daily high
- low = min daily low
- close = last daily close
- volume = sum daily volume
- traded value = sum(daily close * daily volume)

If volume data required for a weekly calculation is missing, that symbol does not qualify for Scanner 04 for that evaluation.

## Mandatory liquidity filter

Run before breakout conditions.

Baseline = W-1..W-8.

Both liquidity thresholds use median so the statistical method is consistent:

1. `median(traded_value[W-1..W-8]) >= X`
2. `median(volume[W-1..W-8]) >= Y`

UI defaults:

- X = 5 billion VND/week
- Y = 500,000 shares/week

Both are editable inputs in Scanner 04.

## Breakout signal

For W0:

1. `close(W0) > max(close[W-1..W-8])`
2. `(close(W0) / close(W-1) - 1) * 100 >= 4`
3. `RVOL(W0) = volume(W0) / median(volume[W-1..W-8]) >= 1.5`

Strong signal:

- `RVOL(W0) >= 2.5`

UI defaults for 4%, 1.5x and 2.5x are editable but preserve these values on reset.

## W+1 follow-up without current-week data

Do not inspect the incomplete week.

To support one-week follow-up without persistence/state tables:

- First test the latest fully closed week as W0 for a NEW signal.
- If it is not a new signal, test the previous fully closed week as W0.
- If that previous week was a valid breakout, return it as FOLLOW-UP and use the latest fully closed week as W+1.

W+1 fields:

- `W+1 RVOL = volume(W+1) / original median(volume[W-1..W-8])`
- `W+1 close`
- `holds breakout = close(W+1) >= original breakout level`

A signal is therefore visible on its breakout week and, after the next week fully closes, for one additional scan cycle with follow-up status.

## UI

Add accordion section:

- `04 · Breakout + Volume`
- Default collapsed, same exclusive accordion behavior as sections 01–03.
- Toggle `Bật Scanner 04` defaults OFF so existing Scanner 03 behavior is preserved.
- When enabled, request is restricted to `vn_eod` + HOSE and Heikin Ashi conditions are not applied.

Inputs:

- Median GTGD 8 tuần tối thiểu (tỷ VND), default 5
- Median KL 8 tuần tối thiểu, default 500000
- Tăng giá tuần tối thiểu (%), default 4
- RVOL tối thiểu, default 1.5
- RVOL mạnh, default 2.5

## Result table for Scanner 04

Columns:

- Mã
- W0 close
- % tuần
- RVOL W0
- Breakout level
- GTGD W0
- Median GTGD 8W
- Median KL 8W
- Signal (`NEW`, `FOLLOW-UP`, `STRONG` badge where applicable)
- W+1 RVOL
- W+1 close
- Hold/Failed
- W0 week
- Data freshness

Sort descending by W0 RVOL, then symbol.

## Backend design

Keep the implementation small:

1. Add optional `breakoutVolume` request config.
2. Add one pure helper module to aggregate closed weeks and evaluate NEW/FOLLOW-UP signals.
3. Add a ScannerEngine branch when `breakoutVolume.enabled` is true.
4. Reuse existing `candles` table; no DB migration/state table required.
5. Reuse existing local CafeF import/update workflow.
6. Leave existing HA path untouched when Scanner 04 is disabled.

## Validation

Add tests for:

- current/incomplete week excluded
- weekly traded value = sum(daily close * volume)
- median volume and median traded-value liquidity gates
- 8-week close breakout
- >=4% weekly change
- RVOL >=1.5
- strong RVOL >=2.5
- W+1 uses original volume baseline
- W+1 hold/fail against original breakout level
- previous-week breakout returned as FOLLOW-UP only after next week is fully closed
- request parsing/default behavior does not change existing HA scans

Run existing scanner tests plus new Scanner 04 tests.