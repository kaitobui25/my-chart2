import { describe, expect, it, vi } from 'vitest';
import {
  BinanceDatafeed,
  WorkstationBinanceIdleRefreshCoordinator,
} from '../../examples/providers/binance-workstation';
import { BinanceHistoryCache } from '../../examples/providers/binance-cache';
import type { BrowserHistoryCacheApi } from '../../examples/providers/browser-history-cache';

function emptyBrowserCache(): BrowserHistoryCacheApi {
  return {
    available: true,
    coverage: vi.fn(async () => []),
    readLatest: vi.fn(async () => []),
    readRange: vi.fn(async () => []),
    write: vi.fn(async () => undefined),
    markCoverage: vi.fn(async () => undefined),
    clearSource: vi.fn(async () => undefined),
  };
}

function klineRow(time: number): unknown[] {
  return [time * 1000, '100', '101', '99', '100.5', '10'];
}

describe('Binance workstation latest failover', () => {
  it('uses api.binance.com after the default market-data route is interrupted', async () => {
    const hosts: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const host = new URL(String(input)).host;
      hosts.push(host);
      if (host === 'data-api.binance.vision') {
        throw new DOMException('The user aborted a request.', 'AbortError');
      }
      return new Response(JSON.stringify([
        klineRow(Math.floor(Date.now() / 1000) - 60),
      ]), { status: 200 });
    }) as unknown as typeof fetch;

    const feed = new BinanceDatafeed({
      market: 'spot',
      cache: new BinanceHistoryCache(emptyBrowserCache()),
      fetchImpl,
      requestTimeoutMs: 1000,
      refreshCoordinator: new WorkstationBinanceIdleRefreshCoordinator(0),
    });

    const candles = await feed.getHistory('SOLUSDT', '1M', 1);
    expect(candles).toHaveLength(1);
    expect(hosts).toEqual(['data-api.binance.vision', 'api.binance.com']);
  });
});
