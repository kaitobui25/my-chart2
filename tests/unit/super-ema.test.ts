import { describe, expect, it } from 'vitest';
import type { Candle } from '../../src/core/types';
import { calculateSuperEma, type EmaOptions } from '../../src/indicators/builtin/super-ema-model';
import { ema } from '../../src/indicators';
import { TimeScale } from '../../src/core/time-scale';

const options: EmaOptions[] = [2, 3, 4, 5].map(length => ({ length, source: 'close', color: '#fff', width: 1, visible: true }));
function bars(values: number[]): Candle[] {
  return values.map((close, i) => ({ time: i * 60, open: close, high: close + 1, low: close - 1, close }));
}
describe('Super EMA', () => {
  it('uses existing EMA values and waits for all four warmups', () => {
    const candles = bars([1, 2, 3, 4, 5, 6, 7]);
    const result = calculateSuperEma(candles, options);
    expect(result.lines[0]).toEqual(ema(candles, 2));
    expect(result.states).toEqual(['warming', 'warming', 'warming', 'warming', 'bull', 'bull', 'bull']);
    expect(result.signals).toEqual([{ index: 4, state: 'bull' }]);
  });
  it('does not confirm the final bar and ignores display visibility', () => {
    const result = calculateSuperEma(bars([5, 4, 3, 2, 1]), options.map(option => ({ ...option, visible: false })));
    expect(result.states[4]).toBe('bear');
    expect(result.signals).toEqual([]);
    expect(calculateSuperEma(bars([5, 4, 3, 2, 1, 0]), options).signals).toEqual([{ index: 4, state: 'bear' }]);
  });
  it('equal lines are neutral; emits again only after leaving alignment', () => {
    expect(calculateSuperEma(bars([1, 1, 1, 1, 1, 1]), options).states[5]).toBe('neutral');
    const result = calculateSuperEma(bars([1, 2, 3, 4, 5, 6, 1, 0, 1, 2, 3, 4, 5, 6, 7]), options);
    expect(result.signals.map(signal => signal.state)).toEqual(['bull', 'bear', 'bull']);
  });
  it('reserves preview space through fit and resize; releases it on removal', () => {
    const scale = new TimeScale(); scale.setWidth(1000); scale.setDataLen(300);
    const release = scale.reserveRightMargin(() => 300);
    scale.fit(); expect(scale.xForIndex(299)).toBe(700);
    scale.setWidth(1200); expect(scale.xForIndex(299)).toBe(900);
    release(); expect(scale.xForIndex(299)).toBe(1120);
  });
});
