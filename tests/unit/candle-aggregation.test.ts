import { describe, expect, it } from 'vitest';

import { aggregateCandles, mergeCandleIntoInterval } from '../../src/candle-aggregation';
import type { Candle } from '../../src/core/types';

const utc = (value: string): number => Math.floor(Date.parse(value) / 1000);

describe('candle aggregation', () => {
  it('builds a partial 1h candle only from source candles already revealed', () => {
    const source: Candle[] = [
      { time: utc('2026-08-07T10:00:00Z'), open: 100, high: 101, low: 99, close: 100 },
      { time: utc('2026-08-07T10:15:00Z'), open: 100, high: 105, low: 98, close: 104 },
      { time: utc('2026-08-07T10:30:00Z'), open: 104, high: 130, low: 103, close: 125 },
    ];

    expect(aggregateCandles(source.slice(0, 2), '1h')).toEqual([
      { time: utc('2026-08-07T10:00:00Z'), open: 100, high: 105, low: 98, close: 104 },
    ]);
  });

  it('updates the open bucket in O(1) and appends when the target bucket changes', () => {
    const first = mergeCandleIntoInterval(
      null,
      { time: utc('2026-08-07T10:00:00Z'), open: 10, high: 12, low: 9, close: 11, volume: 5 },
      '1h',
    );
    const second = mergeCandleIntoInterval(
      first.candle,
      { time: utc('2026-08-07T10:15:00Z'), open: 11, high: 14, low: 10, close: 13, volume: 7 },
      '1h',
    );
    const nextHour = mergeCandleIntoInterval(
      second.candle,
      { time: utc('2026-08-07T11:00:00Z'), open: 13, high: 15, low: 12, close: 14, volume: 3 },
      '1h',
    );

    expect(first.appended).toBe(true);
    expect(second).toEqual({
      appended: false,
      candle: { time: utc('2026-08-07T10:00:00Z'), open: 10, high: 14, low: 9, close: 13, volume: 12 },
    });
    expect(nextHour.appended).toBe(true);
    expect(nextHour.candle.time).toBe(utc('2026-08-07T11:00:00Z'));
  });

  it('keeps calendar month boundaries in Vietnam time', () => {
    const source: Candle[] = [
      { time: utc('2026-07-31T17:00:00Z'), open: 10, high: 11, low: 9, close: 10 },
      { time: utc('2026-08-01T17:00:00Z'), open: 10, high: 12, low: 9, close: 11 },
    ];
    expect(aggregateCandles(source, '1M', 420)[0].time).toBe(utc('2026-07-31T17:00:00Z'));
  });
});
