import {
  L2Chart,
  lightTheme,
  type Candle,
  type ManualPriceViewport,
  type PriceSeriesMode,
  type SerializedDrawing,
} from '../../src';

const container = document.getElementById('chart');
if (!container) throw new Error('Missing chart fixture container');

const candles: Candle[] = Array.from({ length: 120 }, (_, index) => {
  const close = 100 + Math.sin(index / 7) * 6 + index * 0.08;
  return {
    time: 1_700_000_000 + index * 60,
    open: close - 0.8,
    high: close + 1.5,
    low: close - 1.5,
    close,
    volume: 1_000 + index * 10,
  };
});

const chart = new L2Chart(container, { theme: lightTheme });
chart.setWatermark('SMOKE');
chart.setData(candles);

interface ChartTestState {
  barSpacing: number;
  rightIndex: number;
  candleCount: number;
  drawingCount: number;
  chartRootCount: number;
  mode: PriceSeriesMode;
}

interface ChartTestApi {
  state(): ChartTestState;
  priceViewport(): ManualPriceViewport | null;
  refreshData(): void;
  prependHistory(): void;
  fitPriceScale(): void;
  updateLatest(close: number): void;
  appendCandle(): void;
  setMode(mode: PriceSeriesMode): void;
  lastCloses(): { raw: number | null; displayed: number | null };
  setDrawing(): void;
  serializeDrawings(): string;
  restoreDrawings(payload: string): void;
  deleteDrawing(): boolean;
  undoDrawing(): boolean;
  redoDrawing(): boolean;
  destroy(): void;
}

declare global {
  interface Window {
    chartTest: ChartTestApi;
  }
}

const drawing: SerializedDrawing = {
  id: 1,
  tool: 'trendline',
  paneIndex: 0,
  start: { index: 20, price: 99 },
  end: { index: 70, price: 110 },
  style: { color: '#0b6bcb', width: 2 },
};

window.chartTest = {
  state: () => ({
    barSpacing: chart.timeScale.barSpacing,
    rightIndex: chart.timeScale.rightIndex,
    candleCount: chart.getCandles().length,
    drawingCount: chart.getDrawings().length,
    chartRootCount: container.childElementCount,
    mode: chart.mainSeries.mode,
  }),
  priceViewport: () => chart.panes[0]?.priceScale.captureManualViewport() ?? null,
  refreshData: () => {
    chart.setData(chart.getCandles().map((candle) => ({ ...candle })));
  },
  prependHistory: () => {
    const first = chart.getCandles()[0];
    if (!first) return;
    chart.prependData(Array.from({ length: 5 }, (_, offset) => {
      const time = first.time - (5 - offset) * 60;
      const close = first.open - (5 - offset) * 0.2;
      return {
        time,
        open: close - 0.4,
        high: close + 0.8,
        low: close - 0.8,
        close,
        volume: 900 + offset,
      };
    }));
  },
  fitPriceScale: () => chart.fitPriceScale(),
  updateLatest: (close) => {
    const current = chart.getCandles();
    const latest = current[current.length - 1];
    if (!latest) return;
    chart.updateCandle({
      ...latest,
      high: Math.max(latest.high, close),
      low: Math.min(latest.low, close),
      close,
    });
  },
  appendCandle: () => {
    const current = chart.getCandles();
    const latest = current[current.length - 1];
    if (!latest) return;
    chart.updateCandle({
      time: latest.time + 60,
      open: latest.close,
      high: latest.close + 2,
      low: latest.close - 1,
      close: latest.close + 1,
      volume: 2_500,
    });
  },
  setMode: (mode) => chart.setMode(mode),
  lastCloses: () => {
    const current = chart.getCandles();
    const index = current.length - 1;
    return {
      raw: current[index]?.close ?? null,
      displayed: chart.mainSeries.valueAt(index),
    };
  },
  setDrawing: () => chart.setDrawings([drawing]),
  serializeDrawings: () => JSON.stringify(chart.getDrawings()),
  restoreDrawings: (payload) => {
    chart.setDrawings(JSON.parse(payload) as SerializedDrawing[]);
  },
  deleteDrawing: () => chart.deleteDrawing(drawing.id),
  undoDrawing: () => chart.undoDrawing(),
  redoDrawing: () => chart.redoDrawing(),
  destroy: () => chart.destroy(),
};
