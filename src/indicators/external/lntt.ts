import type { L2Chart } from '../../core/chart';
import {
  getIndicatorChartSymbol,
  installIndicatorRuntimeContextTracking,
  onIndicatorChartSymbolChange,
} from '../runtime-context';
import type { IndicatorDef, Params } from '../registry';
import {
  LnttQuarterlyRepository,
  lnttQuarterlyRepository,
  type LnttQuarterlyRecord,
} from './lntt-client';
import { isPeEligibleVietnamEquitySymbol } from './pe-eligibility';
import { computeLnttPoints, type LnttValueMode } from './lntt-model';
import { LnttSeries } from './lntt-series';

installIndicatorRuntimeContextTracking();

function valueMode(params: Params): LnttValueMode {
  return params.valueMode === 'vnd' ? 'vnd' : 'percent';
}

export interface LnttIndicatorRuntime {
  repository?: Pick<LnttQuarterlyRepository, 'get'>;
}

export function createLnttIndicatorDef(runtime: LnttIndicatorRuntime = {}): IndicatorDef {
  const repository = runtime.repository ?? lnttQuarterlyRepository;
  return {
    id: 'lntt',
    name: 'LNTT',
    category: 'custom',
    order: 13,
    params: [
      {
        key: 'valueMode',
        label: 'Hiển thị',
        type: 'select',
        default: 'percent',
        options: [
          { value: 'percent', label: '% YoY' },
          { value: 'vnd', label: 'Tỷ VND' },
        ],
      },
    ],
    create(chart: L2Chart, params: Params) {
      const mode = valueMode(params);
      const pane = chart.addPane(1);
      pane.priceScale.setPrecision(1);
      const series = new LnttSeries(mode);
      series.indicatorId = 'lntt';
      pane.series.push(series);
      chart.invalidate();

      let record: LnttQuarterlyRecord | null = null;
      let symbol = getIndicatorChartSymbol(chart);
      let generation = 0;
      let loadedSymbol = '';
      let loadingSymbol = '';
      let removed = false;

      const supportedSymbol = () => isPeEligibleVietnamEquitySymbol(symbol);

      const recomputeData = () => {
        const candles = chart.getCandles();
        const points = record && supportedSymbol()
          ? computeLnttPoints(candles, record.quarters, chart.getIntervalSec(), mode)
          : [];
        series.setData(points);
        chart.invalidate();
      };

      const loadCurrentSymbol = async () => {
        const expectedSymbol = symbol;
        const expectedGeneration = generation;
        if (
          removed
          || !isPeEligibleVietnamEquitySymbol(expectedSymbol)
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
            console.warn(`[LNTT:SQLite] ${expectedSymbol}:`, error);
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
          offSymbol();
          chart.removeSeries(series);
        },
      };
    },
  };
}

export default createLnttIndicatorDef();
