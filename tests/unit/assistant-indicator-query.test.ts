import { describe, expect, it } from 'vitest';
import type { Candle } from '../../src/core/types';
import { bollinger, ema, macd, rsi, sma } from '../../src/indicators';
import { indicators as taSuite } from '../../src/indicators/builtin/ta-suite';
import { queryIndicator } from '../../examples/assistant/indicator-query';

const candles: Candle[] = Array.from({ length: 80 }, (_, index) => {
  const close = 90 + index * 0.7 + Math.sin(index / 4) * 8;
  return {
    time: 1_700_000_000 + index * 3600,
    open: close - 2,
    high: close + 3,
    low: close - 4,
    close,
    volume: 100 + index * 3,
  };
});

function timestamped(values: (number | null)[]): Array<{ time: number; value: number | null }> {
  return values.map((value, index) => ({ time: candles[index].time, value }));
}

describe('assistant indicator queries', () => {
  it('uses indicator defaults and the same computations as the chart', () => {
    const smaResult = queryIndicator({ id: 'sma', candles });
    expect(smaResult.params).toEqual({ length: 20, source: 'close' });
    expect(smaResult.formula).toContain('SMA');
    expect(smaResult.values.SMA).toEqual(timestamped(sma(candles, 20)));

    expect(queryIndicator({ id: 'ema', candles }).values.EMA)
      .toEqual(timestamped(ema(candles, 50)));
    expect(queryIndicator({ id: 'rsi', candles }).values.RSI)
      .toEqual(timestamped(rsi(candles, 14)));
    expect(queryIndicator({ id: 'macd', candles }).values)
      .toEqual(Object.fromEntries(Object.entries(macd(candles)).map(([key, values]) => [key, timestamped(values)])));
    expect(queryIndicator({ id: 'bollinger', candles }).values)
      .toEqual(Object.fromEntries(Object.entries(bollinger(candles)).map(([key, values]) => [key, timestamped(values)])));
  });

  it('uses overrides and truncates only the returned values to retain warm-up history', () => {
    const result = queryIndicator({ id: 'sma', candles, params: { length: 5, source: 'high' }, limit: 3 });
    expect(result.params).toEqual({ length: 5, source: 'high' });
    expect(result.values.SMA).toEqual(timestamped(sma(candles, 5, 'high')).slice(-3));

    const macdResult = queryIndicator({ id: 'macd', candles, params: { fast: 7, slow: 20, signal: 4 }, limit: 2 });
    const expected = macd(candles, 7, 20, 4);
    for (const [key, values] of Object.entries(expected)) {
      expect(macdResult.values[key]).toEqual(timestamped(values).slice(-2));
    }
    expect(queryIndicator({ id: 'sma', candles: [], limit: 3 }).values.SMA).toEqual([]);
    expect(queryIndicator({ id: 'sma', candles: candles.slice(0, 2), limit: 5 }).values.SMA)
      .toEqual([{ time: candles[0].time, value: null }, { time: candles[1].time, value: null }]);
  });

  it('exposes computed series and formulas for every TA Suite indicator without registration', () => {
    for (const def of taSuite) {
      expect(def.calculate, def.id).toBeTypeOf('function');
      expect(def.formula, def.id).toBeTruthy();
      const result = queryIndicator({ id: def.id, candles, limit: 4 });
      expect(result.formula).toBe(def.formula);
      expect(result.id).toBe(def.id);
      expect(Object.keys(result.values).length).toBeGreaterThan(0);
      for (const series of Object.values(result.values)) {
        expect(series).toHaveLength(4);
        expect(series.map(({ time }) => time)).toEqual(candles.slice(-4).map(({ time }) => time));
        expect(series.every(({ value }) => value === null || Number.isFinite(value))).toBe(true);
      }
    }
  });

  it('rejects unimplemented indicators and invalid parameters', () => {
    expect(() => queryIndicator({ id: 'not-real', candles })).toThrow('Unknown indicator');
    expect(() => queryIndicator({ id: 'volume', candles })).toThrow('does not support');
    for (const params of [
      { length: 0 }, { length: 5001 }, { length: 2.5 }, { length: NaN },
      { length: Infinity }, { length: '5' }, { source: 'unknown' }, { noSuchParam: 1 },
    ]) {
      expect(() => queryIndicator({ id: 'sma', candles, params })).toThrow();
    }
    expect(() => queryIndicator({ id: 'sma', candles, params: [] as unknown as Record<string, unknown> }))
      .toThrow('must be an object');
    for (const limit of [0, -1, NaN, Infinity, 1.5]) {
      expect(() => queryIndicator({ id: 'sma', candles, limit })).toThrow('positive integer');
    }
  });

  it('does not mutate input candles or provided parameters', () => {
    const immutableCandles = Object.freeze(candles.map((c) => Object.freeze({ ...c })));
    const params = Object.freeze({ length: 4, source: 'low' });
    const first = queryIndicator({ id: 'sma', candles: immutableCandles, params, limit: 1 });
    const second = queryIndicator({ id: 'sma', candles: immutableCandles, params, limit: 1 });
    expect(second).toEqual(first);
    expect(params).toEqual({ length: 4, source: 'low' });
  });
});
