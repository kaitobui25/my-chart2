import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Candle, Datafeed } from '../../src/library';
import { ExcelPaperMarketBridge } from '../../examples/excel-content-addin/paper-market-bridge';

const NOW = new Date('2026-10-13T05:00:00Z'); // 14:00 JST, Tuesday
const PRICES: Record<string, number> = {
  '7203.T': 3000, 'BTC-USD': 60_000, 'JPY=X': 150, 'GC=F': 3000,
};

function storage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); },
  };
}

function candle(symbol: string, close = PRICES[symbol]): Candle {
  return {
    time: Math.floor(Date.now() / 1000) - 60,
    open: close, high: close, low: close, close,
    volume: 100,
  };
}

function fakeFeed() {
  const listeners = new Map<string, (candle: Candle) => void>();
  const subscribe = vi.fn((symbol: string, _interval: string, listener: (value: Candle) => void) => {
    listeners.set(symbol, listener);
    return () => { if (listeners.get(symbol) === listener) listeners.delete(symbol); };
  });
  const feed: Datafeed = {
    name: 'Fake Yahoo',
    subscribe,
    getHistory: vi.fn(async (symbol) => [candle(symbol)]),
    refreshQuotes: vi.fn(async () => {
      for (const [symbol, listener] of [...listeners]) listener(candle(symbol));
    }),
  };
  return { feed, listeners, subscribe };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal('localStorage', storage());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Excel shared paper engine market bridge', () => {
  it('seeds Toyota and USD/JPY independently of the chart and makes a paper order', async () => {
    const { feed, listeners } = fakeFeed();
    const bridge = new ExcelPaperMarketBridge(feed);
    expect([...listeners.keys()]).toEqual(['7203.T', 'JPY=X']);
    await Promise.resolve();
    expect(bridge.getQuote('7203.T')?.source).toBe('Yahoo Japan');
    const order = bridge.engine.submit({ symbol: '7203.T', type: 'market', side: 'buy', volume: 100 });
    expect(order.status).toBe('filled');
    expect(bridge.engine.getAccount('7203.T').usedMargin).toBe(2000);
    bridge.dispose();
    expect(listeners.size).toBe(0);
  });

  it('trades 0.001 BTC and drops unused FX feed after a symbol change', async () => {
    const { feed, listeners } = fakeFeed();
    const bridge = new ExcelPaperMarketBridge(feed);
    bridge.setSymbol('BTC-USD');
    await Promise.resolve();
    expect([...listeners.keys()]).toEqual(['BTC-USD']);
    const order = bridge.engine.submit({ symbol: 'BTC-USD', side: 'buy', type: 'market', volume: 0.001 });
    expect(order.status).toBe('filled');
    expect(bridge.engine.getAccount('BTC-USD').usedMargin).toBe(60);
    expect(bridge.engine.closePosition(bridge.engine.getPositions()[0].id)).toBe(true);
    bridge.dispose();
  });

  it('keeps quotes and FX conversion for opened positions after changing chart symbols', async () => {
    const { feed, listeners } = fakeFeed();
    const bridge = new ExcelPaperMarketBridge(feed);
    await Promise.resolve();
    expect(bridge.engine.submit({ symbol: '7203.T', side: 'buy', type: 'market', volume: 100 }).status).toBe('filled');
    bridge.setSymbol('BTC-USD');
    await Promise.resolve();
    expect([...listeners.keys()]).toEqual(['7203.T', 'JPY=X', 'BTC-USD']);
    listeners.get('7203.T')!(candle('7203.T', 3001));
    expect(bridge.engine.getAccount('7203.T').unrealizedPnl).toBeCloseTo(100 / 150);
    expect(bridge.engine.closeAll()).toBe(1);
    expect([...listeners.keys()]).toEqual(['BTC-USD']);
    bridge.dispose();
  });

  it('retains working gold orders across selection changes and cancels them', async () => {
    const { feed, listeners } = fakeFeed();
    const bridge = new ExcelPaperMarketBridge(feed);
    bridge.setSymbol('GC=F');
    const order = bridge.engine.submit({
      symbol: 'GC=F', side: 'buy', type: 'limit', price: 2000, volume: 1,
    });
    expect(order.status).toBe('working');
    bridge.setSymbol('BTC-USD');
    expect(listeners.has('GC=F')).toBe(true);
    expect(bridge.engine.cancelOrder(order.id)).toBe(true);
    expect(listeners.has('GC=F')).toBe(false);
    bridge.dispose();
  });

  it('restores positions from storage after add-in reload and tracks the symbol', async () => {
    const firstFeed = fakeFeed();
    const first = new ExcelPaperMarketBridge(firstFeed.feed);
    first.setSymbol('BTC-USD');
    await Promise.resolve();
    expect(first.engine.submit({ symbol: 'BTC-USD', side: 'buy', type: 'market', volume: 0.001 }).status).toBe('filled');
    first.dispose();
    const secondFeed = fakeFeed();
    const second = new ExcelPaperMarketBridge(secondFeed.feed);
    expect(second.engine.getPositions()).toHaveLength(1);
    expect(secondFeed.listeners.has('BTC-USD')).toBe(true);
    second.dispose();
  });
});
