import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { instrumentFor, roundToTick, validPrice } from '../../examples/workstation/trading/instruments';
import { MarketHub, PaperTradingEngine, type MarketQuote } from '../../examples/workstation/trading/paper';

const NOW = new Date('2026-10-13T05:00:00.000Z'); // Tuesday, 14:00 JST

function quote(symbol: string, last: number, extras: Partial<MarketQuote> = {}): MarketQuote {
  return {
    symbol, last, bid: last, ask: last, hasBidAsk: false,
    change: 0, changePct: 0, time: Math.floor(Date.now() / 1000),
    source: 'Yahoo Japan', ...extras,
  };
}

function storage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); },
    removeItem: (key: string) => { items.delete(key); },
  };
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

describe('multi-asset paper trading', () => {
  it.each([
    ['7203.T', 2979.500244140625, 2979.5],
    ['BTC-USD', 83557.359375, 83557.36],
    ['JPY=X', 158.29600524902344, 158.296],
    ['GC=F', 4209.7998046875, 4209.8],
  ])('normalizes Yahoo float prices to %s tick size', (symbol, raw, expected) => {
    const spec = instrumentFor(symbol);
    expect(roundToTick(raw, spec)).toBe(expected);
    expect(validPrice(roundToTick(raw, spec), spec)).toBe(true);
  });

  it('trades BTC in increments of 0.001 and computes USD P&L without a global multiplier', () => {
    const hub = new MarketHub();
    const engine = new PaperTradingEngine(hub);
    hub.update(quote('BTC-USD', 60_000));
    expect(engine.submit({ symbol: 'BTC-USD', side: 'buy', type: 'market', volume: 0.0009 }).status).toBe('rejected');
    expect(engine.submit({ symbol: 'BTC-USD', side: 'buy', type: 'market', volume: 0.0015 }).status).toBe('rejected');
    expect(engine.submit({ symbol: 'BTC-USD', side: 'buy', type: 'market', volume: 0.001 }).status).toBe('filled');
    expect(engine.getAccount('BTC-USD').usedMargin).toBeCloseTo(60);
    hub.update(quote('BTC-USD', 60_100));
    expect(engine.getPositions()[0].unrealizedPnl).toBeCloseTo(0.1);
    expect(engine.closePosition(engine.getPositions()[0].id)).toBe(true);
    expect(engine.getAccount('BTC-USD').balance).toBeCloseTo(100_000.1);
    expect(engine.getTrades()[0].pnlCurrency).toBe('USD');
  });

  it('uses a 100-share lot and JPY/USD conversion for Toyota', () => {
    const hub = new MarketHub();
    const engine = new PaperTradingEngine(hub);
    hub.update(quote('JPY=X', 150));
    hub.update(quote('7203.T', 3_000));
    expect(instrumentFor('7203.T').multiplier).toBe(1);
    expect(engine.submit({ symbol: '7203.T', side: 'buy', type: 'market', volume: 1 }).status).toBe('rejected');
    expect(engine.submit({ symbol: '7203.T', side: 'buy', type: 'market', volume: 100 }).status).toBe('filled');
    expect(engine.getAccount('7203.T').usedMargin).toBeCloseTo(2000);
    hub.update(quote('7203.T', 3_001));
    expect(engine.getPositions()[0].unrealizedPnl).toBe(100); // JPY
    expect(engine.getAccount('7203.T').unrealizedPnl).toBeCloseTo(100 / 150);
    engine.closeAll();
    expect(engine.getTrades()[0].pnl).toBe(100);
    expect(engine.getTrades()[0].pnlAccount).toBeCloseTo(100 / 150);
    expect(engine.getTrades()[0].closedAt).toBe(Date.now());
  });

  it('converts USD/JPY forex lot P&L and uses forex margin', () => {
    const hub = new MarketHub();
    const engine = new PaperTradingEngine(hub);
    hub.update(quote('JPY=X', 150));
    expect(engine.submit({ symbol: 'JPY=X', side: 'buy', type: 'market', volume: 0.01 }).status).toBe('filled');
    expect(engine.getAccount('JPY=X').usedMargin).toBeCloseTo(50);
    hub.update(quote('JPY=X', 151));
    expect(engine.getPositions()[0].unrealizedPnl).toBeCloseTo(1000); // JPY
    engine.closeAll();
    expect(engine.getTrades()[0].pnlAccount).toBeCloseTo(1000 / 151);
  });

  it('uses the GC=F futures 100-ounce multiplier', () => {
    const hub = new MarketHub();
    const engine = new PaperTradingEngine(hub);
    hub.update(quote('GC=F', 3000));
    expect(engine.submit({ symbol: 'GC=F', side: 'buy', type: 'market', volume: 1 }).status).toBe('filled');
    expect(engine.getAccount('GC=F').usedMargin).toBeCloseTo(30_000);
    hub.update(quote('GC=F', 3010));
    expect(engine.getPositions()[0].unrealizedPnl).toBe(1000);
  });

  it('rejects market orders with missing FX, stale prices or a closed Japan session', () => {
    const hub = new MarketHub();
    const engine = new PaperTradingEngine(hub);
    hub.update(quote('7203.T', 3000));
    expect(engine.submit({ symbol: '7203.T', side: 'buy', type: 'market', volume: 100 }).message).toContain('JPY=X');
    hub.update(quote('JPY=X', 150));
    vi.advanceTimersByTime(151_000);
    expect(engine.submit({ symbol: '7203.T', side: 'buy', type: 'market', volume: 100 }).status).toBe('rejected');
    vi.setSystemTime(new Date('2026-10-13T08:00:00.000Z')); // 17:00 JST
    hub.update(quote('7203.T', 3000));
    expect(engine.submit({ symbol: '7203.T', side: 'buy', type: 'market', volume: 100 }).status).toBe('rejected');
  });

  it('does not execute OHLC seed prices but fills when a tradable poll arrives', () => {
    const hub = new MarketHub();
    const engine = new PaperTradingEngine(hub);
    hub.update(quote('BTC-USD', 60_000, { tradable: false }));
    const order = engine.submit({ symbol: 'BTC-USD', side: 'buy', type: 'limit', volume: 0.001, price: 60_000 });
    hub.update(quote('BTC-USD', 59_000, { tradable: false }));
    expect(engine.getOrders()[0].status).toBe('working');
    hub.update(quote('BTC-USD', 59_000));
    expect(engine.getOrders()[0].status).toBe('filled');
    expect(engine.getOrders()[0].id).toBe(order.id);
  });

  it('supports replay prices independent of the live market clock', () => {
    const hub = new MarketHub();
    const engine = new PaperTradingEngine(hub);
    hub.lockSource('BTC-USD', 'Replay');
    hub.update(quote('BTC-USD', 30_000, { source: 'Replay', time: 1_700_000_000 }));
    expect(engine.submit({
      symbol: 'BTC-USD', side: 'buy', type: 'market', volume: 0.001, takeProfit: 31_000,
    }).status).toBe('filled');
    hub.update(quote('BTC-USD', 50_000)); // locked out by Replay
    expect(engine.getPositions()[0].currentPrice).toBe(30_000);
    hub.update(quote('BTC-USD', 31_000, { source: 'Replay', time: 1_700_000_060 }));
    expect(engine.getTrades()[0].reason).toBe('take-profit');
    expect(engine.getTrades()[0].closedAt).toBe(1_700_000_060_000);
  });

  it('timestamps a live fill at execution time rather than at the Yahoo daily candle open', () => {
    const hub = new MarketHub();
    const engine = new PaperTradingEngine(hub);
    hub.update(quote('BTC-USD', 60_000, { time: Math.floor(Date.now() / 1000) - 12 * 3600 }));
    expect(engine.submit({ symbol: 'BTC-USD', side: 'buy', type: 'market', volume: 0.001 }).status).toBe('filled');
    expect(engine.getPositions()[0].openedAt).toBe(Date.now());
    expect(engine.getOrders()[0].updatedAt).toBe(Date.now());
  });

  it('does not fill an old Yahoo daily bar merely because polling received it just now', () => {
    const hub = new MarketHub();
    const engine = new PaperTradingEngine(hub);
    hub.update(quote('BTC-USD', 60_000, { time: Math.floor(Date.now() / 1000) - 2 * 86_400 }));
    const order = engine.submit({ symbol: 'BTC-USD', side: 'buy', type: 'market', volume: 0.001 });
    expect(order.status).toBe('rejected');
  });

  it('accounts for configurable spread, slippage and commission', () => {
    const hub = new MarketHub();
    const engine = new PaperTradingEngine(hub, {
      spreadBps: 20, slippageBps: 5, commissionBps: 10,
    });
    hub.update(quote('BTC-USD', 60_000));
    const order = engine.submit({ symbol: 'BTC-USD', side: 'buy', type: 'market', volume: 0.001 });
    const entry = 60_000 * 1.001 * 1.0005;
    expect(order.fillPrice).toBeCloseTo(entry);
    const immediateExit = 60_000 * 0.999 * 0.9995;
    expect(engine.getPositions()[0].unrealizedPnl).toBeCloseTo((immediateExit - entry) * 0.001);
    expect(engine.getAccount('BTC-USD').balance).toBeCloseTo(100_000 - entry * 0.001 * 0.001);
    hub.update(quote('BTC-USD', 61_000));
    engine.closeAll();
    const exit = 61_000 * 0.999 * 0.9995;
    expect(engine.getTrades()[0].pnl).toBeCloseTo(
      (exit - entry) * 0.001 - (entry + exit) * 0.001 * 0.001,
    );
  });

  it('validates tick/quantity changes and ignores quotes without valid bid/ask', () => {
    const hub = new MarketHub();
    const engine = new PaperTradingEngine(hub);
    const order = engine.submit({ symbol: 'JPY=X', side: 'buy', type: 'limit', volume: 0.01, price: 150.001 });
    expect(order.status).toBe('working');
    expect(engine.modifyOrder(order.id, { volume: 0.001 })).toBe(false);
    expect(engine.modifyOrder(order.id, { price: 150.0005 })).toBe(false);
    expect(engine.modifyOrder(order.id, { price: 150.002 })).toBe(true);
    hub.update(quote('JPY=X', 149, { bid: 0, ask: 0, hasBidAsk: true }));
    expect(engine.getOrders()[0].status).toBe('working');
  });

  it('shows unavailable USD account totals when the FX rate becomes stale', () => {
    const hub = new MarketHub();
    const engine = new PaperTradingEngine(hub);
    hub.update(quote('JPY=X', 150));
    hub.update(quote('7203.T', 3000));
    expect(engine.submit({ symbol: '7203.T', side: 'buy', type: 'market', volume: 100 }).status).toBe('filled');
    hub.update(quote('JPY=X', 150, { time: Math.floor(Date.now() / 1000) - 4 * 86_400 }));
    expect(engine.getAccount('7203.T').ready).toBe(false);
    expect(engine.getAccount('7203.T').equity).toBeNull();
    expect(engine.closeAll()).toBe(0);
  });

  it('restores USD positions and account balances from v2 independently of VND', () => {
    const hub = new MarketHub();
    const engine = new PaperTradingEngine(hub);
    hub.update(quote('BTC-USD', 60_000));
    engine.submit({ symbol: 'BTC-USD', side: 'buy', type: 'market', volume: 0.001 });
    hub.update(quote('BTC-USD', 60_100));
    engine.closeAll();
    const restored = new PaperTradingEngine(new MarketHub());
    expect(restored.getAccount('BTC-USD').balance).toBeCloseTo(100_000.1);
    expect(restored.getAccount('FPT').balance).toBe(1_000_000_000);
    expect(restored.getTrades()[0].pnlCurrency).toBe('USD');
  });

  it('migrates old VND positions without changing their multiplier or overwriting v1', () => {
    const oldState = JSON.stringify({
      balance: 900_000_000, orders: [], trades: [],
      positions: [{
        id: 'P-old', symbol: '7203.T', side: 'buy', volume: 100,
        entryPrice: 3000, currentPrice: 3000, unrealizedPnl: 0, openedAt: 1,
      }],
    });
    localStorage.setItem('l2chart.paper.v1', oldState);
    const hub = new MarketHub();
    const engine = new PaperTradingEngine(hub);
    expect(engine.getPositions()[0].instrument?.multiplier).toBe(1000);
    expect(engine.getPositions()[0].instrument?.accountCurrency).toBe('VND');
    expect(engine.getAccount('FPT').balance).toBe(900_000_000);
    expect(localStorage.getItem('l2chart.paper.v1')).toBe(oldState);
    expect(JSON.parse(localStorage.getItem('l2chart.paper.v2')!).version).toBe(2);
  });
});
