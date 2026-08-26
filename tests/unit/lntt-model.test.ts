import { describe, expect, it } from 'vitest';
import type { Candle } from '../../src/core/types';
import {
  computeLnttPoints,
  firstCandleIndexForQuarter,
  lnttYoyPercent,
  type LnttQuarter,
} from '../../src/indicators/external/lntt-model';

const DAY = 24 * 60 * 60;
const VN_OFFSET = 7 * 60 * 60;

function vnTime(year: number, month: number, day: number, hour = 9): number {
  return Math.floor(Date.UTC(year, month - 1, day, hour) / 1000) - VN_OFFSET;
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

  it('maps monthly data to the first month of the quarter', () => {
    const candles = [
      candle(vnTime(2026, 3, 2)),
      candle(vnTime(2026, 4, 1)),
      candle(vnTime(2026, 5, 4)),
    ];
    expect(firstCandleIndexForQuarter(candles, 2026, 2, 30 * DAY)).toBe(1);
  });

  it('maps weekly data to the first week intersecting the quarter', () => {
    const candles = [
      candle(vnTime(2026, 3, 30)),
      candle(vnTime(2026, 4, 6)),
    ];
    expect(firstCandleIndexForQuarter(candles, 2026, 2, 7 * DAY)).toBe(0);
  });

  it('maps day and intraday data to the first available candle in the quarter', () => {
    const daily = [
      candle(vnTime(2026, 3, 31)),
      candle(vnTime(2026, 4, 2)),
    ];
    expect(firstCandleIndexForQuarter(daily, 2026, 2, DAY)).toBe(1);

    const hourly = [
      candle(vnTime(2026, 4, 1, 9)),
      candle(vnTime(2026, 4, 1, 10)),
    ];
    expect(firstCandleIndexForQuarter(hourly, 2026, 2, 60 * 60)).toBe(0);
  });

  it('builds percent and billion-VND points without changing the raw data', () => {
    const candles = [candle(vnTime(2026, 4, 1))];
    const percent = computeLnttPoints(candles, quarters, DAY, 'percent');
    const vnd = computeLnttPoints(candles, quarters, DAY, 'vnd');

    expect(percent).toHaveLength(1);
    expect(percent[0]).toMatchObject({ period: '2026Q2', index: 0 });
    expect(percent[0].value).toBeCloseTo(30);
    expect(vnd).toHaveLength(1);
    expect(vnd[0].value).toBe(130);
  });
});
