import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Candle } from '../../src/core/types';
import {
  BinanceDatafeed,
  WorkstationBinanceIdleRefreshCoordinator,
} from '../../examples/providers/binance-workstation';
import { BinanceHistoryCache } from '../../examples/providers/binance-cache';
import type { BrowserHistoryCacheApi } from '../../examples/providers/browser-history-cache';
import { scannerIntegration } from '../../examples/workstation/scanner/vite-plugin';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function klineRow(time: number, close: number): unknown[] {
  return [
    time * 1000,
    String(close - 0.5),
    String(close + 1),
    String(close - 1),
    String(close),
    '100',
  ];
}

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

async function transformedWorkstation(): Promise<string> {
  const sourcePath = path.resolve('examples/workstation/main.ts');
  const source = readFileSync(sourcePath, 'utf8');
  const plugin = scannerIntegration();
  const hook = plugin.transform;
  if (typeof hook !== 'function') throw new Error('scanner transform hook is unavailable');
  const result = await hook.call({} as never, source, sourcePath, { moduleType: 'js' } as never);
  if (!result) throw new Error('scanner transform returned no workstation code');
  return typeof result === 'string' ? result : String(result.code ?? '');
}

describe('Binance workstation multi-chart refresh isolation', () => {
  it('does not abort an active chart task when another chart reports data activity', async () => {
    const coordinator = new WorkstationBinanceIdleRefreshCoordinator(5);
    coordinator.noteActivity();

    let firstSignal: AbortSignal | null = null;
    let releaseFirst!: () => void;
    const first = coordinator.runWhenIdle(async (signal) => {
      firstSignal = signal;
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return 'BTC';
    });

    await wait(12);
    expect(firstSignal).not.toBeNull();
    expect(firstSignal!.aborted).toBe(false);

    coordinator.noteActivity();
    expect(firstSignal!.aborted).toBe(false);

    releaseFirst();
    await expect(first).resolves.toBe('BTC');
  });

  it('does not put foreground history behind the provider quiet period', async () => {
    const coordinator = new WorkstationBinanceIdleRefreshCoordinator(10_000);
    coordinator.noteActivity();
    let started = false;

    const request = coordinator.runWhenIdle(async () => {
      started = true;
      return 'ETH';
    });

    await Promise.resolve();
    expect(started).toBe(true);
    await expect(request).resolves.toBe('ETH');
  });

  it('still aborts a task when its own tile cancellation signal fires', async () => {
    const coordinator = new WorkstationBinanceIdleRefreshCoordinator(5);
    const cancellation = new AbortController();
    coordinator.noteActivity();

    const task = coordinator.runWhenIdle(
      (signal) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      }),
      { retryOnInterrupt: true, cancelSignal: cancellation.signal },
    );

    await wait(12);
    cancellation.abort();
    await expect(task).resolves.toBeUndefined();
  });

  it('lets two cache-miss chart histories finish in parallel without cross-abort', async () => {
    const cache = emptyBrowserCache();
    let abortCount = 0;
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const symbol = url.searchParams.get('symbol');
      const close = symbol === 'ETHUSDT' ? 200 : 100;
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(new Response(JSON.stringify([
            klineRow(Math.floor(Date.now() / 1000) - 60, close),
          ]), { status: 200 }));
        }, 25);
        init?.signal?.addEventListener('abort', () => {
          abortCount += 1;
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    }) as unknown as typeof fetch;

    const feed = new BinanceDatafeed({
      market: 'spot',
      cache: new BinanceHistoryCache(cache),
      fetchImpl,
      requestTimeoutMs: 1000,
      refreshCoordinator: new WorkstationBinanceIdleRefreshCoordinator(5),
    });

    await feed.getCachedHistory('BTCUSDT', '1m', 1);
    const btcHistory = feed.getHistory('BTCUSDT', '1m', 1);
    await wait(12);

    await feed.getCachedHistory('ETHUSDT', '1m', 1);
    const ethHistory = feed.getHistory('ETHUSDT', '1m', 1);

    const [btc, eth] = await Promise.all([btcHistory, ethHistory]);
    expect(abortCount).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(btc).toHaveLength(1);
    expect(eth).toHaveLength(1);
    expect((btc[0] as Candle).close).toBe(100);
    expect((eth[0] as Candle).close).toBe(200);
  });

  it('retries one interrupted latest request instead of leaving the chart empty', async () => {
    const cache = emptyBrowserCache();
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new DOMException('The user aborted a request.', 'AbortError');
      return new Response(JSON.stringify([
        klineRow(Math.floor(Date.now() / 1000) - 60, 150),
      ]), { status: 200 });
    }) as unknown as typeof fetch;

    const feed = new BinanceDatafeed({
      market: 'spot',
      cache: new BinanceHistoryCache(cache),
      fetchImpl,
      requestTimeoutMs: 1000,
      refreshCoordinator: new WorkstationBinanceIdleRefreshCoordinator(0),
    });

    const candles = await feed.getHistory('SOLUSDT', '1M', 1);
    expect(attempts).toBe(2);
    expect(candles).toHaveLength(1);
    expect(candles[0].close).toBe(150);
  });

  it('routes workstation Binance through the adapter and deprioritizes older history', async () => {
    const code = await transformedWorkstation();
    expect(code).toContain("import { BinanceDatafeed } from '../providers/binance-workstation';");
    expect(code).not.toContain("import { BinanceDatafeed } from '../providers/binance';");
    expect(code).toContain('await candleDataCoordinator.waitUntilIdle();');
    expect(code).toContain('tiles.some((tile) => tile !== this && tile.loading)');
  });
});
