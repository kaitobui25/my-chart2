# Paper trading: instruments and accounting

The workstation paper engine consumes normalized quotes from `MarketHub`, including Yahoo Finance via the `Yahoo Japan` datafeed. It **does not send broker orders**.

## Instrument rules

`examples/workstation/trading/instruments.ts` defines one `InstrumentSpec` per asset family. It is the source of truth for order quantity, tick size, contract multiplier, margin and settlement currency.

| Instrument | Quantity minimum/step | Multiplier | Quote currency | Paper margin |
| --- | ---: | ---: | --- | ---: |
| Toyota / Japanese stocks (`7203.T`) | 100 / 100 shares | 1 | JPY | 100% |
| Bitcoin (`BTC-USD`) | 0.001 / 0.001 BTC | 1 | USD | 100% |
| USD/JPY (`JPY=X`) | 0.01 / 0.01 standard lot | 100,000 USD/lot | JPY | 5% |
| Gold futures (`GC=F`) | 1 / 1 contract | 100 oz | USD | 10% |

These are **paper assumptions**. Margin and trading-lot requirements can differ by broker, instrument and exchange. Toyota `7203.T` uses a 0.5 JPY tick; other Japanese shares use generic 1 JPY ticks until instrument-level tick sizes are known. Yahoo's `GC=F` is COMEX gold futures, not XAUUSD spot. Unrecognized Japanese `.T` symbols use the generic stock defaults; all other unknown symbols retain the historical Vietnam paper model (VND, multiplier 1000, 20% margin).

## Accounts and conversion

- VND legacy account: starting balance 1,000,000,000 VND. USD account for Yahoo assets: starting balance 100,000 USD. They are **separate wallets**; the UI shows the one matching the active symbol.
- JPY exposure and P&L are converted into USD using `JPY=X` (JPY per USD). The workstation has a dedicated USD/JPY subscription and initial history seed when Yahoo is selected, independent of the general watchlist.
- If the necessary FX quote is missing or older than 3 days, new orders needing that rate are rejected and account calculations involving unconverted positions display an unavailable value. No artificial cross-currency sum is produced.
- The display of unrealized P&L on an individual position remains in its quote currency; balance/equity use the account currency.

## Execution model

Market, limit, stop, take-profit and stop-loss work on MarketHub quote updates. Yahoo supplies candles via polling (about 60 seconds), not actual exchange bid/ask. When a new chart subscribes, it requests an initial quote immediately and then continues its normal polling cycle. In the absence of a real order book, the engine uses candle close as the reference price, rounded to the instrument tick, and optionally applies synthetic spread, slippage and commission (basis points); all default to zero. Order Ticket includes these settings and persists them locally. Mobile Order Ticket also displays open positions and working orders with Close/Cancel controls.

Historical seed/backfill prices are marked non-tradable. Live quotes must have arrived recently (within 150 seconds) and Yahoo's candle timestamp must be within 24 hours; both must pass basic session gates before a paper fill is allowed. A live fill is timestamped when execution occurs, rather than at the daily candle's start; replay uses its own synchronized quote source and simulated timestamp. Japanese stock sessions are Tokyo weekdays 09:00–11:30 and 12:30–15:30; FX/futures use an approximate weekday gate. **The session logic is not holiday aware**, and OHLC data cannot model intrabar fill priority, true spread, exchange slippage, partial fills or actual liquidity. Gold futures expiration/rollover is not modeled.

## Storage and extension points

- V2 state is stored at `l2chart.paper.v2`, with instrument snapshots on orders/positions so later defaults do not rewrite existing positions.
- On first load, `l2chart.paper.v1` is migrated into the VND wallet with its original multiplier; the v1 key is left intact as a backup.
- Instrument profiles belong in `instruments.ts`; execution calculations and accounting belong in `paper.ts`; quote publication stays in `main.ts`; form logic belongs in `workspace.ts`.
- Deterministic tests are in `tests/unit/paper-trading.test.ts`.
