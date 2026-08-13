import { L2Chart as CoreL2Chart } from './chart';
import type { Candle } from './types';
import type { ManualPriceViewport } from './price-scale';

/**
 * Public chart boundary that keeps user-controlled vertical viewports stable
 * while the same logical series is refreshed or extended in the background.
 *
 * Explicit fit/reset commands still clear manual scaling through CoreL2Chart's
 * `fitContent()` / `fitPriceScale()` methods. Workstation symbol/timeframe loads
 * call those fit methods after installing a genuinely new dataset, so a manual
 * viewport never leaks into a different instrument.
 */
export class L2Chart extends CoreL2Chart {
  override setData(candles: Candle[]): void {
    const viewports = this.captureManualPriceViewports();
    super.setData(candles);
    this.restoreManualPriceViewports(viewports);
  }

  override prependData(candles: Candle[]): void {
    const viewports = this.captureManualPriceViewports();
    super.prependData(candles);
    this.restoreManualPriceViewports(viewports);
  }

  private captureManualPriceViewports(): Array<ManualPriceViewport | null> {
    return this.panes.map((pane) => pane.priceScale.captureManualViewport());
  }

  private restoreManualPriceViewports(viewports: readonly (ManualPriceViewport | null)[]): void {
    viewports.forEach((viewport, index) => {
      this.panes[index]?.priceScale.restoreManualViewport(viewport);
    });
    if (viewports.some(Boolean)) this.invalidate();
  }
}
