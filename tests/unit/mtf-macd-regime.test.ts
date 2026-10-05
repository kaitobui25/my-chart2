import { describe, expect, it } from 'vitest';

import { aggregateCandles } from '../../src/candle-aggregation';
import type { Candle, LinePoint } from '../../src/core/types';
import {
  MTF_TIMEFRAMES,
  computeMtfTriggers,
  computeRegime,
  projectConfirmedMacdHistogram,
  type MtfHistogramMap,
  type MtfTimeframe,
} from '../../src/indicators/custom/mtf-macd-regime';
import { macd } from '../../src/indicators';

const utc = (value: string): number => Math.floor(Date.parse(value) / 1000);

function makeCandles(count: number, stepSeconds: number, start = utc('2026-08-03T00:00:00Z')): Candle[] {
  const candles: Candle[] = [];
  let previousClose = 100;
  for (let index = 0; index < count; index++) {
    const open = previousClose;
    const change = Math.sin(index / 5) * 0.7 + ((index % 7) - 3) * 0.08;
    const close = open + change;
    candles.push({
      time: start + index * stepSeconds,
      open,
      high: Math.max(open, close) + 0.3,
      low: Math.min(open, close) - 0.3,
      close,
      volume: 100 + index,
    });
    previousClose = close;
  }
  return candles;
}

function histogramMap(values: Partial<Record<MtfTimeframe, LinePoint[]>>): MtfHistogramMap {
  const length = Math.max(...Object.values(values).map((series) => series?.length ?? 0), 0);
  return Object.fromEntries(
    MTF_TIMEFRAMES.map((timeframe) => [
      timeframe,
      values[timeframe] ?? new Array<LinePoint>(length).fill(null),
    ]),
  ) as MtfHistogramMap;
}

describe('MTF MACD Regime calculations', () => {
  it('aligns base-timeframe MACD to the original candle indices', () => {
    const candles = makeCandles(90, 5 * 60);

    expect(projectConfirmedMacdHistogram(candles, '5m', '5m', 12, 26, 9))
      .toEqual(macd(candles, 12, 26, 9).histogram);
  });

  it('projects only the previously closed HTF bucket and stays stable while the current bucket grows', () => {
    const completedHours = makeCandles(36 * 12, 5 * 60);
    const partialHour = makeCandles(6, 5 * 60, completedHours[completedHours.length - 1].time + 5 * 60);
    const initial = [...completedHours, ...partialHour];
    const appended = makeCandles(5, 5 * 60, partialHour[partialHour.length - 1].time + 5 * 60);
    const extended = [...initial, ...appended];

    const before = projectConfirmedMacdHistogram(initial, '5m', '1h', 12, 26, 9);
    const after = projectConfirmedMacdHistogram(extended, '5m', '1h', 12, 26, 9);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(before.some((value) => value !== null)).toBe(true);

    const aggregated = aggregateCandles(initial, '1h');
    const aggregatedHistogram = macd(aggregated, 12, 26, 9).histogram;
    expect(before[before.length - 1]).toBe(aggregatedHistogram[aggregatedHistogram.length - 2]);
  });

  it('returns unavailable values when the target timeframe is below the base timeframe', () => {
    const candles = makeCandles(90, 15 * 60);

    expect(projectConfirmedMacdHistogram(candles, '15m', '5m'))
      .toEqual(new Array<LinePoint>(candles.length).fill(null));
  });

  it('does not fabricate a higher timeframe when source candles cross target bucket boundaries', () => {
    const candles = makeCandles(90, 3 * 60);

    expect(projectConfirmedMacdHistogram(candles, '3m', '5m'))
      .toEqual(new Array<LinePoint>(candles.length).fill(null));
  });

  it('requires two valid HTF votes and does not treat warmup nulls as a regime', () => {
    expect(computeRegime([-1, null, null])).toBe('neutral');
    expect(computeRegime([-1, -0.5, null])).toBe('bearish');
    expect(computeRegime([1, 0.5, -1])).toBe('bullish');
    expect(computeRegime([1, -1, 0])).toBe('neutral');
  });

  it('arms a short setup only when bearish HTF and a bullish LTF pullback coexist', () => {
    const state = computeMtfTriggers(histogramMap({
      '5m': [1, 1],
      '15m': [-1, -1],
      '1h': [1, -1],
      '2h': [-1, -1],
      '4h': [0, 1],
    }), 'early');

    expect(state.regimes).toEqual(['neutral', 'bearish']);
    expect(state.shortArmed).toEqual([false, true]);
    expect(state.triggers).toEqual([null, null]);
  });

  it('waits through a bullish pullback, triggers confirmed short on 15m resync, then does not spam', () => {
    const state = computeMtfTriggers(histogramMap({
      '5m': [-1, 1, -1, -1, -1],
      '15m': [-1, 1, 1, -1, -1],
      '1h': [-1, -1, -1, -1, -1],
      '2h': [-1, -1, -1, -1, -1],
      '4h': [-1, -1, -1, -1, -1],
    }), 'confirmed');

    expect(state.shortArmed).toEqual([false, true, true, false, false]);
    expect(state.triggers).toEqual([null, null, null, 'SHORT_TRIGGER', null]);
  });

  it('early mode emits only one short trigger while the same 15m pullback remains active', () => {
    const state = computeMtfTriggers(histogramMap({
      '5m': [-1, 1, -1, 1, -1],
      '15m': [-1, 1, 1, 1, 1],
      '1h': [-1, -1, -1, -1, -1],
      '2h': [-1, -1, -1, -1, -1],
      '4h': [-1, -1, -1, -1, -1],
    }), 'early');

    expect(state.triggers).toEqual([null, null, 'SHORT_TRIGGER', null, null]);
  });

  it('cancels an armed short when the bearish HTF regime is lost before resynchronization', () => {
    const state = computeMtfTriggers(histogramMap({
      '5m': [-1, 1, 1, -1],
      '15m': [-1, -1, -1, -1],
      '1h': [-1, -1, 1, -1],
      '2h': [-1, -1, -1, -1],
      '4h': [-1, -1, 1, 1],
    }), 'early');

    expect(state.shortArmed[1]).toBe(true);
    expect(state.regimes[2]).not.toBe('bearish');
    expect(state.shortArmed[2]).toBe(false);
    expect(state.triggers[3]).toBeNull();
  });

  it('mirrors the confirmed setup and trigger rules for long signals', () => {
    const state = computeMtfTriggers(histogramMap({
      '5m': [1, -1, 1, 1, 1],
      '15m': [1, -1, -1, 1, 1],
      '1h': [1, 1, 1, 1, 1],
      '2h': [1, 1, 1, 1, 1],
      '4h': [1, 1, 1, 1, 1],
    }), 'confirmed');

    expect(state.longArmed).toEqual([false, true, true, false, false]);
    expect(state.triggers).toEqual([null, null, null, 'LONG_TRIGGER', null]);
  });
});
