import { Series, type MinMax, type RenderContext } from '../../core/series';
import type { LnttPoint, LnttValueMode } from './lntt-model';

const BILLION_FORMAT = new Intl.NumberFormat('vi-VN', {
  maximumFractionDigits: 1,
});

function formatPercent(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

export class LnttSeries extends Series {
  private points: LnttPoint[] = [];
  private byIndex = new Map<number, LnttPoint>();

  constructor(private readonly mode: LnttValueMode) {
    super();
    this.title = mode === 'percent' ? 'LNTT YoY (%)' : 'LNTT (tỷ VND)';
  }

  setData(points: readonly LnttPoint[]): void {
    this.points = [...points];
    this.byIndex = new Map(this.points.map((point) => [point.index, point]));
  }

  minMax(from: number, to: number): MinMax | null {
    let min = 0;
    let max = 0;
    let found = false;
    for (const point of this.points) {
      if (point.index < from || point.index > to) continue;
      min = Math.min(min, point.value);
      max = Math.max(max, point.value);
      found = true;
    }
    return found ? { min, max } : null;
  }

  valueAt(index: number): number | null {
    return this.byIndex.get(index)?.value ?? null;
  }

  formatValue(value: number): string {
    return this.mode === 'percent'
      ? formatPercent(value)
      : `${BILLION_FORMAT.format(value)} tỷ`;
  }

  draw(rc: RenderContext): void {
    if (this.points.length === 0) return;
    const { ctx, ts, ps, from, to, paneWidth, theme } = rc;
    const zeroY = ps.yFor(0);

    ctx.save();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(zeroY) + 0.5);
    ctx.lineTo(paneWidth, Math.round(zeroY) + 0.5);
    ctx.stroke();

    let barWidth = Math.max(1, Math.min(15, Math.round(ts.barSpacing * 0.55)));
    if (barWidth > 1 && barWidth % 2 === 0) barWidth -= 1;
    const halfBar = barWidth >> 1;

    ctx.globalAlpha *= 0.92;
    ctx.fillStyle = theme.text;
    for (const point of this.points) {
      if (point.index < from || point.index > to) continue;
      const x = Math.round(ts.xForIndex(point.index));
      if (x < -barWidth || x > paneWidth + barWidth) continue;
      const valueY = ps.yFor(point.value);
      const top = Math.min(zeroY, valueY);
      const height = Math.max(1, Math.abs(valueY - zeroY));
      ctx.fillRect(x - halfBar, top, barWidth, height);
    }
    ctx.restore();
  }

  hitTest(rc: RenderContext, index: number, x: number, y: number, tolerance = 5): boolean {
    const point = this.byIndex.get(index);
    if (!point) return false;
    const pointX = rc.ts.xForIndex(index);
    const zeroY = rc.ps.yFor(0);
    const valueY = rc.ps.yFor(point.value);
    return Math.abs(x - pointX) <= Math.max(5, tolerance)
      && y >= Math.min(zeroY, valueY) - tolerance
      && y <= Math.max(zeroY, valueY) + tolerance;
  }
}
