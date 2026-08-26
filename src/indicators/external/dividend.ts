import type { PriceScale } from '../../core/price-scale';
import { Series, type MinMax, type RenderContext } from '../../core/series';
import type { TimeScale } from '../../core/time-scale';
import {
  getIndicatorChartSymbol,
  installIndicatorRuntimeContextTracking,
  onIndicatorChartSymbolChange,
} from '../runtime-context';
import type { IndicatorDef } from '../registry';
import {
  DividendRepository,
  dividendRepository,
  type DividendRecord,
} from './dividend-client';
import {
  isDividendVietnamEquitySymbol,
  mapDividendEventsToCandles,
  type DividendEvent,
  type DividendMarker,
} from './dividend-model';

const DIVIDEND_COLOR = '#f6e3a1';
const DIVIDEND_TEXT_COLOR = '#5a4300';
const ICON_RADIUS = 7;
const ICON_GAP = 9;
const ICON_STACK_STEP = 18;
const HIT_RADIUS = 11;

installIndicatorRuntimeContextTracking();

function iconCenterY(highY: number, stack: number): number {
  return Math.max(ICON_RADIUS + 2, highY - ICON_GAP - ICON_RADIUS - stack * ICON_STACK_STEP);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 4 }).format(value);
}

function formatDate(date: string): string {
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}

function tooltipLines(event: DividendEvent): string[] {
  const lines = [`Cổ tức · ${formatDate(event.exDate)}`];
  if (event.cashVndPerShare !== null) lines.push(`Tiền/CP: ${formatNumber(event.cashVndPerShare)} đ`);
  if (event.cashPercent !== null) lines.push(`Tiền: ${formatNumber(event.cashPercent)}%`);
  if (event.stockPercent !== null) lines.push(`Cổ phiếu: ${formatNumber(event.stockPercent)}%`);
  if (event.bonusPercent !== null) lines.push(`Thưởng: ${formatNumber(event.bonusPercent)}%`);
  return lines;
}

class DividendSeries extends Series {
  private markers: DividendMarker[] = [];
  private hover: DividendMarker | null = null;

  constructor(private readonly getCandles: () => readonly { high: number }[]) {
    super();
    this.title = 'Cổ tức';
    this.legendColor = DIVIDEND_COLOR;
  }

  setMarkers(markers: readonly DividendMarker[]): void {
    this.markers = [...markers];
    if (this.hover && !this.markers.includes(this.hover)) this.hover = null;
  }

  setHover(marker: DividendMarker | null): void {
    this.hover = marker;
  }

  findMarkerAt(x: number, y: number, ts: TimeScale, ps: PriceScale): DividendMarker | null {
    const candles = this.getCandles();
    for (let i = this.markers.length - 1; i >= 0; i -= 1) {
      const marker = this.markers[i];
      const candle = candles[marker.index];
      if (!candle) continue;
      const markerX = ts.xForIndex(marker.index);
      const markerY = iconCenterY(ps.yFor(candle.high), marker.stack);
      if (Math.hypot(x - markerX, y - markerY) <= HIT_RADIUS) return marker;
    }
    return null;
  }

  minMax(): MinMax | null {
    return null;
  }

  valueAt(): number | null {
    return null;
  }

  draw(rc: RenderContext): void {
    const candles = this.getCandles();
    const { ctx, ts, ps, from, to, paneWidth, paneHeight, theme } = rc;
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.font = '700 9px Manrope, -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const marker of this.markers) {
      if (marker.index < from || marker.index > to) continue;
      const candle = candles[marker.index];
      if (!candle) continue;
      const x = ts.xForIndex(marker.index);
      const y = iconCenterY(ps.yFor(candle.high), marker.stack);
      if (x < -ICON_RADIUS || x > paneWidth + ICON_RADIUS) continue;

      ctx.fillStyle = DIVIDEND_COLOR;
      ctx.strokeStyle = theme.bg;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, ICON_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = DIVIDEND_TEXT_COLOR;
      ctx.fillText('D', x, y + 0.5);
    }

    const marker = this.hover;
    const candle = marker ? candles[marker.index] : undefined;
    if (marker && candle && marker.index >= from && marker.index <= to) {
      const x = ts.xForIndex(marker.index);
      const y = iconCenterY(ps.yFor(candle.high), marker.stack);
      const lines = tooltipLines(marker.event);
      ctx.font = '600 11px Manrope, -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const paddingX = 9;
      const paddingY = 7;
      const lineHeight = 16;
      const width = Math.ceil(Math.max(...lines.map((line) => ctx.measureText(line).width))) + paddingX * 2;
      const height = lines.length * lineHeight + paddingY * 2;
      const left = x + width + 14 <= paneWidth ? x + 10 : Math.max(4, x - width - 10);
      const top = Math.max(4, Math.min(paneHeight - height - 4, y - height / 2));

      ctx.fillStyle = theme.axisBg;
      ctx.strokeStyle = DIVIDEND_COLOR;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(left, top, width, height, 5);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = theme.text;
      lines.forEach((line, index) => {
        ctx.fillText(line, left + paddingX, top + paddingY + lineHeight * (index + 0.5));
      });
    }
    ctx.restore();
  }

  hitTest(rc: RenderContext, index: number, x: number, y: number): boolean {
    const candles = this.getCandles();
    return this.markers.some((marker) => {
      if (marker.index !== index) return false;
      const candle = candles[marker.index];
      if (!candle) return false;
      return Math.hypot(
        x - rc.ts.xForIndex(marker.index),
        y - iconCenterY(rc.ps.yFor(candle.high), marker.stack),
      ) <= HIT_RADIUS;
    });
  }
}

export interface DividendIndicatorRuntime {
  repository?: Pick<DividendRepository, 'get'>;
}

export function createDividendIndicatorDef(runtime: DividendIndicatorRuntime = {}): IndicatorDef {
  const repository = runtime.repository ?? dividendRepository;
  return {
    id: 'dividend',
    name: 'Cổ tức',
    category: 'custom',
    order: 12,
    create(chart) {
      const pane = chart.panes[0];
      const series = new DividendSeries(() => chart.getCandles());
      series.indicatorId = 'dividend';
      pane.series.push(series);
      chart.invalidate();

      let record: DividendRecord | null = null;
      let symbol = getIndicatorChartSymbol(chart);
      let generation = 0;
      let loadedSymbol = '';
      let loadingSymbol = '';
      let removed = false;

      const recomputeData = () => {
        const candles = chart.getCandles();
        const markers = record && isDividendVietnamEquitySymbol(symbol)
          ? mapDividendEventsToCandles(candles, record.events, chart.getIntervalSec())
          : [];
        series.setMarkers(markers);
        series.setHover(null);
        chart.invalidate();
      };

      const loadCurrentSymbol = async () => {
        const expectedSymbol = symbol;
        const expectedGeneration = generation;
        if (
          removed
          || !isDividendVietnamEquitySymbol(expectedSymbol)
          || chart.getCandles().length === 0
          || loadedSymbol === expectedSymbol
          || loadingSymbol === expectedSymbol
        ) return;

        loadingSymbol = expectedSymbol;
        try {
          const fresh = await repository.get(expectedSymbol);
          if (removed || generation !== expectedGeneration || symbol !== expectedSymbol) return;
          record = fresh;
          loadedSymbol = expectedSymbol;
          recomputeData();
        } catch (error) {
          if (!removed && generation === expectedGeneration && symbol === expectedSymbol) {
            console.warn(`[Dividend:SQLite] ${expectedSymbol}:`, error);
            record = null;
            recomputeData();
          }
        } finally {
          if (loadingSymbol === expectedSymbol) loadingSymbol = '';
        }
      };

      const resetForSymbol = (nextSymbol: string) => {
        generation += 1;
        symbol = nextSymbol.trim().toUpperCase();
        record = null;
        loadedSymbol = '';
        loadingSymbol = '';
        recomputeData();
      };

      const onPointerMove = (event: PointerEvent) => {
        const rect = pane.el.getBoundingClientRect();
        const marker = series.findMarkerAt(
          event.clientX - rect.left,
          event.clientY - rect.top,
          chart.timeScale,
          pane.priceScale,
        );
        series.setHover(marker);
        chart.invalidate();
      };
      const onPointerLeave = () => {
        series.setHover(null);
        chart.invalidate();
      };
      pane.el.addEventListener('pointermove', onPointerMove);
      pane.el.addEventListener('pointerleave', onPointerLeave);

      const offSymbol = onIndicatorChartSymbolChange(chart, (nextSymbol) => {
        if (nextSymbol === symbol) return;
        resetForSymbol(nextSymbol);
      });

      return {
        recompute() {
          const tracked = getIndicatorChartSymbol(chart);
          if (tracked && tracked !== symbol) resetForSymbol(tracked);
          recomputeData();
          void loadCurrentSymbol();
        },
        remove() {
          removed = true;
          generation += 1;
          pane.el.removeEventListener('pointermove', onPointerMove);
          pane.el.removeEventListener('pointerleave', onPointerLeave);
          offSymbol();
          chart.removeSeries(series);
        },
      };
    },
  };
}

export default createDividendIndicatorDef();
