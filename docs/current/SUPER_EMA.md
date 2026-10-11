# Super EMA

Phase 1 follows the DucTri reference screenshots and usage guide in `ref/indicator/emaOfDuctri`.

Add **Super EMA** from Indicators → Price overlays. Defaults are EMA 20/50/100/200
with close as source, yellow/orange/deep orange/red, and widths 1/1/2/3.
Each EMA has independent visibility, length, source, color and width settings.
Hiding a line does not exclude it from structure calculations.
The indicator uses one legend row containing its name and confirmed structure,
with one settings/visibility/remove control group. Numerical EMA values are hidden.

## Structure

- BULL: EMA1 > EMA2 > EMA3 > EMA4.
- BEAR: EMA1 < EMA2 < EMA3 < EMA4.
- Otherwise neutral; insufficient history is warming.
- Labels appear when entering BULL or BEAR, once per transition.
  A following candle confirms closure; the last candle never emits a label.
- The main legend reports the last confirmed structure; mini-chart headings show current structure.

## Mini-charts and datafeeds

Three optional previews appear after the last main candle, stacked vertically.
Defaults: 15m / 1H / 4H, 50 visible candles. The time scale reserves right-hand room
when following the latest candle. Panning into older history can move previews offscreen.
Each preview uses its own pixel-local price scale and cannot distort main autoscaling.

All workstation datafeeds use the same `Datafeed.getHistory` adapter. Provider interval
support, authentication and history retention still apply. Select D/W/M previews when
using a daily chart/provider. Lower timeframes, unavailable data and insufficient EMA
history are shown explicitly. No synthetic candles are substituted.

EMA is calculated before cropping the preview. The loader requests three times the
longest EMA length plus visible bars, counted as actual provider bars rather than
elapsed trading time. Previews refresh on data context changes and every 30 seconds;
duplicate preview timeframes share a request. Pan/zoom only repaint cached results.
Removing the indicator clears the timer, context listeners, five series and right margin.

## Maintenance

The workstation saves committed settings immediately when pressing OK, independently
of the periodic Auto save toggle. Refresh restores the latest configuration, including
parameters of inactive indicators. Legacy workspace snapshots migrate newer saved
indicator settings without overwriting more recent per-chart configurations.
Settings groups start collapsed. Opening or closing a group is saved immediately and
restored when reopening the dialog or refreshing the page.

- `src/indicators/builtin/super-ema-model.ts`: pure EMA/alignment/transition calculation.
- `src/indicators/builtin/super-ema-mini-chart.ts`: preview Canvas renderer.
- `src/indicators/builtin/super-ema.ts`: registry settings and lifecycle.
- `examples/workstation/indicator-history.ts`: provider-independent warmup loading.
- `tests/unit/super-ema*.test.ts`, `tests/unit/indicator-history.test.ts`: regression coverage.

EMA reuses the library's length-period SMA seed. Exact numerical parity with the
TradingView indicator is not established because the reference folder has no Pine source.
Crossovers, pullbacks, other MA algorithms and alert notifications are outside phase 1.
