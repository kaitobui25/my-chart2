import { describe, expect, it, vi } from 'vitest';
import type { Candle } from '../../src/core/types';
import type { Datafeed } from '../../src/datafeed';
import { loadIndicatorHistory } from '../../examples/workstation/indicator-history';

const candle = (time: number): Candle => ({ time, open: 10, high: 12, low: 9, close: 11 });
describe('provider-independent indicator history', () => {
  it('requests actual bar counts without assuming trading hours, excluding later bars', async () => {
    const getHistory = vi.fn().mockResolvedValue([candle(100), candle(200), candle(300)]);
    const feed: Datafeed = { name: 'session market', getHistory, subscribe: () => () => {} };
    expect(await loadIndicatorHistory(feed, 'FPT', '1d', { from: 0, to: 200, limit: 650 }))
      .toEqual([candle(100), candle(200)]);
    expect(getHistory).toHaveBeenCalledExactlyOnceWith('FPT', '1d', 650);
  });
  it('requests historical bars when the chart predates the latest window', async () => {
    const getHistory = vi.fn().mockResolvedValueOnce([candle(300)])
      .mockResolvedValueOnce([candle(100)]);
    const feed: Datafeed = { name: 'historical provider', getHistory, subscribe: () => () => {} };
    const range = { from: 0, to: 200, limit: 650 };
    expect(await loadIndicatorHistory(feed, 'BTCUSDT', '1h', range)).toEqual([candle(100)]);
    expect(getHistory).toHaveBeenLastCalledWith('BTCUSDT', '1h', 650, range);
  });
  it('passes through provider failures so unsupported frames remain visible', async () => {
    const feed: Datafeed = { name: 'daily only', getHistory: vi.fn().mockRejectedValue(new Error('unsupported interval')),
      subscribe: () => () => {} };
    await expect(loadIndicatorHistory(feed, 'FPT', '15m', { from: 0, to: 200, limit: 650 }))
      .rejects.toThrow('unsupported interval');
  });
  it('uses cached provider bars when the remote route is unavailable', async () => {
    const feed: Datafeed = { name: 'cached provider', getHistory: vi.fn().mockRejectedValue(new Error('offline')),
      getCachedHistory: vi.fn().mockResolvedValue([candle(100)]), subscribe: () => () => {} };
    expect(await loadIndicatorHistory(feed, 'BTCUSDT', '1h', { from: 0, to: 200, limit: 650 })).toEqual([candle(100)]);
  });
});
