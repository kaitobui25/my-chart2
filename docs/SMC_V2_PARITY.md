# SMC V2 backend parity

The calculation source is `ref/indicator/02_SMC_ductri.pine`, Pine v6. This port targets its actual expressions and execution order. It does not substitute textbook SMC rules for the source's rules. The original SMC indicator is unchanged.

## Implemented mapping

| Pine source | TypeScript behaviour |
| --- | --- |
| `leg()` / `getCurrentStructure()` | Independent leg state for Swing, Internal and Equal; inclusive right-window comparisons; switch on dual high/low condition; pivot only on leg change; first pivot labels HL/LH. |
| `displayStructure()` | Crossover/crossunder use the previous bar's close and previous level, crossed-once state, BOS/CHoCH bias transitions, Internal/Swing overlap exclusion, literal confluence expression and source execution gates. Internal runs before Swing. |
| Pivot structure lines | `structureLines` records high-low connectors on leg changes. The Internal/Swing line toggles control these connectors independently of BOS/CHoCH visibility; BOS/CHoCH retain their own horizontal lines. |
| `ta.atr(200)` | True-range RMA, 200-bar SMA seed, unavailable before bar 199. Equal uses the current ATR200 and strict `<` tolerance. |
| Parsed high/low and `storeOrdeBlock()` | High-volatility candles swap high/low; first maximum/minimum on `[pivot, breakout)` selects the block; no candle-color restriction or 100-bar search truncation. |
| `deleteOrderBlocks()` | Runs after creation on the same bar. Close/wick mitigation is strict; 100 active blocks retained per scope. Rendering counts select from inventory without evicting it. |
| `updateTrailingExtremes()` | Updates before pivot resets; equal extremes move timestamps; historical snapshots prevent later prices changing earlier Fib context. |
| Fibonacci / Premium-Discount | Uses trailing prices and timestamps; auto direction follows Swing bias; Fib requires distinct endpoint times and supports custom ratios. Premium/Discount are 5% bands; Equilibrium is the central 5%. |
| FVG | Middle candle close/body direction, cumulative body-percent threshold, requested-frame change, fixed box endpoints, strict mitigation. No arbitrary 40-gap eviction. |
| D/W/M | Current prices on the same calendar timeframe; previous requested-bar prices below it; levels hidden above it. One latest pair per timeframe, with separate high/low origin indices. |

`barStates` exposes ATR200, trailing points, range origin and both biases per bar. `alerts` exposes source structure, mitigation and FVG alerts once per name per bar.

## Source quirks preserved deliberately

- Confluence uses `high - max(close, open)` compared with `min(close, open - low)`, including those parentheses.
- Bearish FVG stores `top = currentHigh` and `bottom = last2Low`. Deletion compares current high with that literal `top`. The port does not normalize these fields.
- Forward iteration with array removal can leave a shifted neighbour until a subsequent bar. Both OB and FVG removal follow that ordering.
- The source draws Equal levels but never sets `currentAlerts.equalHighs/equalLows`; this port does not invent those alerts.
- Turning off Swing structure, Swing OB and Strong/Weak disables Swing bias calculation even when Fib is enabled, matching the source gate.

## Timeframe data contract and limits

Chart candles must be ordered OHLC bars from the same symbol and price adjustment as the reference chart. Supply `chartIntervalSeconds`, or preferably `chartTimeframe` in Pine format (`5`, `60`, `D`, `W`, `M`) for calendar identity.

`fvgTimeframe` accepts Pine timeframe strings. Without provider bars, higher frames are aggregated from the loaded chart history using calendar boundaries and `periodUtcOffsetHours`. This fallback is appropriate for continuous markets. It cannot reconstruct missing history, exchange trading sessions or DST from OHLC alone.

For exact exchange boundaries and prior bars outside loaded chart history, supply chronological provider OHLC via `fvgCandles` and `periodCandles: { D, W, M }`. Lower-timeframe FVG requests require `fvgCandles`; the model throws rather than fabricating intrabars.

The indicator now exposes the workstation's supported FVG timeframes. `L2Chart.setIndicatorCandleSource()` (or `ChartOptions.indicatorCandles`) supplies requested provider OHLC. The workstation maps Pine timeframe strings to provider intervals and requests a range including three prior requested periods. Provider limits, supported intervals and available history still apply. FVG on another timeframe waits for provider bars; failures are shown in the indicator title. D/W/M retain the calendar aggregation fallback while provider data is unavailable. Requests refresh when chart bar coverage changes; repeated ticks within the same chart bar do not refetch provider history, so a forming requested bar is not certified tick-for-tick against Pine. Late responses from superseded datasets or removed indicators are ignored.

## Drawing and lifecycle parity

- Present selects the latest **displayed** BOS/CHoCH per scope and direction after the type filter; pivot labels retain the latest per scope and side.
- Viewport scrolling only clips drawings. Strong/Weak, Premium/Discount and Fib use the last loaded/processed bar. Replay must supply its truncated dataset.
- Neutral bias labels both trailing sides Weak. Strong/Weak lines extend twenty bars beyond the last bar and each side can draw independently.
- Trend candle/background colors use the previous bar's committed bias, with Internal taking precedence for each output, matching the source's pre-structure execution order.
- Fib supports enabled custom ratios, per-level colors and fills between adjacent enabled levels. Labels use ATR14/2; Swing pivot label positions use ATR200/2. Their labels wait for ATR warmup. Price labels use the chart's price precision; exact `syminfo.mintick` formatting requires host precision to match the instrument.
- Monochrome covers structure, Swing pivots, Strong/Weak, Equal, OB, FVG and Premium/Discount. Internal pivot and trend colors retain the source's independent settings.
- FVG draws two half boxes. D/W/M expose independent styles/colors and use PDH/PDL, PWH/PWL and PMH/PML labels.

Drawing extensions use chart indices; the source uses timestamps. Across gaps in trading sessions, those future coordinates can differ from Pine's timestamp arithmetic. The port also does not reproduce TradingView's automatic garbage collection of 500 line/label/box objects. These are remaining drawing limits, not claims of identical rendering.

Historical FVG mapping deliberately follows the source's `request.security(..., lookahead_on)`, including unoffset current HTF high/low. It can therefore use the completed HTF range on its first historical chart bar. Recomputing with more HTF data can revise historical FVGs, as in the source; this is not a non-repainting replacement. Supplied bars must represent the intended historical/current data snapshot. Tick-level Pine rollback has not been reproduced or independently certified.

## Verification

The SMC V2 unit suite includes hand-traced OHLC fixtures, boundary conditions, ATR seed/RMA checks, Internal confluence and crossover tests, OB inventory and origin selection, Equal warmup, trailing/Fib prefix consistency, FVG creation/deletion/filtering and HTF lookahead, and daily/weekly/monthly boundaries.

These tests compare with the source rules; they are not a native TradingView export. Independent end-to-end certification still requires exported Pine outputs on identical OHLC history and inputs. No 100% TradingView parity claim is made from passing unit tests alone.

Official runtime semantics checked:

- [Pine execution model](https://www.tradingview.com/pine-script-docs/language/execution-model/)
- [ATR](https://www.tradingview.com/pine-script-reference/v6/#fun_ta.atr), [RMA](https://www.tradingview.com/pine-script-reference/v6/#fun_ta.rma), [crossover](https://www.tradingview.com/pine-script-reference/v6/#fun_ta.crossover)
- [Timeframe requests and lookahead](https://www.tradingview.com/pine-script-docs/concepts/other-timeframes-and-data/#lookahead)
