import { describe, expect, it, vi } from 'vitest';
import type { Candle } from '../../src/core/types';
import type { HistoryRange } from '../../src/datafeed';
import { FiinQuantDatafeed } from '../../examples/providers/fiinquant';
import {
  FIINQUANT_ADJUSTED_HISTORY_SOURCE,
  mergeHistoryCoverage,
  type BrowserHistoryCacheApi,
} from '../../examples/providers/browser-history-cache';

function cacheKey(source: string, symbol: string, interval: string): string {
  return `${source}\u0000${symbol.toUpperCase()}\u0000${interval}`;
}

function keyedMemoryCache(seed: Array<{
  symbol: string;
  interval: string;
  candles: Candle[];
}> = []): BrowserHistoryCacheApi {
  const series = new Map<string, Candle[]>();
  const coverage = new Map<string, HistoryRange[]>();
  for (const item of seed) {
    series.set(
      cacheKey(FIINQUANT_ADJUSTED_HISTORY_SOURCE, item.symbol, item.interval),
      item.candles.map((candle) => ({ ...candle })),
    );
  }

  return {
    available: true,
    async coverage(source, symbol, interval) {
      return (coverage.get(cacheKey(source, symbol, interval)) ?? []).map((range) => ({ ...range }));
    },
    async readLatest(source, symbol, interval, limit) {
      return (series.get(cacheKey(source, symbol, interval)) ?? [])
        .slice(-limit)
        .map((candle) => ({ ...candle }));
    },
    async readRange(source, symbol, interval, from, to, limit) {
      const selected = (series.get(cacheKey(source, symbol, interval)) ?? [])
        .filter((candle) => candle.time >= from && candle.time <= to);
      return selected.slice(0, limit ?? selected.length).map((candle) => ({ ...candle }));
    },
    async write(source, symbol, interval, incoming) {
      const key = cacheKey(source, symbol, interval);
      const byTime = new Map((series.get(key) ?? []).map((candle) => [candle.time, candle]));
      for (const candle of incoming) byTime.set(candle.time, { ...candle });
      series.set(key, [...byTime.values()].sort((left, right) => left.time - right.time));
    },
    async markCoverage(source, symbol, interval, range) {
      const key = cacheKey(source, symbol, interval);
      coverage.set(key, mergeHistoryCoverage([...(coverage.get(key) ?? []), range]));
    },
    async clearSource(source) {
      for (const key of [...series.keys()]) {
        if (key.startsWith(`${source}\u0000`)) series.delete(key);
      }
      for (const key of [...coverage.keys()]) {
        if (key.startsWith(`${source}\u0000`)) coverage.delete(key);
      }
    },
  };
}

function dailyCandles(count: number, start = Date.UTC(2024, 0, 1) / 1000): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const open = 100 + index;
    return {
      time: start + index * 86_400,
      open,
      high: open + 2,
      low: open - 1,
      close: open + 1,
      volume: 1_000 + index,
    };
  });
}

async function resolvesQuickly<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('history call stayed blocked on the remote provider')), 100);
    }),
  ]);
}

function pendingFetch(input: RequestInfo | URL): Promise<Response> {
  void input;
  return new Promise<Response>(() => undefined);
}

describe('FiinQuant fast timeframe history', () => {
  it('returns cached daily history immediately while remote refresh runs in background', async () => {
    const cached = dailyCandles(40);
    const cache = keyedMemoryCache([{ symbol: 'PGI', interval: '1d', candles: cached }]);
    const fetchMock = vi.fn(pendingFetch);
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const feed = new FiinQuantDatafeed('/fiinquant-api', '', { cache, fetchImpl });

    const result = await resolvesQuickly(feed.getHistory('PGI', '1d', 500));

    expect(result).toEqual(cached);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get('interval')).toBe('1d');
    expect(url.searchParams.get('limit')).toBe('100');
  });

  it('uses cached daily candles to build weekly history without waiting for FiinQuant', async () => {
    const daily = dailyCandles(220);
    const cache = keyedMemoryCache([{ symbol: 'PGI', interval: '1d', candles: daily }]);
    const fetchMock = vi.fn(pendingFetch);
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const feed = new FiinQuantDatafeed('/fiinquant-api', '', { cache, fetchImpl });

    const weekly = await resolvesQuickly(feed.getHistory('PGI', '1w', 20));

    expect(weekly).toHaveLength(20);
    expect(weekly.every((candle, index) => index === 0 || candle.time > weekly[index - 1].time)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get('interval')).toBe('1d');
    expect(url.searchParams.get('limit')).toBe('20');
  });

  it('fetches calendar cold history through the daily source so the master daily cache is preserved', async () => {
    const remoteDaily = dailyCandles(174);
    const cache = keyedMemoryCache();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('interval')).toBe('1d');
      expect(url.searchParams.get('limit')).toBe('174');
      return new Response(JSON.stringify({ candles: remoteDaily }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const feed = new FiinQuantDatafeed('/fiinquant-api', '', { cache, fetchImpl });

    const weekly = await feed.getHistory('PGI', '1w', 20);
    const cachedDaily = await cache.readLatest(
      FIINQUANT_ADJUSTED_HISTORY_SOURCE,
      'PGI',
      '1d',
      500,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(weekly).toHaveLength(20);
    expect(cachedDaily).toEqual(remoteDaily);
  });

  it('refreshes a full cached monthly history with a small daily request instead of another heavy monthly fetch', async () => {
    const monthly = dailyCandles(100, Date.UTC(2018, 0, 1) / 1000).map((candle, index) => ({
      ...candle,
      time: Date.UTC(2018, index, 1) / 1000,
    }));
    const cache = keyedMemoryCache([{ symbol: 'SSI', interval: '1M', candles: monthly }]);
    const fetchMock = vi.fn(pendingFetch);
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const feed = new FiinQuantDatafeed('/fiinquant-api', '', { cache, fetchImpl });

    const result = await resolvesQuickly(feed.getHistory('SSI', '1M', 100));

    expect(result).toEqual(monthly);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get('interval')).toBe('1d');
    expect(url.searchParams.get('limit')).toBe('100');
  });
});
