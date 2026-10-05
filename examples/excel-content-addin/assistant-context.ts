import type { Datafeed, L2Chart } from '../../src/library';
import { createAssistantBridge } from '../assistant/context';
import type { AssistantBridge } from '../assistant/types';
import type { IndicatorController } from './indicator-controller';
import type { JapanMarketController } from './japan-market-controller';

export type ExcelAssistantSource = 'market' | 'sheet';

export interface ExcelAssistantContextDependencies {
  chart: L2Chart;
  indicators: IndicatorController;
  market: JapanMarketController;
  getSource(): ExcelAssistantSource;
  getSymbol(): string;
  getTimeframe(): string;
}

export function createExcelAssistantBridge(
  dependencies: ExcelAssistantContextDependencies,
): AssistantBridge {
  return createAssistantBridge({
    getPrimarySource() {
      const candles = dependencies.chart.getCandles();
      if (candles.length === 0) return null;
      const first = candles[0];
      const last = candles[candles.length - 1];
      const source = dependencies.getSource();
      return {
        symbol: source === 'market' ? dependencies.getSymbol() : 'Excel range',
        timeframe: source === 'market' ? dependencies.getTimeframe() : 'sheet',
        mode: 'candles',
        replay: { phase: 'idle', source },
        historyRange: { from: first.time, to: last.time },
        candles,
        visibleIndices: dependencies.chart.timeScale.visibleRange(),
        indicators: dependencies.indicators.contextSnapshot(),
        quote: {
          last: last.close,
          bid: null,
          ask: null,
          time: last.time,
        },
      };
    },
    getDatafeed(): Datafeed | null {
      return dependencies.getSource() === 'market' ? dependencies.market.getDatafeed() : null;
    },
  });
}
