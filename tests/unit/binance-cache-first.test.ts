import { describe, expect, it, vi } from 'vitest';
import type { Candle } from '../../src/core/types';
import {
  BinanceDatafeed,
  BinanceIdleRefreshCoordinator,
} from '../../examples/providers/binance';
import { BinanceHistoryCache } from '../../examples/providers/binance-cache';
import type { BrowserHistoryCacheApi } from '../../examples/providers/browser-history-cache';

const DAY = 24 * 60 * 60;

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

function fakeBrowserCache(cached: Candle[]): BrowserHistoryCacheApi {
  return {
    available: true,
    coverage: vi.fn(async () => []),
    readLatest: vi.fn(async () => cached.map((item) => ({ ...item }))),
    readRange: vi.fn(async () => []),
    write: vi.fn(async () => undefined),
    markCoverage: vi.fn(async () => undefined),
    clearSource: vi.fn(async () => undefined),
  };
}

function fakeSocketFactory() {
  const socket = {
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    close: vi.fn(),
  };
  return {
    factory: vi.fn(() => socket as unknown as WebSocket),
    socket,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Binance cache-first idle refresh', () => {
  it('renders cached history without REST and cancels deferred work when the tile is replaced', async () => {
    const nowBar = Math.floor(Date.now() / 1000 / DAY) * DAY;
    const cached = [
      candle(nowBar - 4 * DAY, 10),
      candle(nowBar - 3 * DAY, 11),
      candle(nowBar - 2 * DAY, 12),
    ];
    const shared = fakeBrowserCache(cached);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })) as unknown as typeof fetch;
    const sockets = fakeSocketFactory();
    const feed = new BinanceDatafeed({
      cache: new BinanceHistoryCache(shared),
      fetchImpl,
      websocketFactory: sockets.factory,
      refreshCoordinator: new BinanceIdleRefreshCoordinator(60),
    });

    await expect(feed.getCachedHistory('BTCUSDT', '1d', 3)).resolves.toEqual(cached);
    await expect(feed.getHistory('BTCUSDT', '1d', 3)).resolves.toEqual(cached);
    expect(fetchImpl).not.toHaveBeenCalled();

    const unsubscribe = feed.subscribe('BTCUSDT', '1d', vi.fn());
    await wait(15);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sockets.factory).not.toHaveBeenCalled();

    unsubscribe();
    await wait(70);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sockets.factory).not.toHaveBeenCalled();
  });

  it('refreshes missing recent candles only after the quiet window, then opens realtime', async () => {
    const nowBar = Math.floor(Date.now() / 1000 / DAY) * DAY;
    const cached = [
      candle(nowBar - 4 * DAY, 20),
      candle(nowBar - 3 * DAY, 21),
      candle(nowBar - 2 * DAY, 22),
    ];
    const shared = fakeBrowserCache(cached);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
      klineRow(nowBar - DAY, 23),
      klineRow(nowBar, 24),
    ]), { status: 200 })) as unknown as typeof fetch;
    const sockets = fakeSocketFactory();
    const onCandle = vi.fn();
    const feed = new BinanceDatafeed({
      cache: new BinanceHistoryCache(shared),
      fetchImpl,
      websocketFactory: sockets.factory,
      refreshCoordinator: new BinanceIdleRefreshCoordinator(20),
    });

    await feed.getCachedHistory('BTCUSDT', '1d', 3);
    await feed.getHistory('BTCUSDT', '1d', 3);
    const unsubscribe = feed.subscribe('BTCUSDT', '1d', onCandle);

    expect(fetchImpl).not.toHaveBeenCalled();
    await wait(55);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sockets.factory).toHaveBeenCalledTimes(1);
    expect(onCandle.mock.calls.some(([item]) => item.time === nowBar - DAY)).toBe(true);
    expect(onCandle.mock.calls.some(([item]) => item.time === nowBar)).toBe(true);
    expect(shared.write).toHaveBeenCalled();
    unsubscribe();
  });

  it('aborts an active background REST refresh when another chart request arrives', async () => {
    const nowBar = Math.floor(Date.now() / 1000 / DAY) * DAY;
    const cached = [
      candle(nowBar - 5 * DAY, 30),
      candle(nowBar - 4 * DAY, 31),
      candle(nowBar - 3 * DAY, 32),
    ];
    const shared = fakeBrowserCache(cached);
    let aborted = false;
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    })) as unknown as typeof fetch;
    const sockets = fakeSocketFactory();
    const coordinator = new BinanceIdleRefreshCoordinator(5);
    const feed = new BinanceDatafeed({
      cache: new BinanceHistoryCache(shared),
      fetchImpl,
      websocketFactory: sockets.factory,
      refreshCoordinator: coordinator,
    });

    await feed.getCachedHistory('BTCUSDT', '1d', 3);
    await feed.getHistory('BTCUSDT', '1d', 3);
    const unsubscribe = feed.subscribe('BTCUSDT', '1d', vi.fn());
    await wait(20);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await feed.getCachedHistory('ETHUSDT', '1h', 3);
    await wait(0);
    expect(aborted).toBe(true);

    unsubscribe();
  });
});
