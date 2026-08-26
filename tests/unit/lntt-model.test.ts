import { describe, expect, it } from 'vitest';
import type { Candle } from '../../src/core/types';
import {
  computeLnttPoints,
  lnttDisplayCandleIndex,
  lnttYoyPercent,
  type LnttQuarter,
} from '../../src/indicators/external/lntt-model';

const DAY = 24 * 60 * 60;
const VN_OFFSET = 7 * 60 * 60;

function vnTime(year: number, month: number, day: number, hour = 9, minute = 0): number {
  return Math.floor(Date.UTC(year, month - 1, day, hour, minute) / 1000) - VN_OFFSET;
}

function candle(time: number): Candle {
  return { time, open: 1, high: 1, low: 1, close: 1 };
}

const quarters: LnttQuarter[] = [
  { period: '2025Q2', year: 2025, quarter: 2, profitBeforeTaxVnd: 100_000_000_000 },
  { period: '2026Q2', year: 2026, quarter: 2, profitBeforeTaxVnd: 130_000_000_000 },
];

describe('LNTT model', () => {
  it('calculates YoY and handles missing/zero previous values', () => {
    expect(lnttYoyPercent(130, 100)).toBeCloseTo(30);
    expect(lnttYoyPercent(130, 0)).toBeNull();
    expect(lnttYoyPercent(130, null)).toBeNull();
  });

  it('maps monthly data to the month after the quarter', () => {
    const candles = [
      candle(vnTime(2026, 6, 1)),
      candle(vnTime(2026, 7, 1)),
      candle(vnTime(2026, 8, 3)),
    ];
    expect(lnttDisplayCandleIndex(candles, 2026, 2, 30 * DAY)).toBe(1);
  });

  it('maps weekly data to the last week of the next month', () => {
    const candles = [
      candle(vnTime(2026, 7, 20)),
      candle(vnTime(2026, 7, 27)),
      candle(vnTime(2026, 8, 3)),
    ];
    expect(lnttDisplayCandleIndex(candles, 2026, 2, 7 * DAY)).toBe(1);
  });

  it('maps daily data to Tuesday of the last week of the next month', () => {
    const candles = [
      candle(vnTime(2026, 7, 27)),
      candle(vnTime(2026, 7, 28)),
      candle(vnTime(2026, 7, 29)),
    ];
    expect(lnttDisplayCandleIndex(candles, 2026, 2, DAY)).toBe(1);
  });

  it('maps intraday data to the last candle of that Tuesday', () => {
    const candles = [
      candle(vnTime(2026, 7, 28, 9, 0)),
      candle(vnTime(2026, 7, 28, 10, 0)),
      candle(vnTime(2026, 7, 28, 14, 0)),
      candle(vnTime(2026, 7, 28, 14, 45)),
      candle(vnTime(2026, 7, 29, 9, 0)),
    ];
    expect(lnttDisplayCandleIndex(candles, 2026, 2, 60 * 60)).toBe(3);
  });

  it('handles Q4 rollover into January of the next year', () => {
    const candles = [
      candle(vnTime(2026, 12, 1)),
      candle(vnTime(2027, 1, 4)),
    ];
    expect(lnttDisplayCandleIndex(candles, 2026, 4, 30 * DAY)).toBe(1);
  });

  it('builds percent and billion-VND points without changing the raw data', () => {
    const candles = [candle(vnTime(2026, 7, 28))];
    const percent = computeLnttPoints(candles, quarters, DAY, 'percent');
    const vnd = computeLnttPoints(candles, quarters, DAY, 'vnd');

    expect(percent).toHaveLength(1);
    expect(percent[0]).toMatchObject({ period: '2026Q2', index: 0 });
    expect(percent[0].value).toBeCloseTo(30);
    expect(vnd).toHaveLength(1);
    expect(vnd[0].value).toBe(130);
  });
});
