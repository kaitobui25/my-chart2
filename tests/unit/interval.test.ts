import { describe, expect, it } from 'vitest';

import { aggregateCalendarCandles } from '../../src/calendar-candles';
import { intervalStart, nextIntervalStart, shiftIntervalStart } from '../../src/interval';
import type { Candle } from '../../src/core/types';

const utc = (value: string): number => Math.floor(Date.parse(value) / 1000);

describe('calendar intervals', () => {
  it('anchors weekly candles to Monday in UTC', () => {
    expect(intervalStart(utc('2026-08-07T12:00:00Z'), '1w')).toBe(utc('2026-08-03T00:00:00Z'));
  });

  it('moves monthly boundaries by calendar month including leap February', () => {
    const feb = intervalStart(utc('2028-02-20T12:00:00Z'), '1M');
    expect(feb).toBe(utc('2028-02-01T00:00:00Z'));
    expect(nextIntervalStart(feb, '1M')).toBe(utc('2028-03-01T00:00:00Z'));
    expect(shiftIntervalStart(feb, '1M', -1)).toBe(utc('2028-01-01T00:00:00Z'));
  });

  it('uses Vietnam midnight when an offset is supplied', () => {
    expect(intervalStart(utc('2026-07-31T18:00:00Z'), '1M', 420)).toBe(utc('2026-07-31T17:00:00Z'));
  });

  it('aggregates monthly OHLC and volume without mutating input', () => {
    const source: Candle[] = [
      { time: utc('2026-08-03T00:00:00Z'), open: 10, high: 13, low: 9, close: 12, volume: 100 },
      { time: utc('2026-08-04T00:00:00Z'), open: 12, high: 15, low: 11, close: 14, volume: 120 },
    ];
    const snapshot = structuredClone(source);
    expect(aggregateCalendarCandles(source, '1M')).toEqual([
      { time: utc('2026-08-01T00:00:00Z'), open: 10, high: 15, low: 9, close: 14, volume: 220 },
    ]);
    expect(source).toEqual(snapshot);
  });
});
