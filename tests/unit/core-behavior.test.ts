import { afterEach, describe, expect, it, vi } from 'vitest';

import { DNSEDatafeed } from '../../examples/providers/dnse';
import { FiinQuantDatafeed } from '../../examples/providers/fiinquant';
import { PriceScale } from '../../src/core/price-scale';
import { TimeScale } from '../../src/core/time-scale';
import type { Candle } from '../../src/core/types';
import { resolvePositionPrices, type ChartDrawing } from '../../src/core/drawings';
import { bollinger, ema, rsi, sma } from '../../src/indicators';

function candles(closes: number[]): Candle[] {
  return closes.map((close, index) => ({
    time: 1_700_000_000 + index * 60,
    open: close - 0.25,
    high: close + 1,
    low: Math.max(0.01, close - 1),
    close,
    volume: 100 + index,
  }));
}

describe('indicator calculations', () => {
  const data = candles([1, 2, 3, 4, 5]);

  it('keeps warm-up slots empty and calculates moving averages', () => {
    expect(sma(data, 3)).toEqual([null, null, 2, 3, 4]);
    expect(ema(data, 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('calculates RSI and Bollinger bands from aligned candle data', () => {
    expect(rsi(data, 2)).toEqual([null, null, 100, 100, 100]);
    const bands = bollinger(data, 3, 2);
    expect(bands.middle).toEqual([null, null, 2, 3, 4]);
    expect(bands.upper[2]).toBeCloseTo(3.632993, 5);
    expect(bands.lower[2]).toBeCloseTo(0.367007, 5);
  });
});

describe('chart scales', () => {
  it('keeps the anchor index stable while zooming and supports horizontal pan', () => {
    const scale = new TimeScale();
    scale.setWidth(800);
    scale.setDataLen(100);
    scale.scrollToEnd();
    const anchorX = 320;
    const anchorBefore = scale.indexForX(anchorX);

    scale.zoom(1.5, anchorX);

    expect(scale.indexForX(anchorX)).toBeCloseTo(anchorBefore, 8);
    const rightBefore = scale.rightIndex;
    scale.scroll(120);
    expect(scale.rightIndex).toBeLessThan(rightBefore);
  });

  it('round-trips prices and handles transformed modes', () => {
    const scale = new PriceScale();
    scale.setHeight(400);
    scale.setRange(10, 20);
    const y = scale.yFor(15);
    expect(scale.priceFor(y)).toBeCloseTo(15, 8);

    scale.setBasePrice(10);
    scale.setMode('percent');
    scale.setRange(10, 20);
    expect(scale.priceFor(scale.yFor(17.5))).toBeCloseTo(17.5, 8);
  });
});

describe('drawing normalization', () => {
  it('keeps long-position target and stop on opposite sides of entry', () => {
    const drawing = {
      tool: 'long-position',
      start: { index: 1, price: 100 },
      end: { index: 4, price: 95 },
      stopPrice: 110,
    } as ChartDrawing;

    const prices = resolvePositionPrices(drawing);

    expect(prices.target).toBeGreaterThan(prices.entry);
    expect(prices.stop).toBeLessThan(prices.entry);
  });
});

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly sent: string[] = [];
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
}

describe('FiinQuant WebSocket authentication', () => {
  afterEach(() => {
    FakeWebSocket.instances.length = 0;
    vi.unstubAllGlobals();
  });

  it('keeps the token out of the URL and subscribes only after authentication', () => {
    vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:53173' } });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const connected = vi.fn();
    const feed = new FiinQuantDatafeed('/fiinquant-api', 'secret-token');
    feed.onRealtimeConnected(connected);

    feed.subscribe('ssi', '1m', vi.fn());
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();
    const url = new URL(socket.url);
    expect(url.search).toBe('');
    expect(socket.url).not.toContain('secret-token');

    socket.open();
    expect(socket.sent.map((item) => JSON.parse(item))).toEqual([
      { action: 'authenticate', token: 'secret-token' },
    ]);
    expect(connected).not.toHaveBeenCalled();

    socket.receive({ type: 'authenticated' });
    expect(socket.sent.map((item) => JSON.parse(item))).toEqual([
      { action: 'authenticate', token: 'secret-token' },
      {
        action: 'subscribe',
        subscriptions: [{ symbol: 'SSI', interval: '1m' }],
      },
    ]);
    expect(connected).toHaveBeenCalledOnce();
    feed.dispose();
  });
});

describe('DNSE WebSocket proxy URLs', () => {
  afterEach(() => {
    FakeWebSocket.instances.length = 0;
    vi.unstubAllGlobals();
  });

  it('resolves a relative proxy base to the current WebSocket origin', () => {
    vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:53173' } });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const feed = new DNSEDatafeed({
      apiKey: 'fixture-id', // pragma: allowlist secret
      apiSecret: 'fixture-signing-material', // pragma: allowlist secret
      restBase: '/dnse-api',
      wsBase: '/dnse-ws',
    });

    feed.subscribe('HPG', '1m', vi.fn());
    const socket = FakeWebSocket.instances[0];

    expect(socket.url).toBe('ws://127.0.0.1:53173/dnse-ws/v1/stream?encoding=json');
    feed.dispose();
  });
});
