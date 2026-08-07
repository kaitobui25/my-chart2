import { describe, expect, it } from 'vitest';

import { heikinAshi, heikinAshiCandle } from '../../src/core/heikin-ashi';
import type { Candle } from '../../src/core/types';

const source: Candle[] = [
  { time: 100, open: 10, high: 14, low: 8, close: 12, volume: 100 },
  { time: 160, open: 12, high: 16, low: 10, close: 14, volume: 120 },
  { time: 220, open: 14, high: 15, low: 11, close: 12, volume: 140 },
];

describe('Heikin Ashi', () => {
  it('calculates the first candle and recursive opens correctly', () => {
    expect(heikinAshi(source)).toEqual([
      { time: 100, open: 11, high: 14, low: 8, close: 11, volume: 100 },
      { time: 160, open: 11, high: 16, low: 10, close: 13, volume: 120 },
      { time: 220, open: 12, high: 15, low: 11, close: 13, volume: 140 },
    ]);
  });

  it('matches incremental realtime calculation with a full rebuild', () => {
    const incremental: Candle[] = [];
    for (const candle of source) {
      incremental.push(heikinAshiCandle(candle, incremental[incremental.length - 1]));
    }

    expect(incremental).toEqual(heikinAshi(source));
  });

  it('does not mutate raw market candles', () => {
    const snapshot = structuredClone(source);
    heikinAshi(source);
    expect(source).toEqual(snapshot);
  });
});
