import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserHistoryCacheApi } from '../../examples/providers/browser-history-cache';
import {
  isVnstockRoutableSymbol,
  VnstockDatafeed,
} from '../../examples/providers/vnstock-routed';

function emptyCache(): BrowserHistoryCacheApi {
  return {
    available: true,
    async coverage() { return []; },
    async readLatest() { return []; },
    async readRange() { return []; },
    async write() { /* no-op */ },
    async markCoverage() { /* no-op */ },
    async clearSource() { /* no-op */ },
  };
}

describe('Vnstock market routing', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps Vietnam instruments routable while rejecting obvious crypto pairs', () => {
    expect(isVnstockRoutableSymbol('FPT')).toBe(true);
    expect(isVnstockRoutableSymbol('VNINDEX')).toBe(true);
    expect(isVnstockRoutableSymbol('VN30F1M')).toBe(true);

    expect(isVnstockRoutableSymbol('BTCUSDT')).toBe(false);
    expect(isVnstockRoutableSymbol('ETHUSDT')).toBe(false);
    expect(isVnstockRoutableSymbol('SOLUSDT')).toBe(false);
    expect(isVnstockRoutableSymbol('BNBUSDT')).toBe(false);
    expect(isVnstockRoutableSymbol('ETHBTC')).toBe(false);
  });

  it('never sends an unsupported active-chart symbol to Vnstock history or polling', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T03:00:00Z'));
    const fetchMock = vi.fn();
    const feed = new VnstockDatafeed('/vnstock-api', {
      cache: emptyCache(),
      fetchImpl: fetchMock as unknown as typeof fetch,
      pollMs: 2_000,
    });

    await expect(feed.getHistory('BTCUSDT', '1d', 500)).resolves.toEqual([]);
    feed.subscribe('BTCUSDT', '1d', vi.fn());
    await vi.advanceTimersByTimeAsync(30_000);

    expect(fetchMock).not.toHaveBeenCalled();
    feed.dispose();
  });

  it('filters a dirty watchlist before Vnstock subscribeMany reaches the network', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T03:00:00Z'));
    const candle = {
      time: 1_754_860_800,
      open: 100,
      high: 105,
      low: 99,
      close: 103,
      volume: 1_000,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const symbol = url.searchParams.get('symbols') ?? '';
      return new Response(JSON.stringify({ candles: { [symbol]: candle } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const feed = new VnstockDatafeed('/vnstock-api', {
      cache: emptyCache(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    feed.subscribeMany(['BTCUSDT', 'HPG', 'ETHUSDT', 'SOLUSDT'], '1d', vi.fn());
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('symbols=HPG');
    expect(String(fetchMock.mock.calls[0][0])).not.toMatch(/BTCUSDT|ETHUSDT|SOLUSDT/);
    feed.dispose();
  });

  it('keeps watchlist polling detached outside the Vietnam session and resumes after open', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T01:58:00Z'));
    const candle = {
      time: 1_754_860_800,
      open: 100,
      high: 105,
      low: 99,
      close: 103,
      volume: 1_000,
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({
      candles: { HPG: candle },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const feed = new VnstockDatafeed('/vnstock-api', {
      cache: emptyCache(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    feed.subscribeMany(['HPG'], '1d', vi.fn());
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('symbols=HPG');
    feed.dispose();
  });
});
