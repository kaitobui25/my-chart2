import type { Candle } from '../../core/types';
import type { RenderContext } from '../../core/series';
import type { EmaOptions, SuperEmaResult } from './super-ema-model';

export interface MiniChart {
  timeframe: string;
  label?: string;
  seconds: number;
  candles: readonly Candle[];
  result?: SuperEmaResult;
  status: string;
  error?: string;
}

/** Pixel-local scale: mini candles and EMA never participate in main autoscale. */
export function drawMiniCharts(rc: RenderContext, charts: readonly MiniChart[], options: readonly EmaOptions[], layout: {
  lastIndex: number; count: number; offset: number; spacing: number; height: number; gap: number;
}): void {
  const { ctx, theme } = rc;
  const x = rc.ts.xForIndex(layout.lastIndex + layout.offset);
  if (x >= rc.paneWidth || x + layout.count * layout.spacing < 0) return;
  const height = Math.min(rc.paneHeight * layout.height / 100,
    (rc.paneHeight - rc.legendHeight - 24 - Math.max(0, charts.length - 1) * layout.gap) / Math.max(1, charts.length));
  if (height < 30) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, rc.paneWidth, rc.paneHeight); ctx.clip();
  ctx.font = '11px sans-serif';
  charts.forEach((chart, slot) => {
    const top = rc.legendHeight + 20 + slot * (height + layout.gap);
    const start = Math.max(0, chart.candles.length - layout.count);
    const bars = chart.candles.slice(start);
    ctx.fillStyle = theme.text;
    const latest = chart.result?.states[chart.result.states.length - 1];
    const title = `${chart.label ?? chart.timeframe} · ${chart.status || latest || 'warming'}`;
    ctx.fillText(title, x, top, Math.max(1, Math.min(layout.count * layout.spacing, rc.paneWidth - x)));
    if (!bars.length || !chart.result) return;
    let low = Infinity, high = -Infinity;
    bars.forEach((bar, i) => {
      low = Math.min(low, bar.low); high = Math.max(high, bar.high);
      options.forEach((option, line) => {
        const value = chart.result!.lines[line][start + i];
        if (option.visible && value !== null) { low = Math.min(low, value); high = Math.max(high, value); }
      });
    });
    const span = high - low || Math.max(Math.abs(high) * 0.001, 1e-8);
    const y = (price: number) => top + 14 + (high - price) / span * (height - 24);
    bars.forEach((bar, i) => {
      const bx = x + i * layout.spacing;
      ctx.strokeStyle = ctx.fillStyle = bar.close >= bar.open ? theme.up : theme.down;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(bx, y(bar.high)); ctx.lineTo(bx, y(bar.low)); ctx.stroke();
      ctx.fillRect(bx - Math.max(1, layout.spacing * 0.55) / 2, Math.min(y(bar.open), y(bar.close)),
        Math.max(1, layout.spacing * 0.55), Math.max(1, Math.abs(y(bar.open) - y(bar.close))));
    });
    options.forEach((option, line) => {
      if (!option.visible) return;
      ctx.strokeStyle = option.color; ctx.lineWidth = option.width;
      ctx.beginPath(); let connected = false;
      bars.forEach((_, i) => {
        const value = chart.result!.lines[line][start + i];
        if (value === null) { connected = false; return; }
        const bx = x + i * layout.spacing;
        if (connected) ctx.lineTo(bx, y(value)); else ctx.moveTo(bx, y(value));
        connected = true;
      });
      ctx.stroke();
    });
  });
  ctx.restore();
}
