import type { Series } from './series';
import { PriceScale } from './price-scale';

/**
 * A horizontal band of the chart with its own price scale (main pane,
 * RSI pane, MACD pane, ...). All panes share the chart's time scale.
 */
export class Pane {
  readonly series: Series[] = [];
  readonly priceScale = new PriceScale();
  weight: number;

  // DOM and canvases are created and owned by the chart.
  el!: HTMLDivElement;
  resizeHandle?: HTMLDivElement;
  canvas!: HTMLCanvasElement;
  overlay!: HTMLCanvasElement;
  legendEl!: HTMLDivElement;
  ctx!: CanvasRenderingContext2D;
  overlayCtx!: CanvasRenderingContext2D;
  /** CSS pixel height of the pane, updated on layout. */
  height = 0;

  constructor(weight = 1) {
    this.weight = weight;
  }

  autoscale(from: number, to: number): void {
    let min = Infinity;
    let max = -Infinity;
    for (const s of this.series) {
      if (!s.visible || s.ownScaleFraction !== null) continue;
      const mm = s.minMax(from, to);
      if (!mm) continue;
      if (mm.min < min) min = mm.min;
      if (mm.max > max) max = mm.max;
    }
    if (min <= max) this.priceScale.setRange(min, max);
  }
}
