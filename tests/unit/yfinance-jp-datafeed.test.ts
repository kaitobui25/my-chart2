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

function timestamp(value: string): number {
  return Math.floor(Date.parse(value) / 1_000);
}

describe('YFinanceJapanDatafeed', () => {
  it('pages backwards through cached history nearest the boundary without fetching', async () => {
    const cache = memoryCache();
    const start = timestamp('2026-08-17T09:00:00+09:00');
    const candles = Array.from({ length: 897 }, (_, index) => ({
      time: start + index * 900, open: 100, high: 102, low: 99, close: 101,
    }));
    await cache.write(YFINANCE_JP_HISTORY_SOURCE, '6758.T', '15m', candles);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const feed = new YFinanceJapanDatafeed('/yfinance-jp-api', { cache, fetchImpl });
    const first = await feed.getOlderHistory('6758.T', '15m', 200, { from: start, to: candles[397].time - 1 });
    expect(first).toEqual(candles.slice(197, 397));
    const second = await feed.getOlderHistory('6758.T', '15m', 200, { from: start, to: first[0].time - 1 });
    expect(second).toEqual(candles.slice(0, 197));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stops at Yahoo retention only after checking older local cache', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T18:00:00+09:00'));
    const cache = memoryCache();
    const old = { time: timestamp('2026-01-05T09:00:00+09:00'), open: 100, high: 102, low: 99, close: 101 };
    await cache.write(YFINANCE_JP_HISTORY_SOURCE, '6758.T', '15m', [old]);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const feed = new YFinanceJapanDatafeed('/yfinance-jp-api', { cache, fetchImpl });
    await expect(feed.getOlderHistory('6758.T', '15m', 500, { from: 0, to: old.time + 1 })).resolves.toEqual([old]);
    await expect(feed.getOlderHistory('6758.T', '15m', 500, { from: 0, to: old.time - 1 })).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a backwards page on network failure so it remains retryable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T18:00:00+09:00'));
    const fetchImpl = vi.fn(async () => { throw new Error('offline'); });
    const feed = new YFinanceJapanDatafeed('/yfinance-jp-api', { cache: memoryCache(), fetchImpl });
    await expect(feed.getOlderHistory('6758.T', '15m', 500, {
      from: timestamp('2026-09-01'), to: timestamp('2026-09-09'),
    })).rejects.toThrow('Cannot reach');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports the end when the remaining retention window contains only a closed weekend', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T18:00:00+09:00'));
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const feed = new YFinanceJapanDatafeed('/yfinance-jp-api', { cache: memoryCache(), fetchImpl });
    await expect(feed.getOlderHistory('6758.T', '15m', 500, {
      from: 0, to: timestamp('2026-08-17T08:59:59+09:00'),
    })).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['overnight', '6758.T', '2026-09-14T15:30:00+09:00', '2026-09-15T09:00:00+09:00', false],
    ['lunch', '6758.T', '2026-09-14T11:30:00+09:00', '2026-09-14T12:30:00+09:00', false],
    ['weekend', '6758.T', '2026-09-18T15:30:00+09:00', '2026-09-21T09:00:00+09:00', false],
    ['in-session', '6758.T', '2026-09-14T10:00:00+09:00', '2026-09-14T11:00:00+09:00', true],
    ['crypto overnight', 'BTC-USD', '2026-09-14T15:30:00+09:00', '2026-09-15T09:00:00+09:00', true],
  ])('handles %s gaps without hiding missing trading data', async (_label, symbol, left, right, shouldFetch) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T18:00:00+09:00'));
    const from = timestamp(left);
    const to = timestamp(right);
    const candles = [from - 900, to].map((time) => ({ time, open: 100, high: 102, low: 99, close: 101 }));
    const cache = memoryCache();
    await cache.write(YFINANCE_JP_HISTORY_SOURCE, symbol, '15m', candles);
    await cache.markCoverage(YFINANCE_JP_HISTORY_SOURCE, symbol, '15m', { from: from - 900, to: from });
    await cache.markCoverage(YFINANCE_JP_HISTORY_SOURCE, symbol, '15m', { from: to, to: to + 900 });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: 'no price data found' }), { status: 502 }));
    const feed = new YFinanceJapanDatafeed('/yfinance-jp-api', { cache, fetchImpl });
    const result = feed.getHistory(symbol, '15m', 100, { from: from - 900, to: to + 900 });
    if (shouldFetch) {
      await expect(result).rejects.toThrow(/could not backfill.*JST.*no price data found/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } else {
      await expect(result).resolves.toEqual(candles);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

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

  it.each([
    ['nikkei', '^N225'], ['NIKKEI225', '^N225'], ['Nikkei 225', '^N225'], ['n225', '^N225'], ['^n225', '^N225'],
    ['btc', 'BTC-USD'], ['BTC/USD', 'BTC-USD'], ['BTC-USD', 'BTC-USD'],
    ['usdyen', 'JPY=X'], ['USD/JPY', 'JPY=X'], ['USDJPY=X', 'JPY=X'],
    ['xauusd', 'GC=F'], ['XAU/USD', 'GC=F'], ['GC=F', 'GC=F'],
  ])('loads history for alias %s using Yahoo ticker %s', async (alias, symbol) => {
    expect(normalizeYFinanceJapanSymbol(alias)).toBe(symbol);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ candles: [] }))) as unknown as typeof fetch;
    const feed = new YFinanceJapanDatafeed('/yfinance-jp-api', { cache: memoryCache(), fetchImpl });
    await feed.getHistory(alias, '1d');
    const url = new URL(String(vi.mocked(fetchImpl).mock.calls[0][0]));
    expect(url.searchParams.get('symbol')).toBe(symbol);
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

  it('keeps global search results so they can be selected for the chart', async () => {
    const symbols = [
      { symbol: 'BTC-USD', name: 'Bitcoin / US Dollar', exchange: 'Crypto' },
      { symbol: 'JPY=X', name: 'USD/JPY', exchange: 'Forex' },
      { symbol: 'GC=F', name: 'Gold Futures (USD) — XAUUSD alternative', exchange: 'COMEX Futures' },
    ];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ symbols }))) as unknown as typeof fetch;
    const feed = new YFinanceJapanDatafeed('/yfinance-jp-api', { cache: memoryCache(), fetchImpl });
    await expect(feed.searchSymbols('usd')).resolves.toEqual(symbols);
  });

  it('loads small multi-symbol daily histories in one sidecar request for watchlists', async () => {
    const first = { time: 1_754_774_400, open: 100, high: 104, low: 99, close: 103, volume: 1_000 };
    const second = { time: 1_754_860_800, open: 103, high: 106, low: 102, close: 105, volume: 900 };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      candles: {
        '7203.T': [first, second],
        '6758.T': [{ ...first, open: 200, high: 204, low: 199, close: 202 }],
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
    const feed = new YFinanceJapanDatafeed('/yfinance-jp-api', { cache: memoryCache(), fetchImpl });

    const result = await feed.getDailyHistoryMany(['7203', '6758.T', '7203.T'], 2);

    expect(result['7203.T']).toEqual([first, second]);
    expect(result['6758.T']).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [input, init] = vi.mocked(fetchImpl).mock.calls[0];
    expect(String(input)).toBe('/yfinance-jp-api/scanner/history');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ symbols: ['7203.T', '6758.T'], limit: 2 });
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
    vi.useFakeTimers();
    vi.setSystemTime(1_700_086_400 * 1000);
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

  it.each([
    ['1m', 8], ['5m', 60], ['15m', 60], ['30m', 60], ['1h', 730], ['4h', 730],
  ])('clips %s backfills to Yahoo retention while preserving older cached candles', async (interval, days) => {
    vi.useFakeTimers();
    const now = timestamp('2026-10-09T12:00:00Z');
    vi.setSystemTime(now * 1000);
    const earliest = now - Number(days) * 86_400 + 60;
    const cached = { time: earliest - 86_400, open: 100, high: 102, low: 99, close: 101 };
    const remote = { ...cached, time: earliest + 900 };
    const cache = memoryCache();
    await cache.write(YFINANCE_JP_HISTORY_SOURCE, '9984.T', String(interval), [cached]);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ candles: [remote] }))) as unknown as typeof fetch;
    const feed = new YFinanceJapanDatafeed('/yfinance-jp-api', { cache, fetchImpl });

    await expect(feed.getHistory('9984.T', String(interval), 500, {
      from: cached.time, to: now,
    })).resolves.toEqual([cached, remote]);
    const url = new URL(String(vi.mocked(fetchImpl).mock.calls[0][0]));
    expect(Number(url.searchParams.get('from'))).toBe(earliest);
    expect(Number(url.searchParams.get('to'))).toBe(now);

    vi.mocked(fetchImpl).mockClear();
    await expect(feed.getHistory('9984.T', String(interval), 500, {
      from: cached.time - 86_400, to: cached.time,
    })).resolves.toEqual([cached]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['1d', '1w', '1M'])('keeps long-term %s history unrestricted', async (interval) => {
    const range = { from: timestamp('2000-01-01'), to: timestamp('2020-01-01') };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ candles: [] }))) as unknown as typeof fetch;
    const feed = new YFinanceJapanDatafeed('/yfinance-jp-api', { cache: memoryCache(), fetchImpl });
    await feed.getHistory('9984.T', interval, 500, range);
    const url = new URL(String(vi.mocked(fetchImpl).mock.calls[0][0]));
    expect(Number(url.searchParams.get('from'))).toBe(range.from);
    expect(Number(url.searchParams.get('to'))).toBe(range.to);
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

  it('primes a new chart quote immediately while retaining the normal 60-second poll', async () => {
    vi.useFakeTimers();
    const candle = { time: 1_754_860_800, open: 100, high: 105, low: 99, close: 103, volume: 1_000 };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      candles: { '7203.T': candle },
    }), { status: 200 })) as unknown as typeof fetch;
    const feed = new YFinanceJapanDatafeed('/yfinance-jp-api', { cache: memoryCache(), fetchImpl });
    const onCandle = vi.fn();
    const unsubscribe = feed.subscribe('7203.T', '1d', onCandle);
    await feed.refreshQuotes();
    expect(onCandle).toHaveBeenCalledWith(candle);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    unsubscribe();
    feed.dispose();
  });

  it.each([
    ['1m', '2026-10-06T09:00:00+09:00', '2026-10-06T09:01:00+09:00', '2026-10-06T09:02:00+09:00'],
    ['5m', '2026-10-06T09:00:00+09:00', '2026-10-06T09:05:00+09:00', '2026-10-06T09:10:00+09:00'],
    ['4h', '2026-10-05T09:00:00+09:00', '2026-10-05T13:00:00+09:00', '2026-10-06T09:00:00+09:00'],
  ] as const)('backfills skipped %s candles before publishing the latest candle', async (interval, firstTime, missingTime, latestTime) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(latestTime));
    const first = {
      time: timestamp(firstTime),
      open: 100,
      high: 105,
      low: 99,
      close: 103,
      volume: 1_000,
    };
    const missing = { ...first, time: timestamp(missingTime), open: 103, close: 104 };
    const latest = { ...first, time: timestamp(latestTime), open: 104, close: 105 };
    const cache = memoryCache();
    await cache.write(YFINANCE_JP_HISTORY_SOURCE, '7203.T', interval, [first]);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/latest')) {
        return new Response(JSON.stringify({ candles: { '7203.T': latest } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.pathname.endsWith('/history')) {
        expect(url.searchParams.get('from')).toBe(String(first.time));
        expect(url.searchParams.get('to')).toBe(String(latest.time));
        return new Response(JSON.stringify({ candles: [first, missing, latest] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    }) as unknown as typeof fetch;
    const feed = new YFinanceJapanDatafeed('/yfinance-jp-api', {
      cache,
      fetchImpl,
      pollMs: 1_000,
    });
    const onCandle = vi.fn();

    const unsubscribe = feed.subscribe('7203', interval, onCandle);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onCandle.mock.calls.map(([candle]) => candle.time)).toEqual([missing.time, latest.time]);

    unsubscribe();
    feed.dispose();
  });

  it('retries an unresolved live gap on the next poll', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T12:00:00+09:00'));
    const first = {
      time: timestamp('2026-10-06T09:00:00+09:00'),
      open: 100,
      high: 105,
      low: 99,
      close: 103,
      volume: 1_000,
    };
    const missing = { ...first, time: first.time + 60, open: 103, close: 104 };
    const latest = { ...first, time: first.time + 120, open: 104, close: 105 };
    const cache = memoryCache();
    await cache.write(YFINANCE_JP_HISTORY_SOURCE, '7203.T', '1m', [first]);
    let historyAttempts = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/latest')) {
        return new Response(JSON.stringify({ candles: { '7203.T': latest } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.pathname.endsWith('/history')) {
        historyAttempts += 1;
        if (historyAttempts === 1) {
          return new Response(JSON.stringify({ message: 'temporary failure' }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ candles: [first, missing, latest] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    }) as unknown as typeof fetch;
    const feed = new YFinanceJapanDatafeed('/yfinance-jp-api', {
      cache,
      fetchImpl,
      pollMs: 1_000,
    });
    const onCandle = vi.fn();

    const unsubscribe = feed.subscribe('7203', '1m', onCandle);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onCandle).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(historyAttempts).toBe(2);
    expect(onCandle.mock.calls.map(([candle]) => candle.time)).toEqual([missing.time, latest.time]);

    unsubscribe();
    feed.dispose();
  });

  it('accepts sparse history as authoritative during live recovery', async () => {
    vi.useFakeTimers();
    const first = {
      time: timestamp('2026-10-06T09:00:00+09:00'),
      open: 100,
      high: 105,
      low: 99,
      close: 103,
      volume: 1_000,
    };
    const latest = { ...first, time: first.time + 15 * 60, open: 104, close: 105 };
    const cache = memoryCache();
    await cache.write(YFINANCE_JP_HISTORY_SOURCE, '7203.T', '1m', [first]);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/latest')) {
        return new Response(JSON.stringify({ candles: { '7203.T': latest } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.pathname.endsWith('/history')) {
        return new Response(JSON.stringify({ candles: [first, latest] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    }) as unknown as typeof fetch;
    const feed = new YFinanceJapanDatafeed('/yfinance-jp-api', {
      cache,
      fetchImpl,
      pollMs: 1_000,
    });
    const onCandle = vi.fn();

    const unsubscribe = feed.subscribe('7203', '1m', onCandle);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onCandle).toHaveBeenCalledTimes(1);
    expect(onCandle).toHaveBeenCalledWith(latest);

    unsubscribe();
    feed.dispose();
  });

  it('recovers the 11:30 close candle across the Tokyo lunch break', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T12:30:00+09:00'));
    const first = {
      time: timestamp('2026-10-06T11:29:00+09:00'),
      open: 100,
      high: 105,
      low: 99,
      close: 103,
      volume: 1_000,
    };
    const closeAuction = { ...first, time: timestamp('2026-10-06T11:30:00+09:00'), open: 103, close: 104 };
    const latest = { ...first, time: timestamp('2026-10-06T12:30:00+09:00'), open: 104, close: 105 };
    const cache = memoryCache();
    await cache.write(YFINANCE_JP_HISTORY_SOURCE, '7203.T', '1m', [first]);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/latest')) {
        return new Response(JSON.stringify({ candles: { '7203.T': latest } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.pathname.endsWith('/history')) {
        return new Response(JSON.stringify({ candles: [first, closeAuction, latest] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    }) as unknown as typeof fetch;
    const feed = new YFinanceJapanDatafeed('/yfinance-jp-api', {
      cache,
      fetchImpl,
      pollMs: 1_000,
    });
    const onCandle = vi.fn();

    const unsubscribe = feed.subscribe('7203', '1m', onCandle);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onCandle.mock.calls.map(([candle]) => candle.time)).toEqual([closeAuction.time, latest.time]);

    unsubscribe();
    feed.dispose();
  });

  it('caps stale 1m recovery to Yahoo safe history horizon', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T15:00:00+09:00'));
    const latest = {
      time: timestamp('2026-10-06T15:00:00+09:00'),
      open: 100,
      high: 105,
      low: 99,
      close: 103,
      volume: 1_000,
    };
    const stale = { ...latest, time: latest.time - 10 * 86_400, close: 98 };
    const recent = { ...latest, time: latest.time - 60, close: 102 };
    const cache = memoryCache();
    await cache.write(YFINANCE_JP_HISTORY_SOURCE, '7203.T', '1m', [stale]);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/latest')) {
        return new Response(JSON.stringify({ candles: { '7203.T': latest } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.pathname.endsWith('/history')) {
        expect(Number(url.searchParams.get('from'))).toBe(latest.time - 5 * 86_400);
        expect(url.searchParams.get('to')).toBe(String(latest.time));
        return new Response(JSON.stringify({ candles: [recent, latest] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    }) as unknown as typeof fetch;
    const feed = new YFinanceJapanDatafeed('/yfinance-jp-api', {
      cache,
      fetchImpl,
      pollMs: 1_000,
    });
    const onCandle = vi.fn();

    const unsubscribe = feed.subscribe('7203', '1m', onCandle);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onCandle.mock.calls.map(([candle]) => candle.time)).toEqual([recent.time, latest.time]);

    unsubscribe();
    feed.dispose();
  });
});
