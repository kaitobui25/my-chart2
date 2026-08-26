import { describe, expect, it } from 'vitest';
import type { Candle } from '../../src/core/types';
import {
  mapDividendEventsToCandles,
  type DividendEvent,
} from '../../src/indicators/external/dividend-model';

const DAY = 24 * 60 * 60;

function vnTime(date: string, hour = 9): number {
  return Math.floor(Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00+07:00`) / 1000);
}

function candle(date: string, hour = 9): Candle {
  return { time: vnTime(date, hour), open: 10, high: 12, low: 9, close: 11 };
}

function event(exDate: string): DividendEvent {
  return {
    exDate,
    cashVndPerShare: 500,
    cashPercent: null,
    stockPercent: null,
    bonusPercent: null,
  };
}

describe('dividend candle mapping', () => {
  it('uses the first intraday candle on the ex-date', () => {
    const candles = [candle('2026-05-11', 9), candle('2026-05-11', 10), candle('2026-05-12', 9)];
    expect(mapDividendEventsToCandles(candles, [event('2026-05-11')], 60 * 60)).toEqual([
      { index: 0, stack: 0, event: event('2026-05-11') },
    ]);
  });

  it('maps daily events only to the matching trading date', () => {
    const candles = [candle('2026-05-11'), candle('2026-05-12')];
    expect(mapDividendEventsToCandles(candles, [event('2026-05-12')], DAY)).toEqual([
      { index: 1, stack: 0, event: event('2026-05-12') },
    ]);
  });

  it('maps an ex-date to its week candle', () => {
    const candles = [candle('2026-05-11'), candle('2026-05-18')];
    expect(mapDividendEventsToCandles(candles, [event('2026-05-15')], 7 * DAY)[0]?.index).toBe(0);
  });

  it('maps ex-dates to their month candle and stacks multiple events in one month', () => {
    const candles = [candle('2026-05-04'), candle('2026-06-01')];
    const events = [event('2026-05-11'), event('2026-05-25'), event('2026-06-10')];
    expect(mapDividendEventsToCandles(candles, events, 30 * DAY).map(({ index, stack }) => ({ index, stack }))).toEqual([
      { index: 0, stack: 0 },
      { index: 0, stack: 1 },
      { index: 1, stack: 0 },
    ]);
  });
});
