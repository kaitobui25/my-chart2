import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Candle, L2Chart } from '../../src/library';
import { ExcelReplayController, type ExcelReplayDependencies } from '../../examples/excel-content-addin/excel-replay-controller';
import { createExcelAssistantBridge } from '../../examples/excel-content-addin/assistant-context';
import type { IndicatorController } from '../../examples/excel-content-addin/indicator-controller';
import type { JapanMarketController } from '../../examples/excel-content-addin/japan-market-controller';

const sample: Candle[] = [100, 160, 220, 280].map((time, i) => ({
  time, open: 10 + i, high: 12 + i, low: 9 + i, close: 11 + i, volume: 100 + i,
}));

function setup(source: 'sheet' | 'market' = 'sheet', nowSeconds = 100_000, preserveReplayZoom = false) {
  let visible = sample.map((bar) => ({ ...bar }));
  let selecting = false;
  const timeScale = {
    barSpacing: 12,
    rightIndex: 2.5,
    scroll: vi.fn((deltaPx: number) => {
      timeScale.rightIndex -= deltaPx / timeScale.barSpacing;
    }),
  };
  const chart: ExcelReplayDependencies['chart'] = {
    getCandles: () => visible,
    setData: vi.fn((data: Candle[]) => { visible = data; }),
    updateCandle: vi.fn((candle: Candle) => {
      const last = visible[visible.length - 1];
      if (last?.time === candle.time) visible[visible.length - 1] = candle;
      else if (!last || candle.time > last.time) visible.push(candle);
    }),
    setReplaySelectionMode: vi.fn((value: boolean) => { selecting = value; }),
    scrollToLatest: vi.fn(),
    fitContent: vi.fn(),
    invalidate: vi.fn(),
    timeScale,
  };
  const market = { pause: vi.fn(), resume: vi.fn() };
  const onChange = vi.fn();
  const onBegin = vi.fn();
  const replay = new ExcelReplayController({
    chart, market, getSource: () => source, getMarketTimeframe: () => '1m',
    getPreserveReplayZoom: () => preserveReplayZoom,
    nowSeconds: () => nowSeconds, onChange, onBegin,
  });
  return { replay, chart, market, onChange, onBegin, getVisible: () => visible, isSelecting: () => selecting };
}

afterEach(() => vi.useRealTimers());

describe('Excel Replay', () => {
  it('reveals exactly one new bar per step and restores complete Sheet source', () => {
    const h = setup();
    expect(h.replay.begin()).toBe(true);
    expect(h.isSelecting()).toBe(true);
    expect(h.replay.selectStart(1)).toBe(true);
    expect(h.getVisible().map((bar) => bar.time)).toEqual([100, 160]);
    expect(h.replay.snapshot()).toMatchObject({ phase: 'paused', cursor: 1, total: 4 });
    h.replay.step();
    expect(h.getVisible().map((bar) => bar.time)).toEqual([100, 160, 220]);
    h.replay.step();
    expect(h.getVisible().map((bar) => bar.time)).toEqual([100, 160, 220, 280]);
    h.replay.step();
    expect(h.replay.snapshot()).toMatchObject({ phase: 'paused', cursor: 3 });
    expect(h.chart.updateCandle).toHaveBeenCalledTimes(2);
    h.replay.stop();
    expect(h.getVisible()).toEqual(sample);
    expect(h.market.pause).toHaveBeenCalledOnce();
    expect(h.market.resume).not.toHaveBeenCalled();
    expect(h.replay.snapshot()).toMatchObject({ phase: 'idle', total: 0, cursor: -1 });
    h.replay.dispose();
  });

  it('rejects invalid selections and cancels without losing data', () => {
    const h = setup();
    expect(h.replay.begin()).toBe(true);
    expect(h.replay.selectStart(3)).toBe(false);
    expect(h.replay.snapshot().error).toMatch(/Chọn/);
    expect(h.isSelecting()).toBe(true);
    h.replay.stop();
    expect(h.getVisible()).toEqual(sample);
    expect(h.isSelecting()).toBe(false);
  });

  it('excludes the active live market candle, then restores the original and resumes', () => {
    const h = setup('market', 290); // [240,300) is still open; the previous bar has closed.
    expect(h.replay.begin()).toBe(true);
    expect(h.replay.snapshot().total).toBe(3);
    expect(h.replay.selectStart(1)).toBe(true);
    h.replay.step();
    expect(h.getVisible().map((bar) => bar.time)).toEqual([100, 160, 220]);
    h.replay.stop();
    expect(h.getVisible()).toEqual(sample);
    expect(h.market.pause).toHaveBeenCalledOnce();
    expect(h.market.resume).toHaveBeenCalledOnce();
  });

  it('restores chart without resubscribing when switching from Replay to Sheet', () => {
    const h = setup('market');
    h.replay.begin();
    h.replay.selectStart(0);
    h.replay.stop(false);
    expect(h.getVisible()).toEqual(sample);
    expect(h.market.resume).not.toHaveBeenCalled();
  });

  it('keeps the zoom and selected viewport throughout Replay when option is enabled', () => {
    const h = setup('sheet', 100_000, true);
    h.replay.begin();
    // User zooms and pans after pressing Replay but before clicking the chosen bar.
    h.chart.timeScale.barSpacing = 23;
    h.chart.timeScale.rightIndex = 1.25;
    h.replay.selectStart(1);
    expect(h.chart.scrollToLatest).not.toHaveBeenCalled();
    expect(h.chart.timeScale).toMatchObject({ barSpacing: 23, rightIndex: 1.25 });

    h.replay.step();
    expect(h.chart.scrollToLatest).not.toHaveBeenCalled();
    // Replay can still be panned/zoomed manually, but Stop restores the selection-time view.
    h.chart.timeScale.barSpacing = 9;
    h.chart.timeScale.rightIndex = 3;
    h.replay.stop();
    expect(h.chart.fitContent).not.toHaveBeenCalled();
    expect(h.chart.timeScale).toMatchObject({ barSpacing: 23, rightIndex: 1.25 });
    expect(h.getVisible()).toEqual(sample);
  });

  it('uses existing auto-scroll and fitContent behavior by default', () => {
    const h = setup();
    h.replay.begin();
    h.replay.selectStart(1);
    h.replay.step();
    expect(h.chart.scrollToLatest).toHaveBeenCalledTimes(2);
    h.replay.stop();
    expect(h.chart.fitContent).toHaveBeenCalledOnce();
  });

  it('retains the current viewport when cancelling selection with zoom preservation enabled', () => {
    const h = setup('sheet', 100_000, true);
    h.replay.begin();
    h.chart.timeScale.barSpacing = 18;
    h.chart.timeScale.rightIndex = 2;
    h.replay.stop();
    expect(h.chart.fitContent).not.toHaveBeenCalled();
    expect(h.chart.timeScale).toMatchObject({ barSpacing: 18, rightIndex: 2 });
  });

  it('plays with one timer, pauses on hidden, and clears timer on dispose', () => {
    vi.useFakeTimers();
    const h = setup();
    h.replay.begin();
    h.replay.selectStart(0);
    h.replay.cycleSpeed(); // 2x
    h.replay.togglePlayback();
    vi.advanceTimersByTime(500);
    expect(h.replay.snapshot()).toMatchObject({ phase: 'playing', cursor: 1, speed: 2 });
    h.replay.pause();
    vi.advanceTimersByTime(2000);
    expect(h.replay.snapshot().cursor).toBe(1);
    h.replay.togglePlayback();
    vi.advanceTimersByTime(1000);
    expect(h.replay.snapshot()).toMatchObject({ phase: 'paused', cursor: 3 });
    h.replay.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not leak market history through AI when Replay is active', async () => {
    const h = setup('market');
    const getHistory = vi.fn(async () => sample);
    const bridge = createExcelAssistantBridge({
      chart: { ...h.chart, timeScale: { visibleRange: () => null } } as L2Chart,
      indicators: { contextSnapshot: () => [] } as unknown as IndicatorController,
      market: { getDatafeed: () => ({ getHistory }) } as unknown as JapanMarketController,
      getSource: () => 'market',
      getSymbol: () => '7203.T',
      getTimeframe: () => '1m',
      getReplaySnapshot: () => h.replay.snapshot(),
    });
    const previous = bridge.getContext()!;
    h.replay.begin();
    h.replay.selectStart(1);
    const context = bridge.getContext()!;
    expect(context.candleCount).toBe(2);
    expect(context.replay).toMatchObject({ phase: 'paused', cursor: 1, total: 4 });
    const resolved = await bridge.resolveContext('phân tích nến khung 1h');
    expect(resolved?.additionalTimeframes[0]).toMatchObject({ candleCount: 0, timeframe: '1h' });
    expect(getHistory).not.toHaveBeenCalled();
    const request = { tool: 'get_candles' as const, timeframe: 'current', id: '', limit: 10, paramsJson: '' };
    expect((await bridge.queryData!(request, previous)).ok).toBe(false);
    const currentResult = await bridge.queryData!(request, context);
    expect(currentResult.ok).toBe(true);
    expect((currentResult.data as { candles: Candle[] }).candles).toHaveLength(2);
    h.replay.step();
    expect((await bridge.queryData!(request, context)).ok).toBe(false);
    h.replay.stop();
  });
});
