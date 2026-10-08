import { describe, expect, it, vi } from 'vitest';

import type { Candle, Datafeed, HistoryRange } from '../../src/index';
import {
  buildPrimaryContext,
  createAssistantBridge,
  extractRequestedTimeframes,
} from '../../examples/workstation/assistant/context';

function makeCandles(count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => ({
    time: 1_700_000_000 + index * 300,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.5 + index,
    volume: 1_000 + index,
  }));
}

function makeSource(data = makeCandles(100)) {
  return {
    symbol: '7203.T',
    timeframe: '5m',
    mode: 'candles',
    replay: { phase: 'idle' },
    historyRange: null,
    candles: data,
    visibleIndices: { from: 40, to: 50 },
    indicators: [],
    quote: { last: 150, bid: 149, ask: 151, time: data[50].time },
  };
}

describe('assistant chart context', () => {
  it('keeps primary candles near the visible chart area', () => {
    const data = makeCandles(100);
    const context = buildPrimaryContext(makeSource(data));

    expect(context.version).toBe(2);
    expect(context.candleCount).toBe(35);
    expect(context.candles[0].time).toBe(data[28].time);
    expect(context.candles[context.candles.length - 1]?.time).toBe(data[62].time);
    expect(context.visibleRange).toEqual({ from: data[40].time, to: data[50].time });
  });

  it('detects only timeframes explicitly named by the user', () => {
    expect(extractRequestedTimeframes('Xem khung 1M', '1d')).toEqual(['1M']);
    expect(extractRequestedTimeframes('So sánh 5 phút với 15m và daily', '5m'))
      .toEqual(['15m', '1d']);
    expect(extractRequestedTimeframes('mày xem được khung 30 của chart này ko', '1d'))
      .toEqual(['30m']);
    expect(extractRequestedTimeframes('xem khung ngày và khung 15', '5m'))
      .toEqual(['1d', '15m']);
    expect(extractRequestedTimeframes('xem 30 cây nến gần nhất', '1d')).toEqual([]);
    expect(extractRequestedTimeframes('Giá đang làm gì?', '5m')).toEqual([]);
  });

  it('anchors requested timeframes to the current visible time', async () => {
    const primary = makeSource();
    const requested = makeCandles(20);
    const getHistory = vi.fn(async (
      _symbol: string,
      _interval: string,
      _limit?: number,
      _range?: HistoryRange,
    ) => requested);
    const feed: Datafeed = {
      name: 'test',
      getHistory,
      subscribe: () => () => undefined,
    };
    const bridge = createAssistantBridge({
      getPrimarySource: () => primary,
      getDatafeed: () => feed,
    });

    const context = await bridge.resolveContext('mày xem được khung 30 của chart này ko');
    const anchor = primary.candles[50].time;

    expect(getHistory).toHaveBeenCalledTimes(1);
    for (const call of getHistory.mock.calls) expect(call[3]?.to).toBe(anchor);
    expect(context?.additionalTimeframes.map((item) => item.timeframe)).toEqual(['30m']);
  });

  it('reads the newest candles from a wide requested range even when the cache returns from the range start', async () => {
    const primary = makeSource();
    const anchor = primary.candles[50].time;
    const daily = Array.from({ length: 400 }, (_, index): Candle => ({
      time: anchor - (399 - index) * 86400,
      open: 1_000 + index,
      high: 1_010 + index,
      low: 990 + index,
      close: 1_005 + index,
      volume: 10_000 + index,
    }));
    const getHistory = vi.fn(async (
      _symbol: string,
      _interval: string,
      limit = 500,
      range?: HistoryRange,
    ) => {
      const selected = range
        ? daily.filter((candle) => candle.time >= range.from && candle.time <= range.to)
        : daily;
      return selected.slice(0, limit);
    });
    const feed: Datafeed = {
      name: 'test',
      getHistory,
      subscribe: () => () => undefined,
    };
    const bridge = createAssistantBridge({
      getPrimarySource: () => primary,
      getDatafeed: () => feed,
    });

    const context = await bridge.resolveContext('doc them khung ngay');
    const extra = context?.additionalTimeframes[0];

    expect(getHistory).toHaveBeenCalledTimes(1);
    expect(getHistory.mock.calls[0][2]).toBeGreaterThan(160);
    expect(extra?.timeframe).toBe('1d');
    expect(extra?.candleCount).toBe(160);
    expect(extra?.candles[extra.candles.length - 1]?.time).toBe(anchor);
  });

  it('falls back to latest candles when ranged loading fails, without leaking candles after the anchor', async () => {
    const primary = makeSource();
    const anchor = primary.candles[50].time;
    const older = makeCandles(20).map((candle, index) => ({ ...candle, time: anchor - (20 - index) * 900 }));
    const future = { ...older[older.length - 1], time: anchor + 900 };
    const getHistory = vi.fn(async (
      _symbol: string,
      _interval: string,
      _limit?: number,
      range?: HistoryRange,
    ) => {
      if (range) throw new Error('range failed');
      return [...older, future];
    });
    const feed: Datafeed = {
      name: 'test',
      getHistory,
      subscribe: () => () => undefined,
    };
    const bridge = createAssistantBridge({
      getPrimarySource: () => primary,
      getDatafeed: () => feed,
    });

    const context = await bridge.resolveContext('xem được nến 15 phút ko');
    const extra = context?.additionalTimeframes[0];

    expect(getHistory).toHaveBeenCalledTimes(2);
    expect(extra?.timeframe).toBe('15m');
    expect(extra?.error).toBeUndefined();
    expect(extra?.candleCount).toBe(20);
    expect(extra?.candles.every((candle) => candle.time <= anchor)).toBe(true);
  });
});
