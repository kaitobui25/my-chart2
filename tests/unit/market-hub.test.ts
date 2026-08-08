import { describe, expect, it } from 'vitest';

import { MarketHub, type MarketQuote } from '../../examples/workstation/trading/paper';

function quote(source: string, last: number): MarketQuote {
  return {
    symbol: 'BTCUSDT',
    last,
    bid: last,
    ask: last,
    hasBidAsk: false,
    change: 0,
    changePct: 0,
    time: last,
    source,
  };
}

describe('MarketHub source lock', () => {
  it('accepts only the replay source while a symbol is locked', () => {
    const hub = new MarketHub();
    hub.update(quote('Live', 100));
    hub.lockSource('btcusdt', 'Replay');

    hub.update(quote('Live', 110));
    expect(hub.get('BTCUSDT')?.last).toBe(100);

    hub.update(quote('Replay', 101));
    expect(hub.get('BTCUSDT')?.last).toBe(101);

    hub.unlockSource('BTCUSDT', 'Wrong source');
    hub.update(quote('Live', 120));
    expect(hub.get('BTCUSDT')?.last).toBe(101);

    hub.unlockSource('BTCUSDT', 'Replay');
    hub.update(quote('Live', 120));
    expect(hub.get('BTCUSDT')?.last).toBe(120);
  });
});
