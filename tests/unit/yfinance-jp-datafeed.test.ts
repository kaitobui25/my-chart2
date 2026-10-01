import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Candle } from '../../src/core/types';
import type { HistoryRange } from '../../src/datafeed';
import {
  normalizeYFinanceJapanSymbol,
  YFINANCE_JP_SUPPORTED_INTERVALS,
  YFINANCE_JP_HISTORY_SOURCE,
  YFinanceJapanDatafeed,
} from '../../examples/providers/yfinance-jp';
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

describe('YFinanceJapanDatafeed', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('normalizes numeric and alphanumeric Tokyo symbols to the yfinance .T suffix', () => {
    expect(normalizeYFinanceJapanSymbol('7203')).toBe('7203.T');
    expect(normalizeYFinanceJapanSymbol(' 130a.t ')).toBe('130A.T');
    expect(normalizeYFinanceJapanSymbol('9a76')).toBe('9A76.T');
    expect(normalizeYFinanceJapanSymbol('9984.T')).toBe('9984.T');
    expect(normalizeYFinanceJapanSymbol('AAPL')).toBe('');
    expect(normalizeYFinanceJapanSymbol('12A3')).toBe('');
  });

  it('exports exactly the intervals implemented by the yfinance Japan sidecar', () => {
    expect(YFINANCE_JP_SUPPORTED_INTERVALS).toEqual(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M']);
  });

  it('searches through the sidecar and keeps only valid Tokyo symbols', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      symbols: [
        { symbol: '130a.t', name: 'Example Japan', exchange: 'JPX' },
        { symbol: 'AAPL', name: 'Apple', exchange: 'NMS' },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
    const feed = new YFinanceJapanDatafeed('/yfinance-jp-api', { cache: memoryCache(), fetchImpl });

    await expect(feed.searchSymbols('130A', 10)).resolves.toEqual([
      { symbol: '130A.T', name: 'Example Japan', exchange: 'JPX' },
    ]);
    const url = new URL(String(vi.mocked(fetchImpl).mock.calls[0][0]));
    expect(url.pathname).toBe('/yfinance-jp-api/symbols');
    expect(url.searchParams.get('q')).toBe('130A');
    expect(url.searchParams.get('limit')).toBe('10');
  });

  it.each(['30m', '1w', '1M'] as const)('passes chart interval %s unchanged to the sidecar', async (interval) => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ candles: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
    const feed = new YFinanceJapanDatafeed('/yfinance-jp-api', { cache: memoryCache(), fetchImpl });

    await feed.getHistory('7203', interval, 100);

    const url = new URL(String(vi.mocked(fetchImpl).mock.calls[0][0]));
    expect(url.pathname).toBe('/yfinance-jp-api/history');
    expect(url.searchParams.get('symbol')).toBe('7203.T');
    expect(url.searchParams.get('interval')).toBe(interval);
  });

  it('forwards the full requested intraday range and only marks returned coverage', async () => {
    const requested = { from: 1_700_000_000, to: 1_700_086_400 };
    const remote: Candle[] = [
      { time: 1_700_040_000, open: 100, high: 102, low: 99, close: 101, volume: 1_000 },
      { time: 1_700_040_300, open: 101, high: 103, low: 100, close: 102, volume: 900 },
    ];
    const cache = memoryCache();
    const markCoverage = vi.spyOn(cache, 'markCoverage');
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ candles: remote }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
    const feed = new YFinanceJapanDatafeed('/yfinance-jp-api', { cache, fetchImpl });

    await feed.getHistory('130A.T', '5m', 500, requested);

    const url = new URL(String(vi.mocked(fetchImpl).mock.calls[0][0]));
    expect(url.searchParams.get('from')).toBe(String(requested.from));
    expect(url.searchParams.get('to')).toBe(String(requested.to));
    expect(markCoverage).toHaveBeenCalledWith(
      YFINANCE_JP_HISTORY_SOURCE,
      '130A.T',
      '5m',
      { from: remote[0].time, to: remote[1].time + 300 },
    );
    expect(markCoverage).not.toHaveBeenCalledWith(
      YFINANCE_JP_HISTORY_SOURCE,
      '130A.T',
      '5m',
      requested,
    );
  });

  it('reuses confirmed cached coverage instead of refetching the same range', async () => {
    const cache = memoryCache();
    const candles: Candle[] = [
      { time: 1_700_000_000, open: 100, high: 102, low: 99, close: 101 },
      { time: 1_700_000_300, open: 101, high: 103, low: 100, close: 102 },
    ];
    await cache.write(YFINANCE_JP_HISTORY_SOURCE, '7203.T', '5m', candles);
    await cache.markCoverage(YFINANCE_JP_HISTORY_SOURCE, '7203.T', '5m', {
      from: candles[0].time,
      to: candles[1].time + 300,
    });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const feed = new YFinanceJapanDatafeed('/yfinance-jp-api', { cache, fetchImpl });

    await expect(feed.getHistory('7203', '5m', 100, {
      from: candles[0].time,
      to: candles[1].time + 300,
    })).resolves.toEqual(candles);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('polls active chart subscriptions every 60 seconds, batched by interval, without a bulk subscription API', async () => {
    vi.useFakeTimers();
    const candle = { time: 1_754_860_800, open: 100, high: 105, low: 99, close: 103, volume: 1_000 };
    const secondCandle = { ...candle, close: 104 };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      candles: { '7203.T': candle, '6758.T': secondCandle },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
    const feed = new YFinanceJapanDatafeed('/yfinance-jp-api', { cache: memoryCache(), fetchImpl });
    const onCandle = vi.fn();
    const onSecondCandle = vi.fn();

    expect('subscribeMany' in feed).toBe(false);
    const unsubscribe = feed.subscribe('7203', '1d', onCandle);
    const unsubscribeSecond = feed.subscribe('6758', '1d', onSecondCandle);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = new URL(String(vi.mocked(fetchImpl).mock.calls[0][0]));
    expect(url.pathname).toBe('/yfinance-jp-api/latest');
    expect(url.searchParams.get('symbols')).toBe('7203.T,6758.T');
    expect(url.searchParams.get('interval')).toBe('1d');
    expect(onCandle).toHaveBeenCalledWith(candle);
    expect(onSecondCandle).toHaveBeenCalledWith(secondCandle);

    unsubscribe();
    unsubscribeSecond();
    feed.dispose();
  });
});
