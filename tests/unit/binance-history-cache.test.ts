import { describe, expect, it, vi } from 'vitest';
import type { Candle } from '../../src/core/types';
import { BinanceHistoryCache } from '../../examples/providers/binance-cache';
import type { BrowserHistoryCacheApi } from '../../examples/providers/browser-history-cache';

function candle(time: number): Candle {
  return {
    time,
    open: time,
    high: time + 1,
    low: time - 1,
    close: time + 0.5,
    volume: 1,
  };
}

function baseCache(overrides: Partial<BrowserHistoryCacheApi> = {}): BrowserHistoryCacheApi {
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('BinanceHistoryCache transaction scheduling', () => {
  it('aborts the underlying IndexedDB read when the cache deadline expires', async () => {
    let seenSignal: AbortSignal | undefined;
    const shared = baseCache({
      readLatest: vi.fn((_source, _symbol, _interval, _limit, signal) => {
        seenSignal = signal;
        return new Promise<Candle[]>((resolve) => {
          signal?.addEventListener('abort', () => resolve([]), { once: true });
        });
      }),
    });
    const cache = new BinanceHistoryCache(shared, { readTimeoutMs: 10 });

    await expect(cache.readLatest('spot', 'BTCUSDT', '1d', 500)).resolves.toEqual([]);
    expect(seenSignal?.aborted).toBe(true);
  });

  it('cancels a stale background write as soon as a new foreground read begins', async () => {
    let writeSignal: AbortSignal | undefined;
    const writeStarted = new Promise<void>((resolveStarted) => {
      const shared = baseCache({
        write: vi.fn((_source, _symbol, _interval, _candles, signal) => {
          writeSignal = signal;
          resolveStarted();
          return new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        }),
      });
      Object.assign(globalThis, { __binanceCacheTestShared: shared });
    });
    const shared = (globalThis as typeof globalThis & { __binanceCacheTestShared: BrowserHistoryCacheApi }).__binanceCacheTestShared;
    const cache = new BinanceHistoryCache(shared, {
      readTimeoutMs: 50,
      writeTimeoutMs: 5000,
      writeChunkSize: 100,
    });

    const pendingWrite = cache.write('spot', 'BTCUSDT', '1w', [candle(1), candle(2)]);
    await writeStarted;
    expect(writeSignal?.aborted).toBe(false);

    await cache.readLatest('spot', 'BTCUSDT', '1d', 500);
    await pendingWrite;
    expect(writeSignal?.aborted).toBe(true);
    delete (globalThis as typeof globalThis & { __binanceCacheTestShared?: BrowserHistoryCacheApi }).__binanceCacheTestShared;
  });

  it('splits large refresh persistence into short transactions', async () => {
    const write = vi.fn(async () => undefined);
    const shared = baseCache({ write });
    const cache = new BinanceHistoryCache(shared, {
      writeChunkSize: 3,
      writeTimeoutMs: 100,
    });

    await cache.write('spot', 'BTCUSDT', '1w', [
      candle(1), candle(2), candle(3), candle(4), candle(5), candle(6), candle(7),
    ]);

    expect(write).toHaveBeenCalledTimes(3);
    expect(write.mock.calls.map((call) => call[3].length)).toEqual([3, 3, 1]);
  });

  it('abandons the remaining chunks when one cache transaction exceeds its deadline', async () => {
    const write = vi.fn((_source, _symbol, _interval, _candles, signal?: AbortSignal) =>
      new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => resolve(), { once: true });
      }));
    const shared = baseCache({ write });
    const cache = new BinanceHistoryCache(shared, {
      writeChunkSize: 2,
      writeTimeoutMs: 10,
    });

    await cache.write('spot', 'BTCUSDT', '1w', [candle(1), candle(2), candle(3), candle(4)]);
    await wait(0);

    expect(write).toHaveBeenCalledTimes(1);
    expect((write.mock.calls[0][4] as AbortSignal | undefined)?.aborted).toBe(true);
  });
});
