import { describe, expect, it, vi } from 'vitest';

import type { Candle } from '../../src/index';
import {
  CandleDataCoordinator,
  candleDatasetKey,
} from '../../examples/workstation/data/candle-data-coordinator';

function candles(...times: number[]): Candle[] {
  return times.map((time) => ({
    time,
    open: time,
    high: time + 2,
    low: time - 2,
    close: time + 1,
    volume: time * 10,
  }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('CandleDataCoordinator', () => {
  it('returns a RAM hit without invoking the loader', async () => {
    const coordinator = new CandleDataCoordinator();
    const key = candleDatasetKey('binance-spot', ' btcusdt ', '1d');
    coordinator.remember(key, candles(1, 2, 3), 500);
    const loader = vi.fn(async () => candles(4));

    const result = await coordinator.loadLatest(key, 2, loader);

    expect(result.map((candle) => candle.time)).toEqual([2, 3]);
    expect(loader).not.toHaveBeenCalled();
  });

  it('dedupes concurrent callers for the same dataset and sufficient limit', async () => {
    const coordinator = new CandleDataCoordinator();
    const key = candleDatasetKey('binance-spot', 'BTCUSDT', '1d');
    const pending = deferred<Candle[]>();
    const loader = vi.fn(async () => pending.promise);

    const first = coordinator.loadLatest(key, 500, loader);
    const second = coordinator.loadLatest(key, 120, loader);
    await Promise.resolve();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith(500);

    pending.resolve(candles(1, 2, 3));
    expect((await first).map((candle) => candle.time)).toEqual([1, 2, 3]);
    expect((await second).map((candle) => candle.time)).toEqual([1, 2, 3]);
  });

  it('keeps different datasets independent', async () => {
    const coordinator = new CandleDataCoordinator();
    const btc = candleDatasetKey('binance-spot', 'BTCUSDT', '1d');
    const eth = candleDatasetKey('binance-spot', 'ETHUSDT', '1d');
    const loader = vi.fn(async (limit: number) => candles(limit));

    await Promise.all([
      coordinator.loadLatest(btc, 500, loader),
      coordinator.loadLatest(eth, 120, loader),
    ]);

    expect(loader).toHaveBeenCalledTimes(2);
    expect(coordinator.peek(btc, 500)?.[0].time).toBe(500);
    expect(coordinator.peek(eth, 120)?.[0].time).toBe(120);
  });

  it('does not let an old result overwrite state remembered after new data activity', async () => {
    const coordinator = new CandleDataCoordinator({ idleMs: 0 });
    const key = candleDatasetKey('fiinquant', 'HPG', '1d');
    const oldRequest = deferred<Candle[]>();
    const loading = coordinator.loadLatest(key, 500, async () => oldRequest.promise);
    await Promise.resolve();

    coordinator.noteDataActivity();
    coordinator.remember(key, candles(20, 21), 500);
    oldRequest.resolve(candles(10, 11));
    await loading;

    expect(coordinator.peek(key, 500)?.map((candle) => candle.time)).toEqual([20, 21]);
  });

  it('evicts the least recently used dataset without evicting a recently touched one', () => {
    let now = 0;
    const coordinator = new CandleDataCoordinator({ maxEntries: 2, now: () => now });
    const a = candleDatasetKey('binance-spot', 'A', '1d');
    const b = candleDatasetKey('binance-spot', 'B', '1d');
    const c = candleDatasetKey('binance-spot', 'C', '1d');

    now = 1;
    coordinator.remember(a, candles(1), 1);
    now = 2;
    coordinator.remember(b, candles(2), 1);
    now = 3;
    expect(coordinator.peek(a, 1)).not.toBeNull();
    now = 4;
    coordinator.remember(c, candles(3), 1);

    expect(coordinator.peek(a, 1)).not.toBeNull();
    expect(coordinator.peek(b, 1)).toBeNull();
    expect(coordinator.peek(c, 1)).not.toBeNull();
  });

  it('clears only RAM entries owned by the requested provider', () => {
    const coordinator = new CandleDataCoordinator();
    const spot = candleDatasetKey('binance-spot', 'BTCUSDT', '1d');
    const fiin = candleDatasetKey('fiinquant', 'HPG', '1d');
    coordinator.remember(spot, candles(1), 1);
    coordinator.remember(fiin, candles(2), 1);

    coordinator.clearProvider('binance-spot');

    expect(coordinator.peek(spot, 1)).toBeNull();
    expect(coordinator.peek(fiin, 1)).not.toBeNull();
  });

  it('waits for the quiet period before a forced background refresh', async () => {
    let now = 1_000;
    const sleeps: number[] = [];
    const coordinator = new CandleDataCoordinator({
      idleMs: 700,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    const key = candleDatasetKey('binance-spot', 'BTCUSDT', '1d');
    const loader = vi.fn(async () => candles(1));
    coordinator.remember(key, candles(0), 500);
    coordinator.noteDataActivity();

    const result = await coordinator.loadLatest(key, 500, loader, { refresh: true });

    expect(sleeps).toEqual([700]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(result[0].time).toBe(1);
  });

  it('starts a larger request instead of reusing an insufficient in-flight page', async () => {
    const coordinator = new CandleDataCoordinator();
    const key = candleDatasetKey('binance-spot', 'BTCUSDT', '1M');
    const small = deferred<Candle[]>();
    const large = deferred<Candle[]>();
    const loader = vi.fn((limit: number) => limit === 120 ? small.promise : large.promise);

    const first = coordinator.loadLatest(key, 120, loader);
    const second = coordinator.loadLatest(key, 500, loader);
    await Promise.resolve();
    expect(loader).toHaveBeenCalledTimes(2);

    small.resolve(candles(1));
    large.resolve(candles(1, 2));
    await Promise.all([first, second]);

    expect(coordinator.peek(key, 500)?.map((candle) => candle.time)).toEqual([1, 2]);
  });
});
