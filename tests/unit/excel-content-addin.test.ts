import { afterEach, describe, expect, it, vi } from 'vitest';

import { isExcelHost, readSelectedRange, waitForOfficeReady } from '../../examples/excel-content-addin/excel-host';
import { EXCEL_ASSISTANT_CONFIG } from '../../examples/excel-content-addin/assistant-config';
import {
  JapanMarketController,
  type JapanMarketDatafeed,
} from '../../examples/excel-content-addin/japan-market-controller';
import {
  historyRangeForTimeframe,
  JAPAN_MARKET_CONFIG,
  JAPAN_TIMEFRAMES,
} from '../../examples/excel-content-addin/japan-market-config';
import { builtinIndicators } from '../../src/indicators/builtin/all';
import { IndicatorController } from '../../examples/excel-content-addin/indicator-controller';
import {
  candlesFromRange,
  inferCandleIntervalSeconds,
  parseExcelTime,
  parseNumber,
} from '../../examples/excel-content-addin/ohlc-range';
import type { Candle, L2Chart } from '../../src/library';

describe('Excel OHLC range parser', () => {
  it('skips headers, sorts rows, keeps optional volume and lets the last duplicate win', () => {
    const values = [
      ['Date', 'Open', 'High', 'Low', 'Close', 'Volume'],
      [45_000, 10, 13, 9, 12, 100],
      [44_999, 8, 11, 7, 10, 90],
      [45_000, 12, 14, 11, 13, 110],
    ];
    const snapshot = { values, text: values.map((row) => row.map(String)) };

    const candles = candlesFromRange(snapshot);

    expect(candles).toHaveLength(2);
    expect(candles[0].open).toBe(8);
    expect(candles[1]).toMatchObject({ open: 12, high: 14, low: 11, close: 13, volume: 110 });
  });

  it('rejects rows with impossible OHLC bounds', () => {
    const values = [[45_000, 10, 9, 8, 11]];
    expect(candlesFromRange({ values, text: [['', '', '', '', '']] })).toEqual([]);
  });

  it('supports a custom column map', () => {
    const values = [[10, 13, 9, 12, 45_000]];
    const candles = candlesFromRange(
      { values, text: [values[0].map(String)] },
      { columns: { open: 0, high: 1, low: 2, close: 3, time: 4 } },
    );
    expect(candles).toHaveLength(1);
    expect(candles[0]).toMatchObject({ open: 10, high: 13, low: 9, close: 12 });
  });

  it('parses Excel serials, Unix seconds, Unix milliseconds and ISO text', () => {
    expect(parseExcelTime(25_569)).toBe(0);
    expect(parseExcelTime(2_958_465)).toBe(
      Math.floor((2_958_465 - 25_569) * 86_400),
    );
    expect(parseExcelTime(2_958_466)).toBe(2_958_466);
    expect(parseExcelTime(1_000_000_000)).toBe(1_000_000_000);
    expect(parseExcelTime(1_700_000_000)).toBe(1_700_000_000);
    expect(parseExcelTime(1_000_000_000_000)).toBe(1_000_000_000);
    expect(parseExcelTime(1_700_000_000_000)).toBe(1_700_000_000);
    expect(parseExcelTime('2026-10-05T00:00:00Z')).toBe(Date.UTC(2026, 9, 5) / 1_000);
  });

  it('supports explicit numeric time formats for values that are ambiguous in auto mode', () => {
    expect(parseExcelTime(86_400, undefined, 'unix-seconds')).toBe(86_400);
    expect(parseExcelTime(86_400_000, undefined, 'unix-milliseconds')).toBe(86_400);
    expect(parseExcelTime(0, undefined, 'unix-seconds')).toBe(0);
  });

  it('accepts common decimal and thousands separators', () => {
    expect(parseNumber('1,234.5')).toBe(1234.5);
    expect(parseNumber('1.234,5')).toBe(1234.5);
    expect(parseNumber('12,5')).toBe(12.5);
    expect(parseNumber('1,234')).toBe(1234);
  });

  it('infers a stable sheet interval from positive candle deltas', () => {
    const candles = [0, 60, 120, 300].map((time) => ({
      time,
      open: 1,
      high: 2,
      low: 1,
      close: 2,
    }));
    expect(inferCandleIntervalSeconds(candles)).toBe(60);
    expect(inferCandleIntervalSeconds(candles.slice(0, 1), 300)).toBe(300);
  });
});

describe('Excel Japan market configuration', () => {
  it('defaults to a Tokyo equity and keeps every supported timeframe configurable in one place', () => {
    expect(JAPAN_MARKET_CONFIG.defaultSymbol).toBe('7203.T');
    expect(JAPAN_MARKET_CONFIG.defaultTimeframe).toBe('1d');
    expect(JAPAN_MARKET_CONFIG.historyLimit).toBeGreaterThan(500);
    expect(JAPAN_TIMEFRAMES.map((item) => item.value)).toEqual([
      '1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M',
    ]);
  });

  it('builds deterministic lookback ranges for larger history requests', () => {
    const now = 2_000_000_000;
    const daily = historyRangeForTimeframe('1d', now);
    const minute = historyRangeForTimeframe('1m', now);
    expect(daily.to).toBe(now);
    expect(daily.from).toBeLessThan(minute.from);
  });

  it('exposes only pure built-in OHLCV indicators to the Excel picker source', () => {
    expect(builtinIndicators.length).toBeGreaterThan(5);
    expect(new Set(builtinIndicators.map((item) => item.id)).size).toBe(builtinIndicators.length);
    expect(builtinIndicators.every((item) => item.category !== 'custom')).toBe(true);
  });

  it('persists indicator favorites and sorts them before non-favorites', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const chart = {
      on: vi.fn(() => () => undefined),
    } as unknown as L2Chart;
    const controller = new IndicatorController(chart, storage);
    const initialOptions = controller.options();
    const target = initialOptions[initialOptions.length - 1];
    expect(target).toBeDefined();

    controller.toggleFavorite(target!.id);

    expect(controller.options()[0]).toMatchObject({ id: target!.id, favorite: true });
    const restored = new IndicatorController(chart, storage);
    expect(restored.isFavorite(target!.id)).toBe(true);
    expect(restored.options()[0].id).toBe(target!.id);

    controller.dispose();
    restored.dispose();
  });
});

describe('Excel Japan market controller', () => {
  function candle(time = 1_700_000_000): Candle {
    return { time, open: 100, high: 102, low: 99, close: 101, volume: 1_000 };
  }

  function fakeChart(): L2Chart {
    return {
      setIntervalSec: vi.fn(),
      setData: vi.fn(),
      fitContent: vi.fn(),
      updateCandle: vi.fn(),
    } as unknown as L2Chart;
  }

  function fakeFeed(getHistory: JapanMarketDatafeed['getHistory']): JapanMarketDatafeed {
    return {
      name: 'Fake Japan feed',
      getHistory,
      subscribe: vi.fn(() => vi.fn()),
      searchSymbols: vi.fn(async () => []),
      dispose: vi.fn(),
    };
  }

  it('falls back to the provider-safe history request when an explicit range is empty', async () => {
    const getHistory = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([candle()]);
    const feed = fakeFeed(getHistory);
    const chart = fakeChart();
    const controller = new JapanMarketController(chart, feed);

    const result = await controller.load('7203', '1h');

    expect(result?.candles).toHaveLength(1);
    expect(getHistory).toHaveBeenCalledTimes(2);
    expect(getHistory.mock.calls[0][3]).toMatchObject({ from: expect.any(Number), to: expect.any(Number) });
    expect(getHistory.mock.calls[1][3]).toBeUndefined();
    expect(chart.setData).toHaveBeenCalledWith([candle()]);
    controller.dispose();
  });

  it('keeps the previous live subscription when a replacement market load fails', async () => {
    const unsubscribe = vi.fn();
    const getHistory = vi.fn()
      .mockResolvedValueOnce([candle()])
      .mockRejectedValueOnce(new Error('range failed'))
      .mockRejectedValueOnce(new Error('fallback failed'));
    const feed = fakeFeed(getHistory);
    feed.subscribe = vi.fn(() => unsubscribe);
    const controller = new JapanMarketController(fakeChart(), feed);

    await controller.load('7203', '1d');
    await expect(controller.load('6758', '1d')).rejects.toThrow('fallback failed');

    expect(unsubscribe).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toEqual({ symbol: '7203.T', timeframe: '1d' });
    controller.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

describe('Excel assistant configuration', () => {
  it('uses the same-origin assistant API and keeps conversation payloads bounded', () => {
    expect(EXCEL_ASSISTANT_CONFIG.apiBaseUrl).toBe('/assistant-api');
    expect(EXCEL_ASSISTANT_CONFIG.maxConversationMessages).toBeGreaterThan(0);
    expect(EXCEL_ASSISTANT_CONFIG.maxConversationMessages).toBeLessThanOrEqual(10);
    expect(EXCEL_ASSISTANT_CONFIG.defaultReasoningEffort).toBe('medium');
  });
});

describe('Excel host adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('classifies a normal browser as non-Excel', async () => {
    expect(await waitForOfficeReady()).toBeNull();
    expect(isExcelHost(null)).toBe(false);
  });

  it('uses Office.onReady host plus the Excel runtime', async () => {
    vi.stubGlobal('Office', {
      onReady(callback: (info: { host?: string }) => void) {
        callback({ host: 'Excel' });
      },
    });
    vi.stubGlobal('Excel', { run: vi.fn() });

    const info = await waitForOfficeReady();
    expect(isExcelHost(info)).toBe(true);
  });

  it('loads values and text from the selected range', async () => {
    const load = vi.fn();
    const sync = vi.fn(async () => undefined);
    const range = {
      values: [[45_000, 10, 12, 9, 11]],
      text: [['01/03/2023', '10', '12', '9', '11']],
      load,
    };
    vi.stubGlobal('Excel', {
      run: async (callback: (context: unknown) => Promise<unknown>) => callback({
        workbook: { getSelectedRange: () => range },
        sync,
      }),
    });

    const snapshot = await readSelectedRange();

    expect(load).toHaveBeenCalledWith('values,text');
    expect(sync).toHaveBeenCalledOnce();
    expect(snapshot).toEqual({ values: range.values, text: range.text });
  });
});
