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
import { isPeEligibleVietnamEquitySymbol } from './pe-eligibility';
import { PeValuationRepository } from './pe-valuation-client';
import type { PeValuationRecord } from './pe-valuation-cache';
import {
  computeFiinQuantPeLine,
  computeQuarterPePresentation,
  peValuationRangeForCandles,
  type PeMarker,
} from './pe-model';

export const PE_CACHE_MISS_DELAY_MS = 30_000;
export const PE_CACHE_REFRESH_SECONDS = 24 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;
const QUARTER_MARKER_COLOR = '#f4b740';
const VALUATION_TAIL_REFRESH_SECONDS = 14 * DAY_SECONDS;

installIndicatorRuntimeContextTracking();

export function peCacheMissDelay(manualEnable: boolean): number {
  return manualEnable ? 0 : PE_CACHE_MISS_DELAY_MS;
}

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
  /** Legacy alias kept for tests/extensions that injected the Vnstock repository in V1. */
  repository?: PeFundamentalsRepository;
  quarterRepository?: PeFundamentalsRepository;
  valuationRepository?: PeValuationRepository;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export function createPeIndicatorDef(runtime: PeIndicatorRuntime = {}): IndicatorDef {
  const quarterRepository = runtime.quarterRepository ?? runtime.repository ?? new PeFundamentalsRepository();
  const valuationRepository = runtime.valuationRepository ?? new PeValuationRepository();
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

      let quarterRecord: PeFundamentalsRecord | null = null;
      let valuationRecord: PeValuationRecord | null = null;
      let symbol = getIndicatorChartSymbol(chart);
      let generation = 0;
      let hoverIndex: number | null = null;
      let quarterCacheRead = false;
      let valuationCacheRead = false;
      let quarterFetchInProgress = false;
      let valuationFetchInProgress = false;
      let quarterFetchTimer: ReturnType<typeof setTimeout> | null = null;
      let valuationFetchTimer: ReturnType<typeof setTimeout> | null = null;
      let pendingValuationRange: { from: number; to: number; force: boolean } | null = null;
      let manualQuarterMissFetch = chart.getCandles().length > 0 && isPeEligibleVietnamEquitySymbol(symbol);
      let manualValuationMissFetch = manualQuarterMissFetch;
      let removed = false;
      let computedValues: LinePoint[] = [];
      let computedMarkers: PeMarker[] = [];
      let computedLatestReportedPe: number | null = null;

      const supportedSymbol = () => isPeEligibleVietnamEquitySymbol(symbol);

      const clearQuarterTimer = () => {
        if (quarterFetchTimer !== null) {
          clearTimer(quarterFetchTimer);
          quarterFetchTimer = null;
        }
      };
      const clearValuationTimer = () => {
        if (valuationFetchTimer !== null) {
          clearTimer(valuationFetchTimer);
          valuationFetchTimer = null;
        }
      };

      const updateHoverPresentation = () => {
        line.legendText = hoverIndex === null
          ? formatPe(computedLatestReportedPe)
          : formatPe(computedValues[hoverIndex] ?? null);
        markerSeries.setState(computedMarkers, computedValues, hoverIndex, line.color);
        chart.invalidate();
      };

      const recomputeData = () => {
        const candles = chart.getCandles();
        if (!supportedSymbol() || chart.getIntervalSec() < DAY_SECONDS || candles.length === 0) {
          computedValues = new Array<LinePoint>(candles.length).fill(null);
          computedMarkers = [];
          computedLatestReportedPe = null;
        } else {
          computedValues = valuationRecord
            ? computeFiinQuantPeLine(candles, valuationRecord.points, chart.getIntervalSec())
            : new Array<LinePoint>(candles.length).fill(null);
          const quarterPresentation = quarterRecord
            ? computeQuarterPePresentation(candles, quarterRecord.quarters, chart.getIntervalSec())
            : { markers: [], latestReportedPe: null };
          computedMarkers = quarterPresentation.markers;
          computedLatestReportedPe = quarterPresentation.latestReportedPe;
        }
        line.setData(computedValues);
        updateHoverPresentation();
      };

      const fetchQuarterFresh = async (expectedSymbol: string, expectedGeneration: number) => {
        if (!isPeEligibleVietnamEquitySymbol(expectedSymbol) || quarterFetchInProgress || removed) return;
        quarterFetchInProgress = true;
        try {
          const fresh = await quarterRepository.fetchAndCache(expectedSymbol);
          if (removed || generation !== expectedGeneration || symbol !== expectedSymbol) return;
          quarterRecord = fresh;
          recomputeData();
        } catch (error) {
          console.warn(`[P/E:Vnstock] ${expectedSymbol}:`, error);
        } finally {
          if (generation === expectedGeneration && symbol === expectedSymbol) quarterFetchInProgress = false;
        }
      };

      const scheduleQuarterFetch = (expectedSymbol: string, expectedGeneration: number, delayMs: number) => {
        clearQuarterTimer();
        if (!isPeEligibleVietnamEquitySymbol(expectedSymbol)) return;
        if (delayMs <= 0) {
          void fetchQuarterFresh(expectedSymbol, expectedGeneration);
          return;
        }
        quarterFetchTimer = setTimer(() => {
          quarterFetchTimer = null;
          if (
            removed
            || generation !== expectedGeneration
            || symbol !== expectedSymbol
            || !isPeEligibleVietnamEquitySymbol(expectedSymbol)
          ) return;
          void fetchQuarterFresh(expectedSymbol, expectedGeneration);
        }, delayMs);
      };

      const fetchPendingValuation = async (expectedSymbol: string, expectedGeneration: number) => {
        if (
          !isPeEligibleVietnamEquitySymbol(expectedSymbol)
          || valuationFetchInProgress
          || removed
          || !pendingValuationRange
        ) return;
        const request = pendingValuationRange;
        pendingValuationRange = null;
        valuationFetchInProgress = true;
        try {
          const fresh = await valuationRepository.fetchAndCache(
            expectedSymbol,
            request.from,
            request.to,
            request.force,
          );
          if (removed || generation !== expectedGeneration || symbol !== expectedSymbol) return;
          valuationRecord = fresh;
          recomputeData();
        } catch (error) {
          console.warn(`[P/E:FiinQuant] ${expectedSymbol}:`, error);
        } finally {
          if (generation === expectedGeneration && symbol === expectedSymbol) {
            valuationFetchInProgress = false;
            if (pendingValuationRange) void fetchPendingValuation(expectedSymbol, expectedGeneration);
          }
        }
      };

      const scheduleValuationFetch = (
        expectedSymbol: string,
        expectedGeneration: number,
        range: { from: number; to: number },
        delayMs: number,
        force = false,
      ) => {
        if (!isPeEligibleVietnamEquitySymbol(expectedSymbol)) {
          pendingValuationRange = null;
          clearValuationTimer();
          return;
        }
        pendingValuationRange = pendingValuationRange
          ? {
              from: Math.min(pendingValuationRange.from, range.from),
              to: Math.max(pendingValuationRange.to, range.to),
              force: pendingValuationRange.force || force,
            }
          : { ...range, force };
        if (valuationFetchInProgress || valuationFetchTimer !== null) return;
        if (delayMs <= 0) {
          void fetchPendingValuation(expectedSymbol, expectedGeneration);
          return;
        }
        valuationFetchTimer = setTimer(() => {
          valuationFetchTimer = null;
          if (
            removed
            || generation !== expectedGeneration
            || symbol !== expectedSymbol
            || !isPeEligibleVietnamEquitySymbol(expectedSymbol)
          ) return;
          void fetchPendingValuation(expectedSymbol, expectedGeneration);
        }, delayMs);
      };

      const loadQuarterForCurrentSymbol = async () => {
        const expectedSymbol = symbol;
        const expectedGeneration = generation;
        if (!isPeEligibleVietnamEquitySymbol(expectedSymbol) || quarterCacheRead || removed) return;
        quarterCacheRead = true;
        const cached = await quarterRepository.getCached(expectedSymbol).catch(() => null);
        if (removed || generation !== expectedGeneration || symbol !== expectedSymbol) return;
        if (cached) {
          quarterRecord = cached;
          recomputeData();
          const age = Math.floor(Date.now() / 1000) - cached.fetchedAt;
          if (age > PE_CACHE_REFRESH_SECONDS) {
            scheduleQuarterFetch(expectedSymbol, expectedGeneration, peCacheMissDelay(manualQuarterMissFetch));
          }
          manualQuarterMissFetch = false;
          return;
        }
        scheduleQuarterFetch(expectedSymbol, expectedGeneration, peCacheMissDelay(manualQuarterMissFetch));
        manualQuarterMissFetch = false;
      };

      const loadValuationForCurrentSymbol = async () => {
        const candles = chart.getCandles();
        const range = peValuationRangeForCandles(candles, chart.getIntervalSec());
        const expectedSymbol = symbol;
        const expectedGeneration = generation;
        if (!isPeEligibleVietnamEquitySymbol(expectedSymbol) || !range || removed) return;

        const firstCacheRead = !valuationCacheRead;
        if (firstCacheRead) {
          valuationCacheRead = true;
          const cached = await valuationRepository.getCached(expectedSymbol).catch(() => null);
          if (removed || generation !== expectedGeneration || symbol !== expectedSymbol) return;
          valuationRecord = cached;
          if (cached) recomputeData();
        }

        const missing = valuationRepository.missingRanges(valuationRecord, range.from, range.to);
        if (missing.length > 0) {
          const missingRange = {
            from: Math.min(...missing.map((item) => item.from)),
            to: Math.max(...missing.map((item) => item.to)),
          };
          const delay = firstCacheRead ? peCacheMissDelay(manualValuationMissFetch) : 0;
          manualValuationMissFetch = false;
          scheduleValuationFetch(expectedSymbol, expectedGeneration, missingRange, delay);
          return;
        }

        const now = Math.floor(Date.now() / 1000);
        const age = valuationRecord ? now - valuationRecord.fetchedAt : 0;
        const includesCurrentTail = range.to >= now - 7 * DAY_SECONDS;
        if (valuationRecord && includesCurrentTail && age > PE_CACHE_REFRESH_SECONDS) {
          const tail = { from: Math.max(range.from, range.to - VALUATION_TAIL_REFRESH_SECONDS), to: range.to };
          const delay = firstCacheRead ? peCacheMissDelay(manualValuationMissFetch) : 0;
          manualValuationMissFetch = false;
          scheduleValuationFetch(expectedSymbol, expectedGeneration, tail, delay, true);
        } else if (firstCacheRead) {
          manualValuationMissFetch = false;
        }
      };

      const resetForSymbol = (nextSymbol: string, manual = false) => {
        generation += 1;
        clearQuarterTimer();
        clearValuationTimer();
        symbol = nextSymbol.trim().toUpperCase();
        quarterRecord = null;
        valuationRecord = null;
        quarterCacheRead = false;
        valuationCacheRead = false;
        quarterFetchInProgress = false;
        valuationFetchInProgress = false;
        pendingValuationRange = null;
        const eligible = isPeEligibleVietnamEquitySymbol(symbol);
        manualQuarterMissFetch = manual && eligible;
        manualValuationMissFetch = manual && eligible;
        hoverIndex = null;
        recomputeData();
      };

      const offSymbol = onIndicatorChartSymbolChange(chart, (nextSymbol) => {
        if (nextSymbol === symbol) return;
        // Ticker changes clear old P/E immediately. Unsupported instruments stop
        // here before either Vnstock or FiinQuant cache/network work can start.
        resetForSymbol(nextSymbol, false);
      });
      const offCrosshair = chart.on('crosshair', (event) => {
        hoverIndex = event.index;
        updateHoverPresentation();
      });

      return {
        recompute() {
          const tracked = getIndicatorChartSymbol(chart);
          if (tracked && tracked !== symbol) resetForSymbol(tracked, false);
          recomputeData();
          if (
            supportedSymbol()
            && chart.getIntervalSec() >= DAY_SECONDS
            && chart.getCandles().length > 0
          ) {
            void loadQuarterForCurrentSymbol();
            void loadValuationForCurrentSymbol();
          }
        },
        remove() {
          removed = true;
          generation += 1;
          clearQuarterTimer();
          clearValuationTimer();
          pendingValuationRange = null;
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