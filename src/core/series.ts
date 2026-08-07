import type { Candle, LinePoint, Theme } from './types';
import type { TimeScale } from './time-scale';
import type { PriceScale } from './price-scale';
import { formatPrice, formatCompact } from './utils';

export interface RenderContext {
  ctx: CanvasRenderingContext2D;
  ts: TimeScale;
  ps: PriceScale;
  from: number;
  to: number;
  paneWidth: number;
  paneHeight: number;
  legendWidth: number;
  legendHeight: number;
  theme: Theme;
}

export interface MinMax {
  min: number;
  max: number;
}

export abstract class Series {
  title = '';
  /** Optional preformatted legend value for multi-value/custom series. */
  legendText: string | null = null;
  visible = true;
  /** Series opacity in the inclusive range 0..1. */
  opacity = 1;
  /** Registry id of the indicator that owns this series. */
  indicatorId: string | null = null;
  /** Color shown next to the title in the pane legend. */
  legendColor: string | null = null;
  /** When set, the series keeps its own scale in the bottom fraction of the pane (e.g. volume). */
  ownScaleFraction: number | null = null;

  abstract minMax(from: number, to: number): MinMax | null;
  abstract draw(rc: RenderContext): void;
  abstract valueAt(i: number): number | null;

  hitTest(_rc: RenderContext, _index: number, _x: number, _y: number, _tolerance = 7): boolean {
    return false;
  }

  formatValue(v: number, decimals: number): string {
    return formatPrice(v, decimals);
  }
}

export type PriceSeriesMode = 'candles' | 'heikin-ashi' | 'bars' | 'line' | 'area';

/** The main OHLC series of a chart. Reads candles owned by the chart (no copy). */
export class CandleSeries extends Series {
  mode: PriceSeriesMode = 'candles';
  lineColor: string | null = null;
  areaColor: string | null = null;

  constructor(private getData: () => readonly Candle[]) {
    super();
  }

  minMax(from: number, to: number): MinMax | null {
    const data = this.getData();
    if (data.length === 0) return null;
    let min = Infinity;
    let max = -Infinity;
    const hl = this.mode === 'candles' || this.mode === 'heikin-ashi' || this.mode === 'bars';
    for (let i = from; i <= to; i++) {
      const c = data[i];
      if (hl) {
        if (c.low < min) min = c.low;
        if (c.high > max) max = c.high;
      } else {
        if (c.close < min) min = c.close;
        if (c.close > max) max = c.close;
      }
    }
    return min <= max ? { min, max } : null;
  }

  valueAt(i: number): number | null {
    const data = this.getData();
    return data[i] ? data[i].close : null;
  }

  draw(rc: RenderContext): void {
    switch (this.mode) {
      case 'candles':
      case 'heikin-ashi':
        this.drawCandles(rc);
        break;
      case 'bars':
        this.drawBars(rc);
        break;
      case 'line':
      case 'area':
        this.drawLine(rc, this.mode === 'area');
        break;
    }
  }

  private drawCandles(rc: RenderContext): void {
    const { ctx, ts, ps, from, to, theme } = rc;
    const data = this.getData();
    // A shared canvas must not leak a shadow/glow from a previously drawn series.
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    // An odd body width keeps the one-pixel wick centered and crisp.
    let bw = Math.max(1, Math.round(ts.barSpacing * 0.72));
    if (bw > 1 && bw % 2 === 0) bw -= 1;
    const half = bw >> 1;
    const drawWicks = ts.barSpacing >= 1.5;
    for (let i = from; i <= to; i++) {
      const c = data[i];
      const x = Math.round(ts.xForIndex(i));
      const up = c.close >= c.open;
      if (drawWicks) {
        ctx.fillStyle = up ? theme.wickUp : theme.wickDown;
        const yH = ps.yFor(c.high);
        ctx.fillRect(x, yH, 1, Math.max(1, ps.yFor(c.low) - yH));
      }
      const yO = ps.yFor(c.open);
      const yC = ps.yFor(c.close);
      ctx.fillStyle = up ? theme.up : theme.down;
      ctx.fillRect(x - half, Math.min(yO, yC), bw, Math.max(1, Math.abs(yO - yC)));
    }
  }

  private drawBars(rc: RenderContext): void {
    const { ctx, ts, ps, from, to, theme } = rc;
    const data = this.getData();
    const tick = Math.max(2, Math.round(ts.barSpacing * 0.4));
    for (let i = from; i <= to; i++) {
      const c = data[i];
      const x = Math.round(ts.xForIndex(i));
      const up = c.close >= c.open;
      ctx.fillStyle = up ? theme.up : theme.down;
      const yH = ps.yFor(c.high);
      ctx.fillRect(x, yH, 1, Math.max(1, ps.yFor(c.low) - yH));
      ctx.fillRect(x - tick, Math.round(ps.yFor(c.open)), tick, 1);
      ctx.fillRect(x + 1, Math.round(ps.yFor(c.close)), tick, 1);
    }
  }

  private drawLine(rc: RenderContext, fill: boolean): void {
    const { ctx, ts, ps, from, to, theme, paneHeight } = rc;
    const data = this.getData();
    if (to <= from) return;
    ctx.beginPath();
    for (let i = from; i <= to; i++) {
      const x = ts.xForIndex(i);
      const y = ps.yFor(data[i].close);
      i === from ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    const color = fill
      ? this.areaColor ?? theme.palette[0]
      : this.lineColor ?? theme.palette[0];
    if (fill) {
      const grad = ctx.createLinearGradient(0, 0, 0, paneHeight);
      grad.addColorStop(0, color + '55');
      grad.addColorStop(1, color + '00');
      ctx.save();
      ctx.lineTo(ts.xForIndex(to), paneHeight);
      ctx.lineTo(ts.xForIndex(from), paneHeight);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      for (let i = from; i <= to; i++) {
        const x = ts.xForIndex(i);
        const y = ps.yFor(data[i].close);
        i === from ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}

export interface VisibleRangeExtremaSeriesOptions {
  highColor?: string;
  lowColor?: string;
  title?: string;
  highLabel?: string;
  lowLabel?: string;
}

/** Labels the highest high and lowest low inside the current visible range. */
export class VisibleRangeExtremaSeries extends Series {
  private highColor: string;
  private lowColor: string;
  private highLabel: string;
  private lowLabel: string;

  constructor(
    private getData: () => readonly Candle[],
    opts: VisibleRangeExtremaSeriesOptions = {},
  ) {
    super();
    this.title = opts.title ?? 'Visible range High/Low';
    this.highColor = opts.highColor ?? '#2f80ff';
    this.lowColor = opts.lowColor ?? '#f4b740';
    this.highLabel = opts.highLabel ?? 'High';
    this.lowLabel = opts.lowLabel ?? 'Low';
    this.legendColor = this.highColor;
  }

  minMax(): MinMax | null {
    return null;
  }

  valueAt(): number | null {
    return null;
  }

  draw(rc: RenderContext): void {
    const extrema = this.extrema(rc.from, rc.to);
    if (!extrema) {
      this.legendText = null;
      return;
    }
    const { ctx, ts, ps, paneWidth, paneHeight, theme } = rc;
    const highText = ps.formatLabel(extrema.high);
    const lowText = ps.formatLabel(extrema.low);
    this.legendText = `${this.highLabel} ${highText} · ${this.lowLabel} ${lowText}`;
    this.drawMarker(ctx, ts.xForIndex(extrema.highIndex), ps.yFor(extrema.high), `${this.highLabel} ${highText}`, this.highColor, true, paneWidth, paneHeight, rc.legendWidth, rc.legendHeight, theme);
    this.drawMarker(ctx, ts.xForIndex(extrema.lowIndex), ps.yFor(extrema.low), `${this.lowLabel} ${lowText}`, this.lowColor, false, paneWidth, paneHeight, rc.legendWidth, rc.legendHeight, theme);
  }

  hitTest(rc: RenderContext, _index: number, x: number, y: number, tolerance = 7): boolean {
    const extrema = this.extrema(rc.from, rc.to);
    if (!extrema) return false;
    const highHit = Math.abs(x - rc.ts.xForIndex(extrema.highIndex)) <= 18
      && Math.abs(y - rc.ps.yFor(extrema.high)) <= tolerance + 5;
    const lowHit = Math.abs(x - rc.ts.xForIndex(extrema.lowIndex)) <= 18
      && Math.abs(y - rc.ps.yFor(extrema.low)) <= tolerance + 5;
    return highHit || lowHit;
  }

  private extrema(from: number, to: number): { high: number; low: number; highIndex: number; lowIndex: number } | null {
    const data = this.getData();
    const start = Math.max(0, Math.ceil(from));
    const end = Math.min(data.length - 1, Math.floor(to));
    if (start > end) return null;
    let high = -Infinity;
    let low = Infinity;
    let highIndex = start;
    let lowIndex = start;
    for (let i = start; i <= end; i++) {
      const candle = data[i];
      if (candle.high >= high) {
        high = candle.high;
        highIndex = i;
      }
      if (candle.low <= low) {
        low = candle.low;
        lowIndex = i;
      }
    }
    return Number.isFinite(high) && Number.isFinite(low) ? { high, low, highIndex, lowIndex } : null;
  }

  private drawMarker(
    ctx: CanvasRenderingContext2D,
    rawX: number,
    rawY: number,
    text: string,
    color: string,
    placeAbove: boolean,
    paneWidth: number,
    paneHeight: number,
    legendWidth: number,
    legendHeight: number,
    theme: Theme,
  ): void {
    const x = Math.round(rawX);
    const y = Math.round(rawY);
    ctx.save();
    ctx.shadowBlur = 0;
    const baseAlpha = ctx.globalAlpha;
    ctx.font = '600 10px Manrope, -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textBaseline = 'middle';
    const width = Math.ceil(ctx.measureText(text).width) + 10;
    const height = 18;
    const desiredTop = placeAbove ? y - height - 6 : y + 6;
    const left = Math.max(4, Math.min(paneWidth - width - 4, x - width / 2));
    const top = desiredTop;
    const anchorIsVisible = x >= 0 && x <= paneWidth && y >= 0 && y <= paneHeight;
    const labelFitsVertically = top >= 4 && top + height <= paneHeight - 4;
    const overlapsLegend = left < legendWidth + 8 && top < legendHeight + 8;
    if (!anchorIsVisible || !labelFitsVertically || overlapsLegend) {
      ctx.restore();
      return;
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = baseAlpha * 0.84;
    ctx.fillStyle = theme.axisBg;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(left, top, width, height, 4);
    ctx.fill();
    ctx.stroke();
    ctx.globalAlpha = baseAlpha * 0.9;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(text, left + width / 2, top + height / 2 + 0.5);
    ctx.restore();
  }
}

export interface LineSeriesOptions {
  color?: string;
  lineWidth?: number;
  lineStyle?: 'solid' | 'dashed' | 'dotted';
  fill?: boolean;
  title?: string;
}

/** A polyline of values aligned to candle indices (indicators, overlays). */
export class LineSeries extends Series {
  data: LinePoint[] = [];
  color: string;
  lineWidth: number;
  lineStyle: 'solid' | 'dashed' | 'dotted';
  fill: boolean;

  constructor(opts: LineSeriesOptions = {}) {
    super();
    this.color = opts.color ?? '#2962ff';
    this.lineWidth = opts.lineWidth ?? 1.5;
    this.lineStyle = opts.lineStyle ?? 'solid';
    this.fill = opts.fill ?? false;
    this.title = opts.title ?? '';
    this.legendColor = this.color;
  }

  setData(data: LinePoint[]): void {
    this.data = data;
  }

  minMax(from: number, to: number): MinMax | null {
    let min = Infinity;
    let max = -Infinity;
    for (let i = from; i <= to && i < this.data.length; i++) {
      const v = this.data[i];
      if (v === null || v === undefined) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return min <= max ? { min, max } : null;
  }

  valueAt(i: number): number | null {
    return this.data[i] ?? null;
  }

  draw(rc: RenderContext): void {
    const { ctx, ts, ps, from, to, paneHeight } = rc;
    const segments: { x: number; y: number }[][] = [];
    let segment: { x: number; y: number }[] = [];
    for (let i = from; i <= to && i < this.data.length; i++) {
      const v = this.data[i];
      if (v === null || v === undefined) {
        if (segment.length) segments.push(segment);
        segment = [];
        continue;
      }
      segment.push({ x: ts.xForIndex(i), y: ps.yFor(v) });
    }
    if (segment.length) segments.push(segment);
    if (this.fill) {
      ctx.save();
      ctx.globalAlpha *= 0.12;
      ctx.fillStyle = this.color;
      for (const points of segments) {
        if (points.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
        ctx.lineTo(points[points.length - 1].x, paneHeight);
        ctx.lineTo(points[0].x, paneHeight);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
    ctx.beginPath();
    for (const points of segments) {
      if (!points.length) continue;
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.strokeStyle = this.color;
    ctx.lineWidth = this.lineWidth;
    ctx.lineJoin = 'round';
    ctx.setLineDash(this.lineStyle === 'dashed' ? [7, 5] : this.lineStyle === 'dotted' ? [2, 4] : []);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  hitTest(rc: RenderContext, index: number, x: number, y: number, tolerance = 7): boolean {
    const distanceToSegment = (
      px: number,
      py: number,
      ax: number,
      ay: number,
      bx: number,
      by: number,
    ): number => {
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSq = dx * dx + dy * dy;
      if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
      return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    };
    const point = (i: number): { x: number; y: number } | null => {
      const value = this.data[i];
      return value === null || value === undefined
        ? null
        : { x: rc.ts.xForIndex(i), y: rc.ps.yFor(value) };
    };
    const center = point(index);
    const before = point(index - 1);
    const after = point(index + 1);
    const threshold = Math.max(tolerance, this.lineWidth + 5);
    if (center && Math.hypot(x - center.x, y - center.y) <= threshold) return true;
    if (before && center && distanceToSegment(x, y, before.x, before.y, center.x, center.y) <= threshold) return true;
    return !!(center && after && distanceToSegment(x, y, center.x, center.y, after.x, after.y) <= threshold);
  }
}

/**
 * Per-bar full-height background highlight.
 * `data[i]` is a CSS color for the bar at index i, or null for no highlight.
 */
export class ZoneSeries extends Series {
  data: (string | null)[] = [];

  setData(data: (string | null)[]): void {
    this.data = data;
  }

  minMax(): MinMax | null {
    return null;
  }

  valueAt(): number | null {
    return null;
  }

  draw(rc: RenderContext): void {
    const { ctx, ts, from, to, paneHeight } = rc;
    const half = ts.barSpacing / 2;
    let i = from;
    while (i <= to && i < this.data.length) {
      const color = this.data[i];
      if (!color) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 <= to && j + 1 < this.data.length && this.data[j + 1] === color) j++;
      const x1 = ts.xForIndex(i) - half;
      const x2 = ts.xForIndex(j) + half;
      ctx.fillStyle = color;
      ctx.fillRect(x1, 0, x2 - x1, paneHeight);
      i = j + 1;
    }
  }
}

export interface BandSeriesOptions {
  fillColor?: string;
  title?: string;
}

/** Translucent fill between two value arrays. */
export class BandSeries extends Series {
  upper: LinePoint[] = [];
  lower: LinePoint[] = [];
  fillColor: string;

  constructor(opts: BandSeriesOptions = {}) {
    super();
    this.fillColor = opts.fillColor ?? 'rgba(121, 180, 250, 0.08)';
    this.title = opts.title ?? '';
  }

  setData(upper: LinePoint[], lower: LinePoint[]): void {
    this.upper = upper;
    this.lower = lower;
  }

  minMax(from: number, to: number): MinMax | null {
    let min = Infinity;
    let max = -Infinity;
    for (let i = from; i <= to; i++) {
      for (const v of [this.upper[i], this.lower[i]]) {
        if (v === null || v === undefined) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    return min <= max ? { min, max } : null;
  }

  valueAt(): number | null {
    return null;
  }

  draw(rc: RenderContext): void {
    const { ctx, ts, ps, from, to } = rc;
    ctx.fillStyle = this.fillColor;
    let seg: number[] = [];
    const flush = () => {
      if (seg.length >= 2) {
        ctx.beginPath();
        seg.forEach((i, k) => {
          const x = ts.xForIndex(i);
          const y = ps.yFor(this.upper[i] as number);
          k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        for (let k = seg.length - 1; k >= 0; k--) {
          const i = seg[k];
          ctx.lineTo(ts.xForIndex(i), ps.yFor(this.lower[i] as number));
        }
        ctx.closePath();
        ctx.fill();
      }
      seg = [];
    };
    for (let i = from; i <= to && i < this.upper.length; i++) {
      const u = this.upper[i];
      const l = this.lower[i];
      if (u === null || u === undefined || l === null || l === undefined) flush();
      else seg.push(i);
    }
    flush();
  }
}

export interface HistogramSeriesOptions {
  title?: string;
  posColor?: string;
  negColor?: string;
  /** Per-bar color override; wins over posColor/negColor. */
  colorFor?: (i: number, v: number) => string;
  /** Render inside the bottom fraction of the pane on an independent scale (volume style). */
  ownScaleFraction?: number;
  /** Format legend values compactly (1.2M) instead of as prices. */
  compact?: boolean;
}

/** Vertical bars from a baseline (0) or from the pane bottom when using its own scale. */
export class HistogramSeries extends Series {
  data: LinePoint[] = [];
  private posColor: string;
  private negColor: string;
  private colorFor?: (i: number, v: number) => string;
  private compact: boolean;

  constructor(opts: HistogramSeriesOptions = {}) {
    super();
    this.title = opts.title ?? '';
    this.posColor = opts.posColor ?? 'rgba(38,166,154,0.6)';
    this.negColor = opts.negColor ?? 'rgba(239,83,80,0.6)';
    this.colorFor = opts.colorFor;
    this.ownScaleFraction = opts.ownScaleFraction ?? null;
    this.compact = opts.compact ?? false;
    this.legendColor = this.posColor;
  }

  setData(data: LinePoint[]): void {
    this.data = data;
  }

  formatValue(v: number, decimals: number): string {
    return this.compact ? formatCompact(v) : formatPrice(v, decimals);
  }

  minMax(from: number, to: number): MinMax | null {
    if (this.ownScaleFraction !== null) return null;
    let min = 0;
    let max = 0;
    let any = false;
    for (let i = from; i <= to && i < this.data.length; i++) {
      const v = this.data[i];
      if (v === null || v === undefined) continue;
      any = true;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return any ? { min, max } : null;
  }

  valueAt(i: number): number | null {
    return this.data[i] ?? null;
  }

  draw(rc: RenderContext): void {
    const { ctx, ts, ps, from, to, paneHeight } = rc;
    let bw = Math.max(1, Math.round(ts.barSpacing * 0.66));
    if (bw > 1 && bw % 2 === 0) bw -= 1;
    const half = bw >> 1;

    if (this.ownScaleFraction !== null) {
      let max = 0;
      for (let i = from; i <= to && i < this.data.length; i++) {
        const v = this.data[i];
        if (v !== null && v !== undefined && v > max) max = v;
      }
      if (max <= 0) return;
      const area = paneHeight * this.ownScaleFraction;
      for (let i = from; i <= to && i < this.data.length; i++) {
        const v = this.data[i];
        if (v === null || v === undefined) continue;
        const h = Math.max(1, (v / max) * area);
        const x = Math.round(ts.xForIndex(i));
        ctx.fillStyle = this.colorFor ? this.colorFor(i, v) : this.posColor;
        ctx.fillRect(x - half, paneHeight - h, bw, h);
      }
      return;
    }

    const y0 = ps.yFor(0);
    for (let i = from; i <= to && i < this.data.length; i++) {
      const v = this.data[i];
      if (v === null || v === undefined) continue;
      const y = ps.yFor(v);
      const x = Math.round(ts.xForIndex(i));
      ctx.fillStyle = this.colorFor
        ? this.colorFor(i, v)
        : v >= 0
          ? this.posColor
          : this.negColor;
      ctx.fillRect(x - half, Math.min(y, y0), bw, Math.max(1, Math.abs(y - y0)));
    }
  }

  hitTest(rc: RenderContext, index: number, x: number, y: number, tolerance = 7): boolean {
    const value = this.data[index];
    if (value === null || value === undefined) return false;
    const barX = rc.ts.xForIndex(index);
    if (Math.abs(x - barX) > Math.max(tolerance, rc.ts.barSpacing * 0.5)) return false;
    if (this.ownScaleFraction !== null) {
      let max = 0;
      for (let i = rc.from; i <= rc.to && i < this.data.length; i++) {
        const candidate = this.data[i];
        if (candidate !== null && candidate !== undefined && candidate > max) max = candidate;
      }
      if (max <= 0) return false;
      const height = Math.max(1, (value / max) * rc.paneHeight * this.ownScaleFraction);
      return y >= rc.paneHeight - height - tolerance && y <= rc.paneHeight + tolerance;
    }
    const y0 = rc.ps.yFor(0);
    const valueY = rc.ps.yFor(value);
    return y >= Math.min(y0, valueY) - tolerance && y <= Math.max(y0, valueY) + tolerance;
  }
}
