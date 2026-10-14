import { describe, expect, it } from 'vitest';
import type { Candle } from '../../src/core/types';
import { calculateDarvasBoxes } from '../../src/indicators/builtin/darvas-box-model';

const start = 1_700_000_000;
const bar = (index: number, high: number, low: number, close: number): Candle => ({
  time: start + index * 900,
  open: close,
  high,
  low,
  close,
});

const consolidation: Candle[] = [
  bar(0, 10, 8, 9),
  bar(1, 11, 9, 10),
  bar(2, 14, 10, 12),
  bar(3, 12, 9, 11),
  bar(4, 10, 7, 8),
  bar(5, 11, 9, 10),
  bar(6, 13, 10, 13),
  bar(7, 15, 12, 15),
];

describe('Darvas box formation', () => {
  it('waits for confirmed high and low pivots, then colors a closed-candle breakout', () => {
    expect(calculateDarvasBoxes(consolidation.slice(0, 5), 1, 900)).toHaveLength(0);
    expect(calculateDarvasBoxes(consolidation.slice(0, 6), 1, 900)).toEqual([{
      startIndex: 2, endIndex: 5, top: 14, bottom: 7, state: 'forming',
    }]);
    expect(calculateDarvasBoxes(consolidation.slice(0, 7), 1, 900)[0].state).toBe('forming');
    expect(calculateDarvasBoxes(consolidation, 1, 900)).toEqual([{
      startIndex: 2, endIndex: 7, top: 14, bottom: 7, state: 'bull',
    }]);
  });

  it('does not pair a pivot from before a long holiday with a newly confirmed pivot', () => {
    const candles = consolidation.slice(0, 6).map(candle => ({ ...candle }));
    candles[4].time += 4 * 86400;
    candles[5].time += 4 * 86400;
    expect(calculateDarvasBoxes(candles, 1, 900)).toEqual([]);
  });

  it('does not pair yesterday\'s intraday low with today\'s high after an overnight gap', () => {
    const candles = consolidation.slice(0, 6).map(candle => ({ ...candle }));
    candles[4].time += 18 * 3600;
    candles[5].time += 18 * 3600;
    expect(calculateDarvasBoxes(candles, 1, 900)).toEqual([]);
  });

  it('allows hourly pivots to form a box across a multi-session gap', () => {
    const candles = consolidation.slice(0, 6).map((candle, index) => ({
      ...candle,
      time: start + index * 3600 + (index >= 4 ? 40 * 3600 : 0),
    }));
    expect(calculateDarvasBoxes(candles, 1, 3600)).toEqual([{
      startIndex: 2, endIndex: 5, top: 14, bottom: 7, state: 'forming',
    }]);
  });

  it('does not count an intrabar wick as a breakout', () => {
    const candles = consolidation.slice(0, 7);
    candles.push(bar(7, 15, 10, 13));
    expect(calculateDarvasBoxes(candles, 1, 900)[0].state).toBe('forming');
  });

  it('freezes a bearish box on the first close below its floor', () => {
    const candles = [...consolidation.slice(0, 7), bar(7, 10, 6, 6), bar(8, 9, 5, 7)];
    expect(calculateDarvasBoxes(candles, 1, 900)[0]).toEqual({
      startIndex: 2, endIndex: 7, top: 14, bottom: 7, state: 'bear',
    });
  });

  it('keeps a finished box gray when a breakout has below-average volume', () => {
    const warmup = Array.from({ length: 20 }, (_, i) => ({ ...bar(i, 10, 8, 9), volume: 100 }));
    const sequence = consolidation.map((c, i) => ({ ...c, time: start + (i + 20) * 900, volume: i === 7 ? 50 : 100 }));
    const boxes = calculateDarvasBoxes([...warmup, ...sequence], 1, 900);
    expect(boxes[boxes.length - 1]).toMatchObject({ top: 14, bottom: 7, state: 'weak' });
  });

  it('does not classify an absent zero-volume feed value as a weak breakout', () => {
    const warmup = Array.from({ length: 20 }, (_, i) => ({ ...bar(i, 10, 8, 9), volume: 100 }));
    const sequence = consolidation.map((c, i) => ({
      ...c, time: start + (i + 20) * 900, volume: i === 7 ? 0 : 100,
    }));
    const boxes = calculateDarvasBoxes([...warmup, ...sequence], 1, 900);
    expect(boxes[boxes.length - 1]).toMatchObject({ top: 14, bottom: 7, state: 'bull' });
  });

  it('does not bypass volume confirmation when previous candles have missing volume', () => {
    const warmup = Array.from({ length: 20 }, (_, i) => ({
      ...bar(i, 10, 8, 9), volume: i % 7 === 0 ? 0 : 100,
    }));
    const sequence = consolidation.map((c, i) => ({
      ...c, time: start + (i + 20) * 900, volume: i === 7 ? 50 : 100,
    }));
    const boxes = calculateDarvasBoxes([...warmup, ...sequence], 1, 900);
    expect(boxes[boxes.length - 1]).toMatchObject({ top: 14, bottom: 7, state: 'weak' });
  });

  it('does not reuse pivots confirmed after their previous box has broken', () => {
    const candles = Array.from({ length: 22 }, (_, i) => bar(i, 11, 9, 10));
    candles[3] = bar(3, 14, 9, 10);
    candles[7] = bar(7, 11, 7, 10);
    candles[11] = bar(11, 11, 5, 10);
    candles[12] = bar(12, 16, 9, 15); // Closes the first box; pivots 11/12 confirm later.
    candles[17] = bar(17, 20, 9, 10);

    expect(calculateDarvasBoxes(candles, 3, 900)).toEqual([{
      startIndex: 3, endIndex: 12, top: 14, bottom: 7, state: 'bull',
    }]);
  });
});
