import { describe, expect, it, vi } from 'vitest';

import type { Candle } from '../../src/library';
import type { JapanMarketDatafeed } from '../../examples/excel-content-addin/japan-market-controller';
import {
  loadWatchListQuotes,
  quoteFromHistory,
} from '../../examples/excel-content-addin/watchlist-market';
import {
  WatchListStore,
  type WatchListStorage,
} from '../../examples/excel-content-addin/watchlist-store';
import { WATCHLIST_CONFIG } from '../../examples/excel-content-addin/watchlist-config';

function memoryStorage(initial: Record<string, string> = {}): WatchListStorage & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

function candle(time: number, open: number, close: number): Candle {
  return {
    time,
    open,
    high: Math.max(open, close) + 1,
    low: Math.min(open, close) - 1,
    close,
    volume: 1_000,
  };
}

describe('Excel Watch List store', () => {
  it('normalizes defaults and falls back safely when persisted JSON is corrupt', () => {
    const storage = memoryStorage({ 'watch': '{bad json' });
    const store = new WatchListStore(['7203', '7203.T', '6758'], storage, 'watch');

    expect(store.list()).toEqual(['7203.T', '6758.T']);
  });

  it('persists insertion order, ignores duplicates and supports removing symbols', () => {
    const storage = memoryStorage();
    const store = new WatchListStore(['7203'], storage, 'watch');

    expect(store.add('6758')).toBe('added');
    expect(store.add('6758.T')).toBe('exists');
    expect(store.list()).toEqual(['7203.T', '6758.T']);
    expect(JSON.parse(storage.values.get('watch') ?? '[]')).toEqual(['7203.T', '6758.T']);
    expect(store.remove('7203')).toBe(true);
    expect(store.list()).toEqual(['6758.T']);
  });

  it('caps the list to keep background refresh work bounded', () => {
    const defaults = Array.from({ length: WATCHLIST_CONFIG.maxSymbols }, (_, index) => `${1000 + index}`);
    const store = new WatchListStore(defaults, memoryStorage(), 'watch');

    expect(store.list()).toHaveLength(WATCHLIST_CONFIG.maxSymbols);
    expect(store.add('7203')).toBe('full');
  });
});

describe('Excel Watch List market adapter', () => {
  it('computes daily change from the previous close rather than the current candle open', () => {
    const quote = quoteFromHistory('7203.T', [
      candle(1_700_000_000, 90, 100),
      candle(1_700_086_400, 105, 110),
    ]);

    expect(quote).toMatchObject({
      symbol: '7203.T',
      price: 110,
      change: 10,
      changePercent: 10,
    });
  });

  it('uses the provider batch daily-history path when available', async () => {
    const batch = vi.fn(async () => ({
      '7203.T': [candle(1, 100, 100), candle(2, 101, 103)],
      '6758.T': [candle(1, 200, 200), candle(2, 198, 196)],
    }));
    const feed = {
      name: 'Fake Japan',
      getHistory: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
      searchSymbols: vi.fn(async () => []),
      getDailyHistoryMany: batch,
    } as unknown as JapanMarketDatafeed;

    const quotes = await loadWatchListQuotes(feed, ['7203.T', '6758.T']);

    expect(batch).toHaveBeenCalledWith(['7203.T', '6758.T'], 2);
    expect(feed.getHistory).not.toHaveBeenCalled();
    expect(quotes.get('7203.T')?.changePercent).toBeCloseTo(3);
    expect(quotes.get('6758.T')?.changePercent).toBeCloseTo(-2);
  });
});
