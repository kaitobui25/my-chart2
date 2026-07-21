import { niceStep, decimalsForStep, formatPrice } from './utils';

export type PriceScaleMode = 'regular' | 'percent' | 'indexed' | 'log';

/** Vertical price → pixel mapping for one pane. Auto-scales to the visible range. */
export class PriceScale {
  height = 0;
  marginTop = 0.1;
  marginBottom = 0.1;

  private min = 0;
  private max = 1;
  private autoMin = 0;
  private autoMax = 1;
  private rawAutoMin = 0;
  private rawAutoMax = 1;
  private manual = false;
  private mode: PriceScaleMode = 'regular';
  private inverted = false;
  private basePrice = 1;
  private precision: number | null = null;
  /** Tick step of the last computed ticks — reused for label decimals. */
  lastStep = 1;
  private lastDisplayStep = 1;

  setHeight(h: number): void {
    this.height = h;
  }

  setRange(min: number, max: number): void {
    this.rawAutoMin = min;
    this.rawAutoMax = max;
    min = this.transform(min);
    max = this.transform(max);
    if (min > max) [min, max] = [max, min];
    let range = max - min;
    if (range <= 0) {
      const pad = Math.abs(max) * 0.01 || 1;
      min -= pad;
      max += pad;
      range = max - min;
    }
    this.autoMin = min - range * this.marginBottom;
    this.autoMax = max + range * this.marginTop;
    if (!this.manual) {
      this.min = this.autoMin;
      this.max = this.autoMax;
    }
  }

  /** Scale the current visible range around a Y-axis anchor. */
  scaleBy(factor: number, anchorY: number): void {
    if (this.height <= 0 || !Number.isFinite(factor) || factor <= 0) return;
    const currentRange = this.max - this.min;
    const autoRange = Math.max(Number.EPSILON, this.autoMax - this.autoMin);
    const nextRange = Math.min(autoRange * 100, Math.max(autoRange * 0.02, currentRange * factor));
    const anchorRatio = Math.min(1, Math.max(0, anchorY / this.height));
    const anchorValue = this.transform(this.priceFor(anchorY));
    if (this.inverted) {
      this.min = anchorValue - nextRange * anchorRatio;
      this.max = this.min + nextRange;
    } else {
      this.max = anchorValue + nextRange * anchorRatio;
      this.min = this.max - nextRange;
    }
    this.manual = true;
  }

  /** Pan the visible range so chart content follows a vertical pointer drag. */
  panBy(deltaPx: number): void {
    if (this.height <= 0 || !Number.isFinite(deltaPx) || deltaPx === 0) return;
    const range = this.max - this.min;
    if (!(range > 0)) return;
    const deltaValue = (deltaPx / this.height) * range * (this.inverted ? -1 : 1);
    this.min += deltaValue;
    this.max += deltaValue;
    this.manual = true;
  }

  /** Return to the range computed from visible series data. */
  reset(): void {
    this.manual = false;
    this.min = this.autoMin;
    this.max = this.autoMax;
  }

  isManual(): boolean {
    return this.manual;
  }

  setMode(mode: PriceScaleMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.manual = false;
    this.setRange(this.rawAutoMin, this.rawAutoMax);
  }

  getMode(): PriceScaleMode {
    return this.mode;
  }

  setInverted(inverted: boolean): void {
    this.inverted = inverted;
  }

  isInverted(): boolean {
    return this.inverted;
  }

  setBasePrice(price: number): void {
    if (!(price > 0) || !Number.isFinite(price) || price === this.basePrice) return;
    this.basePrice = price;
    if (this.mode !== 'regular') {
      this.manual = false;
      this.setRange(this.rawAutoMin, this.rawAutoMax);
    }
  }

  setPrecision(decimals: number | null): void {
    this.precision = decimals === null
      ? null
      : Math.min(8, Math.max(0, Math.floor(decimals)));
  }

  yFor(price: number): number {
    const value = this.transform(price);
    const ratio = (value - this.min) / (this.max - this.min);
    return (this.inverted ? ratio : 1 - ratio) * this.height;
  }

  priceFor(y: number): number {
    const ratio = this.inverted ? y / this.height : 1 - y / this.height;
    return this.inverse(this.min + ratio * (this.max - this.min));
  }

  decimals(): number {
    if (this.mode === 'regular' && this.precision !== null) return this.precision;
    return decimalsForStep(this.lastStep);
  }

  ticks(targetSpacingPx = 55): number[] {
    const range = this.max - this.min;
    if (range <= 0 || this.height <= 0) return [];
    const step = niceStep((range * targetSpacingPx) / this.height);
    this.lastDisplayStep = step;
    const center = (this.min + this.max) / 2;
    this.lastStep = Math.abs(this.inverse(center + step) - this.inverse(center)) || step;
    const out: number[] = [];
    for (let value = Math.ceil(this.min / step) * step; value <= this.max; value += step) {
      out.push(this.inverse(value));
    }
    return out;
  }

  formatLabel(price: number): string {
    const value = this.transform(price);
    const decimals = this.mode === 'regular' && this.precision !== null
      ? this.precision
      : decimalsForStep(this.lastDisplayStep);
    const label = formatPrice(value, decimals);
    return this.mode === 'percent' ? `${label}%` : label;
  }

  private transform(price: number): number {
    switch (this.mode) {
      case 'percent': return ((price / this.basePrice) - 1) * 100;
      case 'indexed': return (price / this.basePrice) * 100;
      case 'log': return Math.log(Math.max(price, Number.EPSILON));
      default: return price;
    }
  }

  private inverse(value: number): number {
    switch (this.mode) {
      case 'percent': return this.basePrice * (1 + value / 100);
      case 'indexed': return this.basePrice * value / 100;
      case 'log': return Math.exp(value);
      default: return value;
    }
  }
}
