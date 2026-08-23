import type { L2Chart } from '../../core/chart';
import {
  emitIndicatorRuntimeParamPatch,
  getIndicatorChartProvider,
  getIndicatorChartSymbol,
  installIndicatorRuntimeContextTracking,
  onIndicatorChartProviderChange,
  onIndicatorChartSymbolChange,
} from '../runtime-context';
import type { IndicatorDef, Params } from '../registry';
import {
  InstitutionalFlowRepository,
  institutionalFlowRepository,
} from './institutional-flow-client';
import {
  alignInstitutionalFlowToCandles,
  institutionalFlowRangeForCandles,
  isInstitutionalFlowVietnamEquitySymbol,
  type InstitutionalFlowMonth,
} from './institutional-flow-model';
import { InstitutionalFlowSeries } from './institutional-flow-series';

const DAY_SECONDS = 24 * 60 * 60;
const MONTH_INTERVAL_MIN_SECONDS = 27 * DAY_SECONDS;
const MONTH_INTERVAL_MAX_SECONDS = 32 * DAY_SECONDS;

const STYLE_KEYS = {
  lineStyle: '__lineStyle',
  lineWidth: '__lineWidth',
  opacity: '__opacity',
  color1: '__color1',
  color2: '__color2',
  color3: '__color3',
} as const;

installIndicatorRuntimeContextTracking();

function numberParam(params: Params, key: string, fallback: number): number {
  const value = Number(params[key]);
  return Number.isFinite(value) ? value : fallback;
}

function colorParam(params: Params, key: string, fallback: string): string {
  const value = params[key];
  return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value : fallback;
}

function isMonthlyChart(chart: L2Chart): boolean {
  const seconds = chart.getIntervalSec();
  return seconds >= MONTH_INTERVAL_MIN_SECONDS && seconds <= MONTH_INTERVAL_MAX_SECONDS;
}

export function isInstitutionalFlowProviderActive(chart: L2Chart): boolean {
  return getIndicatorChartProvider(chart) === 'vnstock';
}

export function isInstitutionalFlowEligible(chart: L2Chart, symbol: string): boolean {
  return isInstitutionalFlowProviderActive(chart)
    && isMonthlyChart(chart)
    && isInstitutionalFlowVietnamEquitySymbol(symbol);
}

export interface InstitutionalFlowIndicatorRuntime {
  repository?: InstitutionalFlowRepository;
}

export function createInstitutionalFlowIndicatorDef(
  runtime: InstitutionalFlowIndicatorRuntime = {},
): IndicatorDef {
  const repository = runtime.repository ?? institutionalFlowRepository;
  return {
    id: 'institutional-flow',
    name: 'Dòng tiền tổ chức',
    category: 'custom',
    order: 11,
    params: [
      {
        key: 'showValues',
        label: 'Hiển thị giá trị (tỷ: bỏ đơn vị · triệu: tr)',
        type: 'select',
        default: 'off',
        options: [
          { value: 'off', label: 'Tắt' },
          { value: 'on', label: 'Bật' },
        ],
      },
      {
        key: 'labelFontSize',
        label: 'Cỡ chữ giá trị',
        type: 'float',
        default: 8,
        min: 6,
        max: 14,
        step: 0.5,
      },
      {
        key: 'labelOpacity',
        label: 'Opacity giá trị (%)',
        type: 'int',
        default: 70,
        min: 10,
        max: 100,
        step: 5,
      },
      {
        key: 'zeroPosition',
        label: 'Vị trí mốc 0 (%) · có thể kéo trực tiếp',
        type: 'int',
        default: 50,
        min: 20,
        max: 80,
        step: 1,
      },
      {
        key: 'height',
        label: 'Chiều cao',
        type: 'float',
        default: 0.28,
        min: 0.16,
        max: 0.48,
        step: 0.01,
      },
    ],
    create(chart, params) {
      const zeroLineStyleValue = String(params[STYLE_KEYS.lineStyle] ?? 'solid');
      const zeroLineStyle = zeroLineStyleValue === 'dashed' || zeroLineStyleValue === 'dotted'
        ? zeroLineStyleValue
        : 'solid';
      const series = new InstitutionalFlowSeries({
        foreignColor: colorParam(params, STYLE_KEYS.color1, '#3b82f6'),
        proprietaryColor: colorParam(params, STYLE_KEYS.color2, '#f59e0b'),
        zeroLineColor: colorParam(params, STYLE_KEYS.color3, chart.theme.border),
        zeroLineWidth: numberParam(params, STYLE_KEYS.lineWidth, 1),
        zeroLineStyle,
        zeroPosition: numberParam(params, 'zeroPosition', 50) / 100,
        barOpacity: Math.min(1, Math.max(0, numberParam(params, STYLE_KEYS.opacity, 100) / 100)),
        heightFraction: numberParam(params, 'height', 0.28),
        showValues: params.showValues === 'on',
        labelFontSize: numberParam(params, 'labelFontSize', 8),
        labelOpacity: Math.min(1, Math.max(0, numberParam(params, 'labelOpacity', 70) / 100)),
      });
      series.indicatorId = 'institutional-flow';
      const pane = chart.panes[0];
      pane.series.push(series);
      chart.invalidate();

      let symbol = getIndicatorChartSymbol(chart);
      let generation = 0;
      let removed = false;
      let months: InstitutionalFlowMonth[] = [];
      let loadedKey = '';
      let inFlightKey = '';
      let wantedKey = '';
      let zeroDragPointerId: number | null = null;

      const paneY = (event: PointerEvent): number => {
        const rect = pane.el.getBoundingClientRect();
        return Math.min(pane.height, Math.max(0, event.clientY - rect.top));
      };
      const legendHeight = (): number => pane.legendEl?.getBoundingClientRect().height ?? 0;
      const zeroHitTolerance = (event: PointerEvent): number => event.pointerType === 'touch' ? 14 : 8;

      const onZeroPointerDown = (event: PointerEvent) => {
        if (event.button !== 0 || !isInstitutionalFlowEligible(chart, symbol)) return;
        if (!series.hitZeroLine(
          paneY(event),
          pane.height,
          legendHeight(),
          zeroHitTolerance(event),
        )) return;

        event.preventDefault();
        event.stopPropagation();
        zeroDragPointerId = event.pointerId;
        try {
          pane.el.setPointerCapture(event.pointerId);
        } catch {
          // Synthetic browser tests may not own a native pointer capture.
        }
        pane.el.style.cursor = 'ns-resize';
      };

      const onZeroPointerMove = (event: PointerEvent) => {
        if (zeroDragPointerId === event.pointerId) {
          event.preventDefault();
          event.stopPropagation();
          series.moveZeroLineTo(paneY(event), pane.height, legendHeight());
          chart.invalidate();
          return;
        }
        pane.el.style.cursor = series.hitZeroLine(
          paneY(event),
          pane.height,
          legendHeight(),
          zeroHitTolerance(event),
        ) ? 'ns-resize' : '';
      };

      const finishZeroDrag = (event: PointerEvent) => {
        if (zeroDragPointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        series.moveZeroLineTo(paneY(event), pane.height, legendHeight());
        zeroDragPointerId = null;
        pane.el.style.cursor = '';
        emitIndicatorRuntimeParamPatch(chart, 'institutional-flow', {
          zeroPosition: Math.round(series.getZeroPosition() * 100),
        });
        chart.invalidate();
      };

      const onZeroPointerLeave = () => {
        if (zeroDragPointerId === null) pane.el.style.cursor = '';
      };

      pane.el.addEventListener('pointerdown', onZeroPointerDown);
      pane.el.addEventListener('pointermove', onZeroPointerMove);
      pane.el.addEventListener('pointerup', finishZeroDrag);
      pane.el.addEventListener('pointercancel', finishZeroDrag);
      pane.el.addEventListener('pointerleave', onZeroPointerLeave);

      const clearPresentation = () => {
        series.setData([]);
        chart.invalidate();
      };

      const resetLoadedState = () => {
        generation += 1;
        months = [];
        loadedKey = '';
        inFlightKey = '';
        wantedKey = '';
        clearPresentation();
      };

      const renderLoadedData = () => {
        if (!isInstitutionalFlowEligible(chart, symbol)) {
          clearPresentation();
          return;
        }
        series.setData(alignInstitutionalFlowToCandles(chart.getCandles(), months));
        chart.invalidate();
      };

      const loadCurrentRange = async () => {
        const candles = chart.getCandles();
        if (!isInstitutionalFlowEligible(chart, symbol) || candles.length === 0) {
          wantedKey = '';
          inFlightKey = '';
          clearPresentation();
          return;
        }
        const range = institutionalFlowRangeForCandles(candles);
        if (!range) return;
        const requestKey = `${symbol}:${range.from}:${range.to}`;
        wantedKey = requestKey;
        if (loadedKey === requestKey) {
          renderLoadedData();
          return;
        }
        if (inFlightKey === requestKey) return;

        inFlightKey = requestKey;
        const expectedGeneration = generation;
        try {
          const fresh = await repository.get(symbol, range.from, range.to);
          if (
            removed
            || generation !== expectedGeneration
            || wantedKey !== requestKey
            || !isInstitutionalFlowEligible(chart, symbol)
          ) return;
          months = fresh;
          loadedKey = requestKey;
          renderLoadedData();
        } catch (error) {
          if (!removed && generation === expectedGeneration && wantedKey === requestKey) {
            console.warn(`[InstitutionalFlow] ${symbol}:`, error);
            clearPresentation();
          }
        } finally {
          if (inFlightKey === requestKey) inFlightKey = '';
        }
      };

      const resetForSymbol = (nextSymbol: string) => {
        symbol = nextSymbol.trim().toUpperCase();
        resetLoadedState();
      };

      const offSymbol = onIndicatorChartSymbolChange(chart, (nextSymbol) => {
        if (nextSymbol === symbol) return;
        // The next candle-data recompute will request the new symbol against the
        // new candle range. Clearing now prevents stale bars during the switch.
        resetForSymbol(nextSymbol);
      });
      const offProvider = onIndicatorChartProviderChange(chart, () => {
        resetLoadedState();
        void loadCurrentRange();
      });

      return {
        recompute() {
          const tracked = getIndicatorChartSymbol(chart);
          if (tracked && tracked !== symbol) resetForSymbol(tracked);
          if (!isInstitutionalFlowEligible(chart, symbol)) {
            resetLoadedState();
            return;
          }
          renderLoadedData();
          void loadCurrentRange();
        },
        remove() {
          removed = true;
          generation += 1;
          zeroDragPointerId = null;
          pane.el.style.cursor = '';
          pane.el.removeEventListener('pointerdown', onZeroPointerDown);
          pane.el.removeEventListener('pointermove', onZeroPointerMove);
          pane.el.removeEventListener('pointerup', finishZeroDrag);
          pane.el.removeEventListener('pointercancel', finishZeroDrag);
          pane.el.removeEventListener('pointerleave', onZeroPointerLeave);
          offSymbol();
          offProvider();
          chart.removeSeries(series);
        },
      };
    },
  };
}

export default createInstitutionalFlowIndicatorDef();
