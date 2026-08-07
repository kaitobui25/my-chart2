import type { Candle } from '../../src/core/types';
import { type Datafeed, type HistoryRange } from '../../src/datafeed';
import { estimateIntervalBars, intervalStart, shiftIntervalStart } from '../../src/interval';

/** Deterministic PRNG so the demo renders the same series every load. */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * Offline datafeed: seeded random-walk history plus simulated live ticks.
 * Lets the demo (and tests) run with no network access.
 */
export class SampleDatafeed implements Datafeed {
  readonly name = 'Sample (offline)';

  async getHistory(symbol: string, interval: string, limit = 500, range?: HistoryRange): Promise<Candle[]> {
    const rand = mulberry32(hashCode(symbol + interval));
    const requestedTo = range?.to ?? Math.floor(Date.now() / 1000);
    const end = intervalStart(requestedTo, interval);
    const requestedCount = range ? estimateIntervalBars(range.from, end, interval) : limit;
    const count = Math.max(1, Math.min(limit, requestedCount));
    const start = shiftIntervalStart(end, interval, -(count - 1));

    let price = 100 + rand() * 40000;
    const candles: Candle[] = [];
    for (let i = 0; i < count; i++) {
      const vol = 0.004 + rand() * 0.012;
      const drift = (rand() - 0.492) * vol;
      const open = price;
      const close = open * (1 + drift);
      const high = Math.max(open, close) * (1 + rand() * vol * 0.6);
      const low = Math.min(open, close) * (1 - rand() * vol * 0.6);
      candles.push({
        time: shiftIntervalStart(start, interval, i),
        open,
        high,
        low,
        close,
        volume: (0.2 + rand()) * 1000,
      });
      price = close;
    }
    this.lastBySeries.set(symbol + interval, candles[candles.length - 1]);
    return candles;
  }

  private lastBySeries = new Map<string, Candle>();

  subscribe(symbol: string, interval: string, onCandle: (c: Candle) => void): () => void {
    const key = symbol + interval;
    const timer = setInterval(() => {
      const prev = this.lastBySeries.get(key);
      if (!prev) return;
      const now = Math.floor(Date.now() / 1000);
      const barTime = intervalStart(now, interval);
      const move = prev.close * (Math.random() - 0.5) * 0.002;
      let c: Candle;
      if (barTime > prev.time) {
        c = {
          time: barTime,
          open: prev.close,
          high: Math.max(prev.close, prev.close + move),
          low: Math.min(prev.close, prev.close + move),
          close: prev.close + move,
          volume: Math.random() * 50,
        };
      } else {
        const close = prev.close + move;
        c = {
          ...prev,
          close,
          high: Math.max(prev.high, close),
          low: Math.min(prev.low, close),
          volume: (prev.volume ?? 0) + Math.random() * 10,
        };
      }
      this.lastBySeries.set(key, c);
      onCandle(c);
    }, 400);
    return () => clearInterval(timer);
  }
}
