import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Candle } from '../../src/core/types';
import type { HistoryRange } from '../../src/datafeed';
import { isVietnamTradingSession, VnstockDatafeed } from '../../examples/providers/vnstock';
import {
  mergeHistoryCoverage,
  type BrowserHistoryCacheApi,
} from '../../examples/providers/browser-history-cache';

function memoryCache(): BrowserHistoryCacheApi {
  let candles: Candle[] = [];
  let coverage: HistoryRange[] = [];
  return {
    available: true,
    async coverage() {
      return coverage.map((range) => ({ ...range }));
    },
    async readLatest(_source, _symbol, _interval, limit) {
      return candles.slice(-limit).map((candle) => ({ ...candle }));
    },
    async readRange(_source, _symbol, _interval, from, to, limit) {
      const selected = candles.filter((candle) => candle.time >= from && candle.time <= to);
      return selected.slice(0, limit ?? selected.length).map((candle) => ({ ...candle }));
    },
    async write(_source, _symbol, _interval, incoming) {
      const byTime = new Map(candles.map((candle) => [candle.time, candle]));
      for (const candle of incoming) byTime.set(candle.time, { ...candle });
      candles = [...byTime.values()].sort((left, right) => left.time - right.time);
    },
    async markCoverage(_source, _symbol, _interval, range) {
      coverage = mergeHistoryCoverage([...coverage, range]);
    },
    async clearSource() {
      candles = [];
      coverage = [];
    },
  };
}

describe('VnstockDatafeed', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses cached Vnstock history for an already covered Replay range', async () => {
    const day = 86_400;
    const candles: Candle[] = [
      { time: 1_754_524_800, open: 100, high: 103, low: 99, close: 102, volume: 1_000 },
      { time: 1_754_611_200, open: 102, high: 105, low: 101, close: 104, volume: 1_200 },
      { time: 1_754_697_600, open: 104, high: 106, low: 103, close: 105, volume: 900 },
    ];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.searchParams.has('from')) {
        return new Response(JSON.stringify({ message: 'unexpected historical backfill' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ candles }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const feed = new VnstockDatafeed('/vnstock-api', { cache: memoryCache(), fetchImpl });

    await expect(feed.getHistory('FPT', '1d', 500)).resolves.toEqual(candles);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await expect(feed.getHistory('FPT', '1d', 500, {
      from: candles[0].time,
      to: candles[candles.length - 1].time + day,
    })).resolves.toEqual(candles);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('normalizes provider-backed symbol search results', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      symbols: [{ symbol: ' fpt ', name: ' FPT Corp ', exchange: ' HOSE ' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
    const feed = new VnstockDatafeed('/vnstock-api', { cache: memoryCache(), fetchImpl });

    await expect(feed.searchSymbols('fpt')).resolves.toEqual([
      { symbol: 'FPT', name: 'FPT Corp', exchange: 'HOSE' },
    ]);
  });

  it('falls back to cached latest history when Vnstock refresh is temporarily offline', async () => {
    const cached: Candle[] = [
      { time: 1_754_697_600, open: 104, high: 106, low: 103, close: 105, volume: 900 },
    ];
    const cache = memoryCache();
    await cache.write('vnstock:ohlcv:v1', 'FPT', '1d', cached);
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const feed = new VnstockDatafeed('/vnstock-api', { cache, fetchImpl });

    await expect(feed.getHistory('FPT', '1d', 500)).resolves.toEqual(cached);
  });

  it('refreshes an open chart only after five minutes during a Vietnam trading session', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T03:00:00Z'));
    const candle = { time: 1_754_860_800, open: 100, high: 105, low: 99, close: 103, volume: 1_000 };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({
      candles: { FPT: candle },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const feed = new VnstockDatafeed('/vnstock-api', {
      cache: memoryCache(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const onCandle = vi.fn();

    const unsubscribe = feed.subscribe('FPT', '1d', onCandle);
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/latest?symbols=FPT&interval=1d');
    expect(onCandle).toHaveBeenCalledWith(expect.objectContaining({ close: candle.close }));

    unsubscribe();
    feed.dispose();
  });

  it('does not refresh an open chart outside Vietnam trading hours', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T10:00:00Z'));
    const fetchMock = vi.fn();
    const feed = new VnstockDatafeed('/vnstock-api', {
      cache: memoryCache(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    feed.subscribe('FPT', '1d', vi.fn());
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(fetchMock).not.toHaveBeenCalled();
    feed.dispose();
  });

  it('scans one watchlist ticker per minute and pauses five minutes between sweeps', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T03:00:00Z'));
    const candle = { time: 1_754_860_800, open: 100, high: 105, low: 99, close: 103, volume: 1_000 };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const symbol = url.searchParams.get('symbols') ?? '';
      return new Response(JSON.stringify({ candles: { [symbol]: candle } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const feed = new VnstockDatafeed('/vnstock-api', {
      cache: memoryCache(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    feed.subscribeMany(['HPG', 'SSI'], '1d', vi.fn());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(String(fetchMock.mock.calls[0][0])).toContain('symbols=HPG');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(String(fetchMock.mock.calls[1][0])).toContain('symbols=SSI');
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(String(fetchMock.mock.calls[2][0])).toContain('symbols=HPG');
    feed.dispose();
  });

  it('skips the open chart ticker while scanning the watchlist', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T03:00:00Z'));
    const candle = { time: 1_754_860_800, open: 100, high: 105, low: 99, close: 103, volume: 1_000 };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ candles: { SSI: candle } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const feed = new VnstockDatafeed('/vnstock-api', {
      cache: memoryCache(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    feed.subscribe('HPG', '1d', vi.fn());
    feed.subscribeMany(['HPG', 'SSI'], '1d', vi.fn());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('symbols=SSI');
    feed.dispose();
  });

  it('recognizes Vietnam weekday morning and afternoon sessions', () => {
    expect(isVietnamTradingSession(new Date('2026-08-11T02:00:00Z'))).toBe(true);
    expect(isVietnamTradingSession(new Date('2026-08-11T04:31:00Z'))).toBe(false);
    expect(isVietnamTradingSession(new Date('2026-08-11T06:00:00Z'))).toBe(true);
    expect(isVietnamTradingSession(new Date('2026-08-15T03:00:00Z'))).toBe(false);
  });
});
