import type { Datafeed, L2Chart } from '../../src/library';
import { createAssistantBridge } from '../assistant/context';
import type { AssistantBridge } from '../assistant/types';
import type { IndicatorController } from './indicator-controller';
import type { JapanMarketController } from './japan-market-controller';
import type { ExcelReplaySnapshot } from './excel-replay-controller';

export type ExcelAssistantSource = 'market' | 'sheet';

export interface ExcelAssistantContextDependencies {
  chart: L2Chart;
  indicators: IndicatorController;
  market: JapanMarketController;
  getSource(): ExcelAssistantSource;
  getSymbol(): string;
  getTimeframe(): string;
  getReplaySnapshot?(): ExcelReplaySnapshot | null;
}

export function createExcelAssistantBridge(
  dependencies: ExcelAssistantContextDependencies,
): AssistantBridge {
  const replay = () => dependencies.getReplaySnapshot?.() ?? null;
  const replayMarker = () => {
    const state = replay();
    return state ? `${state.phase}:${state.cursor}:${state.currentTime}:${state.source}` : 'idle';
  };
  const bridge = createAssistantBridge({
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
        replay: { ...(replay() ?? { phase: 'idle' }), source },
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
      return dependencies.getSource() === 'market' && (!replay() || replay()?.phase === 'idle')
        ? dependencies.market.getDatafeed() : null;
    },
  });
  return {
    getContext: bridge.getContext,
    async resolveContext(...args) {
      const before = replayMarker();
      const result = await bridge.resolveContext(...args);
      // Discard an older market lookup if the user began/advanced Replay while it loaded.
      return before === replayMarker() ? result : bridge.getContext();
    },
    async queryData(request, anchor) {
      const before = replayMarker();
      const current = bridge.getContext();
      if (!current || current.symbol !== anchor.symbol || current.timeframe !== anchor.timeframe
        || JSON.stringify(current.replay) !== JSON.stringify(anchor.replay)) {
        return { request, ok: false, error: 'Chart/Replay changed. Please request fresh data.' };
      }
      const result = await bridge.queryData(request, anchor);
      if (before !== replayMarker()) {
        return { request, ok: false, error: 'Replay changed while loading data. Please retry.' };
      }
      return result;
    },
  };
}
