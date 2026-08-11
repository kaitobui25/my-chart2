import type { L2Chart } from '../../core/chart';
import { Series, type MinMax, type RenderContext } from '../../core/series';
import type { LinePoint } from '../../core/types';
import {
  getIndicatorChartSymbol,
  installIndicatorRuntimeContextTracking,
  onIndicatorChartSymbolChange,
} from '../runtime-context';
import type { IndicatorDef } from '../registry';
import { PeFundamentalsRepository } from './pe-client';
import type { PeFundamentalsRecord } from './pe-cache';
import { computePeSeries, type PeMarker } from './pe-model';

export const PE_CACHE_MISS_DELAY_MS = 30_000;
export const PE_CACHE_REFRESH_SECONDS = 24 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;
const QUARTER_MARKER_COLOR = '#f4b740';

installIndicatorRuntimeContextTracking();

function formatPe(value: number | null): string {
  return value !== null && Number.isFinite(value) ? value.toFixed(2) : '—';
}

class PeMarkerSeries extends Series {
  private markers: PeMarker[] = [];
  private hoverIndex: number | null = null;
  private hoverValues: readonly LinePoint[] = [];
  private lineColor = '#3b82f6';

  constructor() {
    super();
    this.legendColor = QUARTER_MARKER_COLOR;
  }

  setState(
    markers: readonly PeMarker[],
    values: readonly LinePoint[],
    hoverIndex: number | null,
    lineColor: string,
  ): void {
    this.markers = [...markers];
    this.hoverValues = values;
    this.hoverIndex = hoverIndex;
    this.lineColor = lineColor;
  }

  minMax(from: number, to: number): MinMax | null {
    let min = Infinity;
    let max = -Infinity;
    for (const marker of this.markers) {
      if (marker.index < from || marker.index > to) continue;
      min = Math.min(min, marker.value);
      max = Math.max(max, marker.value);
    }
    return min <= max ? { min, max } : null;
  }

  valueAt(): number | null {
    return null;
  }

  draw(rc: RenderContext): void {
    const { ctx, ts, ps, from, to, paneWidth, paneHeight, theme } = rc;
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1;
    for (const marker of this.markers) {
      if (marker.index < from || marker.index > to) continue;
      const x = ts.xForIndex(marker.index);
      const y = ps.yFor(marker.value);
      if (x < -5 || x > paneWidth + 5 || y < -5 || y > paneHeight + 5) continue;
      ctx.fillStyle = QUARTER_MARKER_COLOR;
      ctx.strokeStyle = theme.bg;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    const hoverIndex = this.hoverIndex;
    const hoverValue = hoverIndex === null ? null : this.hoverValues[hoverIndex] ?? null;
    if (hoverIndex !== null && hoverValue !== null && Number.isFinite(hoverValue)) {
      const x = ts.xForIndex(hoverIndex);
      const y = ps.yFor(hoverValue);
      if (x >= 0 && x <= paneWidth && y >= 0 && y <= paneHeight) {
        const text = `P/E ${formatPe(hoverValue)}`;
        ctx.font = '600 11px Manrope, -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textBaseline = 'middle';
        const width = Math.ceil(ctx.measureText(text).width) + 12;
        const height = 20;
        const left = x + width + 12 <= paneWidth ? x + 8 : Math.max(4, x - width - 8);
        const top = Math.max(4, Math.min(paneHeight - height - 4, y - height / 2));
        ctx.fillStyle = this.lineColor;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = theme.axisBg;
        ctx.strokeStyle = this.lineColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(left, top, width, height, 4);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = this.lineColor;
        ctx.textAlign = 'center';
        ctx.fillText(text, left + width / 2, top + height / 2 + 0.5);
      }
    }
    ctx.restore();
  }

  hitTest(rc: RenderContext, _index: number, x: number, y: number, tolerance = 7): boolean {
    for (const marker of this.markers) {
      if (marker.index < rc.from || marker.index > rc.to) continue;
      const markerX = rc.ts.xForIndex(marker.index);
      const markerY = rc.ps.yFor(marker.value);
      if (Math.hypot(x - markerX, y - markerY) <= Math.max(7, tolerance)) return true;
    }
    return false;
  }
}

export interface PeIndicatorRuntime {
  repository?: PeFundamentalsRepository;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export function createPeIndicatorDef(runtime: PeIndicatorRuntime = {}): IndicatorDef {
  const repository = runtime.repository ?? new PeFundamentalsRepository();
  const setTimer = runtime.setTimer ?? setTimeout;
  const clearTimer = runtime.clearTimer ?? clearTimeout;

  return {
    id: 'pe',
    name: 'P/E',
    category: 'custom',
    order: 10,
    create(chart: L2Chart) {
      const pane = chart.addPane(1);
      const line = chart.addLine({ title: 'P/E', color: chart.theme.palette[0], lineWidth: 1.5, pane });
      const markerSeries = new PeMarkerSeries();
      markerSeries.indicatorId = 'pe';
      markerSeries.opacity = line.opacity;
      pane.series.push(markerSeries);
      chart.invalidate();

      let record: PeFundamentalsRecord | null = null;
      let symbol = getIndicatorChartSymbol(chart);
      let generation = 0;
      let hoverIndex: number | null = null;
      let cacheRead = false;
      let fetchInProgress = false;
      let fetchTimer: ReturnType<typeof setTimeout> | null = null;
      let manualMissFetch = chart.getCandles().length > 0 && !!symbol;
      let removed = false;

      const clearTimerIfNeeded = () => {
        if (fetchTimer !== null) {
          clearTimer(fetchTimer);
          fetchTimer = null;
        }
      };

      const clearVisuals = () => {
        const empty = new Array<LinePoint>(chart.getCandles().length).fill(null);
        line.setData(empty);
        line.legendText = '—';
        markerSeries.setState([], empty, null, line.color);
        chart.invalidate();
      };

      const render = () => {
        const candles = chart.getCandles();
        if (!record || chart.getIntervalSec() < DAY_SECONDS) {
          clearVisuals();
          return;
        }
        const computed = computePeSeries(candles, record.quarters, chart.getIntervalSec());
        line.setData(computed.values);
        line.legendText = hoverIndex === null
          ? formatPe(computed.latestReportedPe)
          : formatPe(computed.values[hoverIndex] ?? null);
        markerSeries.setState(computed.markers, computed.values, hoverIndex, line.color);
        chart.invalidate();
      };

      const fetchFresh = async (expectedSymbol: string, expectedGeneration: number) => {
        if (fetchInProgress || removed) return;
        fetchInProgress = true;
        try {
          const fresh = await repository.fetchAndCache(expectedSymbol);
          if (removed || generation !== expectedGeneration || symbol !== expectedSymbol) return;
          record = fresh;
          render();
        } catch (error) {
          // Fundamental-data failures must never poison the candle provider or block interaction.
          console.warn(`[P/E] ${expectedSymbol}:`, error);
        } finally {
          if (generation === expectedGeneration && symbol === expectedSymbol) fetchInProgress = false;
        }
      };

      const scheduleFetch = (expectedSymbol: string, expectedGeneration: number, delayMs: number) => {
        clearTimerIfNeeded();
        if (delayMs <= 0) {
          void fetchFresh(expectedSymbol, expectedGeneration);
          return;
        }
        fetchTimer = setTimer(() => {
          fetchTimer = null;
          if (removed || generation !== expectedGeneration || symbol !== expectedSymbol) return;
          void fetchFresh(expectedSymbol, expectedGeneration);
        }, delayMs);
      };

      const loadForCurrentSymbol = async () => {
        const expectedSymbol = symbol;
        const expectedGeneration = generation;
        if (!expectedSymbol || cacheRead || removed) return;
        cacheRead = true;
        const cached = await repository.getCached(expectedSymbol).catch(() => null);
        if (removed || generation !== expectedGeneration || symbol !== expectedSymbol) return;
        if (cached) {
          record = cached;
          render();
          const age = Math.floor(Date.now() / 1000) - cached.fetchedAt;
          if (age > PE_CACHE_REFRESH_SECONDS) {
            scheduleFetch(
              expectedSymbol,
              expectedGeneration,
              manualMissFetch ? 0 : PE_CACHE_MISS_DELAY_MS,
            );
          }
          manualMissFetch = false;
          return;
        }
        scheduleFetch(
          expectedSymbol,
          expectedGeneration,
          manualMissFetch ? 0 : PE_CACHE_MISS_DELAY_MS,
        );
        manualMissFetch = false;
      };

      const resetForSymbol = (nextSymbol: string, manual = false) => {
        generation += 1;
        clearTimerIfNeeded();
        symbol = nextSymbol.trim().toUpperCase();
        record = null;
        cacheRead = false;
        fetchInProgress = false;
        manualMissFetch = manual;
        hoverIndex = null;
        clearVisuals();
      };

      const offSymbol = onIndicatorChartSymbolChange(chart, (nextSymbol) => {
        if (nextSymbol === symbol) return;
        // A ticker switch clears the old P/E immediately. Loading waits until the
        // new candle data event calls recompute(), preserving candle-first UX.
        resetForSymbol(nextSymbol, false);
      });
      const offCrosshair = chart.on('crosshair', (event) => {
        hoverIndex = event.index;
        render();
      });

      return {
        recompute() {
          const tracked = getIndicatorChartSymbol(chart);
          if (tracked && tracked !== symbol) resetForSymbol(tracked, false);
          render();
          if (chart.getIntervalSec() >= DAY_SECONDS && chart.getCandles().length > 0 && !record) {
            void loadForCurrentSymbol();
          }
        },
        remove() {
          removed = true;
          generation += 1;
          clearTimerIfNeeded();
          offCrosshair();
          offSymbol();
          chart.removeSeries(line);
          chart.removeSeries(markerSeries);
        },
      };
    },
  };
}

export default createPeIndicatorDef();
