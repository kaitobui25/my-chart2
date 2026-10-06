import { describe, expect, it } from 'vitest';
import type { Candle } from '../../src/core/types';
import { calculateSmartMoneyConcepts } from '../../src/indicators/builtin/smart-money-concepts-model';

function candle(
  time: number,
  open: number,
  high: number,
  low: number,
  close: number,
): Candle {
  return { time, open, high, low, close };
}

describe('smart money concepts', () => {
  it('confirms structure breaks and classifies a direction change as CHoCH', () => {
    const data = [
      candle(0, 10, 11, 9, 10),
      candle(1, 12, 13, 10, 11),
      candle(2, 11, 12, 10, 11),
      candle(3, 10, 12, 8, 9),
      candle(4, 9, 10, 9, 10),
      candle(5, 10, 15, 10, 14),
      candle(6, 13, 15, 12, 14),
      candle(7, 8, 9, 7, 7),
    ];

    const result = calculateSmartMoneyConcepts(data, 1, 1);
    const swingEvents = result.structures.filter((event) => event.scope === 'swing');

    expect(swingEvents.map(({ direction, kind }) => [direction, kind])).toEqual([
      ['bullish', 'BOS'],
      ['bearish', 'CHoCH'],
    ]);
  });

  it('keeps active fair value gaps until price fills them', () => {
    const data = [
      candle(0, 9, 10, 8, 9),
      candle(1, 10, 12, 9, 11),
      candle(2, 13, 15, 12, 14),
      candle(3, 14, 16, 13, 15),
      candle(4, 15, 17, 14, 16),
    ];
    const result = calculateSmartMoneyConcepts(data, 1, 1);

    expect(result.fairValueGaps).toContainEqual({
      startIndex: 0,
      endIndex: 4,
      top: 12,
      bottom: 10,
      direction: 'bullish',
    });

    const filled = calculateSmartMoneyConcepts(
      [...data, candle(5, 11, 15, 9, 10)],
      1,
      1,
    );
    expect(filled.fairValueGaps).toHaveLength(0);
  });

  it('labels successive swing pivots relative to the previous high and low', () => {
    const data = [
      candle(0, 9, 10, 8, 9),
      candle(1, 10, 13, 7, 12),
      candle(2, 11, 12, 9, 11),
      candle(3, 12, 14, 10, 13),
      candle(4, 13, 13, 9, 10),
      candle(5, 10, 12, 10, 11),
    ];

    const result = calculateSmartMoneyConcepts(data, 1, 1);

    expect(result.swingPoints.map((point) => point.label)).toContain('HH');
    expect(result.swingPoints.map((point) => point.label)).toContain('HL');
  });

  it('builds a bullish order block from the last opposing candle before a swing break', () => {
    const data = [
      candle(0, 10, 11, 9, 10),
      candle(1, 12, 13, 10, 11),
      candle(2, 11, 12, 10, 11),
      candle(3, 10, 12, 8, 9),
      candle(4, 9, 10, 9, 10),
      candle(5, 10, 15, 10, 14),
    ];

    const result = calculateSmartMoneyConcepts(data, 1, 1);

    expect(result.orderBlocks).toContainEqual({
      startIndex: 3,
      endIndex: 5,
      top: 12,
      bottom: 8,
      direction: 'bullish',
    });
  });
});
