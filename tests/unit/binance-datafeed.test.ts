import { describe, expect, it, vi } from 'vitest';
import type { Candle } from '../../src/core/types';
import {
  BinanceDatafeed,
  mergeBinanceCandles,
  missingBinanceHistoryRanges,
} from '../../examples/providers/binance';
import { BinanceHistoryCache } from '../../examples/providers/binance-cache';
import type { BrowserHistoryCacheApi } from '../../examples/providers/browser-history-cache';

const DAY = 24 * 60 * 60;
const RANGE_FROM = DAY * 19_000;

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function fakeBrowserCache(overrides: Partial<BrowserHistoryCacheApi> = {}): BrowserHistoryCacheApi {
  return {
    available: true,
    coverage: vi.fn(async () => []),
    readLatest: vi.fn(async () => []),
    readRange: vi.fn(async () => []),
    write: vi.fn(async () => undefined),
    markCoverage: vi.fn(async () => undefined),
    clearSource: vi.fn(async () => undefined),
    ...overrides,
  };
}

function candle(time: number, close = 10): Candle {
  return {
    time,
    open: close - 0.5,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100,
  };
}

function klineRow(time: number, close = 10): unknown[] {
  return [
    time * 1000,
    String(close - 0.5),
    String(close + 1),
    String(close - 1),
    String(close),
    '100',
  ];
}

function historyFetch(rows: unknown[][]): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(rows), { status: 200 })) as unknown as typeof fetch;
}

async function settlesQuickly<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('operation did not settle quickly')), 250);
    }),
  ]);
}

describe('BinanceDatafeed helpers', () => {
  it('merges candles by timestamp and keeps the latest value', () => {
    const first: Candle[] = [
      { time: 60, open: 1, high: 2, low: 1, close: 2 },
      { time: 120, open: 2, high: 3, low: 2, close: 3 },
    ];
    const update: Candle[] = [
      { time: 120, open: 2, high: 4, low: 2, close: 4 },
      { time: 180, open: 4, high: 5, low: 4, close: 5 },
    ];
    expect(mergeBinanceCandles(first, update).map((item) => [item.time, item.close])).toEqual([
      [60, 2],
      [120, 4],
      [180, 5],
    ]);
  });

  it('finds leading, interior, and trailing cache gaps', () => {
    const cached: Candle[] = [120, 180, 300].map((time) => ({
      time,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
    }));
    expect(missingBinanceHistoryRanges(
      cached,
      { from: 60, to: 360 },
      60,
    )).toEqual([
      { from: 60, to: 60 },
      { from: 240, to: 240 },
      { from: 360, to: 360 },
    ]);
  });

  it('keeps Spot and USD-M names explicit', () => {
    expect(new BinanceDatafeed({ market: 'spot' }).name).toBe('Binance Spot');
    expect(new BinanceDatafeed({ market: 'usdm' }).name).toBe('Binance USD-M Futures');
  });

  it('filters USD-M symbol search to perpetual contracts', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      symbols: [
        { symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT', contractType: 'PERPETUAL' },
        { symbol: 'BTCUSDT_260925', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT', contractType: 'CURRENT_QUARTER' },
      ],
    }), { status: 200 })) as unknown as typeof fetch;
    const feed = new BinanceDatafeed({ market: 'usdm', fetchImpl });
    await expect(feed.searchSymbols('BTC')).resolves.toEqual([
      { symbol: 'BTCUSDT', name: 'BTC/USDT', exchange: 'BINANCE USD-M' },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://fapi.binance.com/fapi/v1/exchangeInfo',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

describe('BinanceDatafeed cache deadlines', () => {
  it('falls back to REST when a range cache read never settles', async () => {
    const shared = fakeBrowserCache({
      readRange: vi.fn(() => never<Candle[]>()),
    });
    const fetchImpl = historyFetch([
      klineRow(RANGE_FROM, 10),
      klineRow(RANGE_FROM + DAY, 11),
      klineRow(RANGE_FROM + 2 * DAY, 12),
    ]);
    const feed = new BinanceDatafeed({
      cache: new BinanceHistoryCache(shared),
      fetchImpl,
      cacheReadTimeoutMs: 5,
    });

    const result = await settlesQuickly(feed.getHistory(
      'BTCUSDT',
      '1d',
      3,
      { from: RANGE_FROM, to: RANGE_FROM + 2 * DAY },
    ));

    expect(result.map((item) => item.close)).toEqual([10, 11, 12]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to REST when the latest cache read never settles', async () => {
    const shared = fakeBrowserCache({
      readLatest: vi.fn(() => never<Candle[]>()),
    });
    const fetchImpl = historyFetch([
      klineRow(RANGE_FROM, 20),
      klineRow(RANGE_FROM + 31 * DAY, 21),
    ]);
    const feed = new BinanceDatafeed({
      cache: new BinanceHistoryCache(shared),
      fetchImpl,
      cacheReadTimeoutMs: 5,
    });

    const result = await settlesQuickly(feed.getHistory('BTCUSDT', '1M', 2));

    expect(result.map((item) => item.close)).toEqual([20, 21]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not wait for a stalled cache write after REST history is available', async () => {
    const shared = fakeBrowserCache({
      write: vi.fn(() => never<void>()),
    });
    const fetchImpl = historyFetch([
      klineRow(RANGE_FROM, 30),
      klineRow(RANGE_FROM + DAY, 31),
    ]);
    const feed = new BinanceDatafeed({
      cache: new BinanceHistoryCache(shared),
      fetchImpl,
      cacheReadTimeoutMs: 5,
    });

    const result = await settlesQuickly(feed.getHistory(
      'BTCUSDT',
      '1d',
      2,
      { from: RANGE_FROM, to: RANGE_FROM + DAY },
    ));

    expect(result.map((item) => item.close)).toEqual([30, 31]);
    expect(shared.write).toHaveBeenCalledTimes(1);
  });

  it('does not reread the same fixed-step range after filling its gaps', async () => {
    const readRange = vi.fn(async () => [] as Candle[]);
    const shared = fakeBrowserCache({ readRange });
    const feed = new BinanceDatafeed({
      cache: new BinanceHistoryCache(shared),
      fetchImpl: historyFetch([
        klineRow(RANGE_FROM, 40),
        klineRow(RANGE_FROM + DAY, 41),
      ]),
      cacheReadTimeoutMs: 5,
    });

    const result = await feed.getHistory(
      'BTCUSDT',
      '1d',
      2,
      { from: RANGE_FROM, to: RANGE_FROM + DAY },
    );

    expect(result.map((item) => item.close)).toEqual([40, 41]);
    expect(readRange).toHaveBeenCalledTimes(1);
  });

  it('keeps a complete fast cache hit off the network', async () => {
    const cached = [
      candle(RANGE_FROM, 50),
      candle(RANGE_FROM + DAY, 51),
      candle(RANGE_FROM + 2 * DAY, 52),
    ];
    const shared = fakeBrowserCache({
      readRange: vi.fn(async () => cached),
    });
    const fetchImpl = historyFetch([]);
    const feed = new BinanceDatafeed({
      cache: new BinanceHistoryCache(shared),
      fetchImpl,
      cacheReadTimeoutMs: 5,
    });

    const result = await feed.getHistory(
      'BTCUSDT',
      '1d',
      3,
      { from: RANGE_FROM, to: RANGE_FROM + 2 * DAY },
    );

    expect(result).toEqual(cached);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
