# SMC V3 · Super SMC

Select **SMC V3 · Super SMC** in the indicator list (`smart-money-concepts-v3`). Swing structure is enabled by default; V2 remains available with its original calculation.

V3 uses the same confirmed raw pivots as V2, but keeps independent protected levels for Internal and Swing, using their respective pivot lengths:

- The first confirmed high and low initialize the structure.
- A new raw pivot does not replace an unbroken structure level.
- After a high is broken, a newer confirmed higher high becomes the next high target; the low side is symmetric.
- Breaking a structure high finds the lowest confirmed pivot low since that high, and promotes it only when newer than the current protected low. Breaking a structure low mirrors this with the highest confirmed pivot high. Each break searches only pivots confirmed up to that bar.
- Breaks use strict `high > level` / `low < level`. Equal touches do not count. BOS/CHoCH classification still depends on the prior trend.

For example, after a high at 100, confirmed pullback lows at 90 and then 95 leave 90 as the main wave low. Breaking 100 protects 90, so a move below 95 alone is not a CHoCH. The next bullish structure break can protect a newer pullback in its own leg.

Both Internal and Swing use protected pivots and strict wick breaks. Their state and trend biases are independent. Internal confluence remains an optional filter; matching a Swing price does not suppress an Internal break. Settings, rendering, timeframe requests, equal levels, FVG and order-block filtering/mitigation are shared. Both scopes' order blocks use V3's protected break origin. Internal and Swing connectors link their own V3 structural pivots and appear only when a structural anchor changes. Strong/Weak, Fibonacci and Premium/Discount use trailing extremes seeded/reset by V3 structural pivots; raw candidate pivots do not reset the range. Extremes still extend with price between promotions. Pivot labels continue to show raw pivots. An anchor promoted later becomes available at the promotion bar, without retroactively changing earlier ranges or connectors.

Connectors form a chronological zigzag of accepted pivots. Consecutive accepted highs retain the highest high, and consecutive accepted lows retain the lowest low. Extending a leg replaces its old connector instead of leaving branches on the chart. Accepted pivots hidden by an extension are retained: a late-promoted pullback splits the run and restores the earlier turning points. Replaced connectors retain their availability intervals for historical calculations. The zigzag's extreme can differ from the current protected break level when a weaker pivot is promoted; BOS/CHoCH still uses that protected level.

The policy lives in `src/indicators/builtin/smart-money-concepts-v3-model.ts` and is recreated per calculation. Confirmed pivots are used only when available, without future candles. On an outside bar breaking both sides, the reference's bullish-then-bearish execution order applies. Signals on the live bar can change while its high/low updates.
