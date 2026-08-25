import type { L2Chart } from '../../core/chart';
import { Series, type MinMax, type RenderContext } from '../../core/series';
import {
  getIndicatorChartSymbol,
  installIndicatorRuntimeContextTracking,
  onIndicatorChartSymbolChange,
} from '../runtime-context';
import type { IndicatorDef } from '../registry';
import {
  PeQuarterlyRepository,
  peQuarterlyRepository,
  type PeQuarterlyRecord,
} from './pe-client';
import { isPeEligibleVietnamEquitySymbol } from './pe-eligibility';
import { computeQuarterPePresentation, type PeMarker } from './pe-model';

const DAY_SECONDS = 24 * 60 * 60;
const QUARTER_MARKER_COLOR = '#f4b740';

installIndicatorRuntimeContextTracking();

function formatPe(value: number | null): string {
  return value !== null && Number.isFinite(value) ? value.toFixed(2) : '—';
}

class PeQuarterSeries extends Series {
  private markers: PeMarker[] = [];
  private hoverIndex: number | null = null;

  constructor() {
    super();
    this.title = 'P/E quý';
    this.legendColor = QUARTER_MARKER_COLOR;
  }

  setState(markers: readonly PeMarker[], hoverIndex: number | null, latestReportedPe: number | null): void {
    this.markers = [...markers];
    this.hoverIndex = hoverIndex;
    this.legendText = formatPe(latestReportedPe);
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

  valueAt(index: number): number | null {
    return this.markers.find((marker) => marker.index === index)?.value ?? null;
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

    const hoverMarker = this.hoverIndex === null
      ? null
      : this.markers.find((marker) => marker.index === this.hoverIndex) ?? null;
    if (hoverMarker) {
      const x = ts.xForIndex(hoverMarker.index);
      const y = ps.yFor(hoverMarker.value);
      if (x >= 0 && x <= paneWidth && y >= 0 && y <= paneHeight) {
        const text = `P/E ${formatPe(hoverMarker.value)} · ${hoverMarker.period}`;
        ctx.font = '600 11px Manrope, -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textBaseline = 'middle';
        const width = Math.ceil(ctx.measureText(text).width) + 12;
        const height = 20;
        const left = x + width + 12 <= paneWidth ? x + 8 : Math.max(4, x - width - 8);
        const top = Math.max(4, Math.min(paneHeight - height - 4, y - height / 2));
        ctx.fillStyle = theme.axisBg;
        ctx.strokeStyle = QUARTER_MARKER_COLOR;
        ctx.beginPath();
        ctx.roundRect(left, top, width, height, 4);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = QUARTER_MARKER_COLOR;
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
  repository?: Pick<PeQuarterlyRepository, 'get'>;
}

export function createPeIndicatorDef(runtime: PeIndicatorRuntime = {}): IndicatorDef {
  const repository = runtime.repository ?? peQuarterlyRepository;

  return {
    id: 'pe',
    name: 'P/E',
    category: 'custom',
    order: 10,
    create(chart: L2Chart) {
      const pane = chart.addPane(1);
      const series = new PeQuarterSeries();
      series.indicatorId = 'pe';
      pane.series.push(series);
      chart.invalidate();

      let record: PeQuarterlyRecord | null = null;
      let symbol = getIndicatorChartSymbol(chart);
      let generation = 0;
      let hoverIndex: number | null = null;
      let loadedSymbol = '';
      let loadingSymbol = '';
      let removed = false;
      let computedMarkers: PeMarker[] = [];
      let latestReportedPe: number | null = null;

      const supportedSymbol = () => isPeEligibleVietnamEquitySymbol(symbol);

      const updatePresentation = () => {
        series.setState(computedMarkers, hoverIndex, latestReportedPe);
        chart.invalidate();
      };

      const recomputeData = () => {
        const candles = chart.getCandles();
        if (!supportedSymbol() || chart.getIntervalSec() < DAY_SECONDS || candles.length === 0 || !record) {
          computedMarkers = [];
          latestReportedPe = null;
        } else {
          const presentation = computeQuarterPePresentation(
            candles,
            record.quarters,
            chart.getIntervalSec(),
          );
          computedMarkers = presentation.markers;
          latestReportedPe = presentation.latestReportedPe;
        }
        updatePresentation();
      };

      const loadCurrentSymbol = async () => {
        const expectedSymbol = symbol;
        const expectedGeneration = generation;
        if (
          removed
          || !isPeEligibleVietnamEquitySymbol(expectedSymbol)
          || chart.getIntervalSec() < DAY_SECONDS
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
            console.warn(`[P/E:SQLite] ${expectedSymbol}:`, error);
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
        hoverIndex = null;
        recomputeData();
      };

      const offSymbol = onIndicatorChartSymbolChange(chart, (nextSymbol) => {
        if (nextSymbol === symbol) return;
        resetForSymbol(nextSymbol);
      });
      const offCrosshair = chart.on('crosshair', (event) => {
        hoverIndex = event.index;
        updatePresentation();
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
          offCrosshair();
          offSymbol();
          chart.removeSeries(series);
        },
      };
    },
  };
}

export default createPeIndicatorDef();
