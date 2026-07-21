import { clamp } from './utils';

/**
 * Maps logical bar indices to pixels. Index-based (not time-based) so gaps
 * (weekends, missing bars) never create holes in the chart.
 */
export class TimeScale {
  width = 0;
  barSpacing = 8;
  /** Logical index sitting at the right edge of the pane area (float). */
  rightIndex = 0;

  minBarSpacing = 0.5;
  maxBarSpacing = 80;

  private dataLen = 0;

  setWidth(w: number): void {
    const wasAtEnd = this.isAtEnd();
    this.width = w;
    if (wasAtEnd && this.dataLen > 0) this.scrollToEnd();
    else this.clampRight();
  }

  setDataLen(len: number): void {
    const wasAtEnd = this.isAtEnd();
    const appended = len === this.dataLen + 1 && this.dataLen > 0;
    this.dataLen = len;
    if (appended && wasAtEnd) this.rightIndex += 1;
    this.clampRight();
  }

  /** Add older bars before the current data without moving the viewport. */
  prependData(count: number): void {
    if (count <= 0) return;
    this.dataLen += count;
    this.rightIndex += count;
    this.clampRight();
  }

  /** True when the latest bar is (nearly) visible — used for auto-scroll on live data. */
  isAtEnd(): boolean {
    return this.dataLen === 0 || this.rightIndex >= this.dataLen - 2;
  }

  xForIndex(i: number): number {
    return this.width - (this.rightIndex - i) * this.barSpacing;
  }

  indexForX(x: number): number {
    return this.rightIndex - (this.width - x) / this.barSpacing;
  }

  /** Visible inclusive index range clamped to the data, or null when empty. */
  visibleRange(): { from: number; to: number } | null {
    if (this.dataLen === 0 || this.width <= 0) return null;
    const from = clamp(Math.floor(this.indexForX(0)) - 1, 0, this.dataLen - 1);
    const to = clamp(Math.ceil(this.rightIndex) + 1, 0, this.dataLen - 1);
    return from <= to ? { from, to } : null;
  }

  scroll(dxPx: number): void {
    this.rightIndex -= dxPx / this.barSpacing;
    this.clampRight();
  }

  /** Zoom keeping the bar under `anchorX` stationary. */
  zoom(factor: number, anchorX: number): void {
    const anchorIndex = this.indexForX(anchorX);
    this.barSpacing = clamp(this.barSpacing * factor, this.minBarSpacing, this.maxBarSpacing);
    this.rightIndex = anchorIndex + (this.width - anchorX) / this.barSpacing;
    this.clampRight();
  }

  /** Reset to show the most recent data with a small right margin. */
  scrollToEnd(): void {
    const rightMarginBars = this.width <= 720 ? 2 : this.width <= 960 ? 4 : 10;
    this.rightIndex = this.dataLen - 1 + Math.min(rightMarginBars, this.width / this.barSpacing / 10);
    this.clampRight();
  }

  fit(): void {
    this.barSpacing = 8;
    this.scrollToEnd();
  }

  private clampRight(): void {
    if (this.dataLen === 0) return;
    const maxRight = this.dataLen - 1 + (this.width / this.barSpacing) * 0.5;
    this.rightIndex = clamp(this.rightIndex, Math.min(2, this.dataLen - 1), maxRight);
  }
}
