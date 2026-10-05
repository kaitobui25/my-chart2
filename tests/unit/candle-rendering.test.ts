import { describe, expect, it } from 'vitest';

import {
  candleBodyWidth,
  candleOpacity,
  defaultCandleRenderingOptions,
  normalizeCandleRenderingOptions,
} from '../../src/core/candle-rendering';
import { CandleSeries } from '../../src/core/series';

describe('candle rendering options', () => {
  it('preserves the legacy rendering defaults', () => {
    const options = normalizeCandleRenderingOptions();
    expect(options).toEqual(defaultCandleRenderingOptions);
    expect(candleBodyWidth(8, options)).toBe(5);
    expect(candleOpacity(10, null, options)).toBe(1);
  });

  it('keeps body widths bounded and pixel-crisp', () => {
    const options = normalizeCandleRenderingOptions({
      bodyWidthRatio: 0.4,
      minBodyWidth: 1,
      maxBodyWidth: 3,
    });

    expect(candleBodyWidth(1, options)).toBe(1);
    expect(candleBodyWidth(8, options)).toBe(3);
    expect(candleBodyWidth(80, options)).toBe(3);
    const fixedEven = normalizeCandleRenderingOptions({ minBodyWidth: 4, maxBodyWidth: 4 });
    expect(candleBodyWidth(8, fixedEven)).toBe(4);
  });

  it('applies focus opacity only inside the configured bar radius', () => {
    const options = normalizeCandleRenderingOptions({
      baseOpacity: 0.18,
      focusOpacity: 0.72,
      focusRadius: 2,
    });

    expect(candleOpacity(7, 10, options)).toBe(0.18);
    expect(candleOpacity(8, 10, options)).toBe(0.72);
    expect(candleOpacity(12, 10, options)).toBe(0.72);
    expect(candleOpacity(13, 10, options)).toBe(0.18);
    expect(candleOpacity(10, 10, { ...options, focusRadius: 0 })).toBe(0.72);
    expect(candleOpacity(11, 10, { ...options, focusRadius: 0 })).toBe(0.18);
  });

  it('detects whether a candle series actually needs focus-driven main redraws', () => {
    expect(new CandleSeries(() => []).usesFocusLens()).toBe(false);
    const focused = new CandleSeries(() => [], { baseOpacity: 0.2, focusOpacity: 0.8 });
    expect(focused.usesFocusLens()).toBe(true);
    focused.mode = 'line';
    expect(focused.usesFocusLens()).toBe(false);
  });

  it('normalizes invalid numeric configuration safely', () => {
    const options = normalizeCandleRenderingOptions({
      bodyWidthRatio: Number.NaN,
      minBodyWidth: 0,
      maxBodyWidth: -1,
      baseOpacity: -2,
      focusOpacity: 4,
      focusRadius: -3,
    });

    expect(options.bodyWidthRatio).toBe(defaultCandleRenderingOptions.bodyWidthRatio);
    expect(options.minBodyWidth).toBe(1);
    expect(options.maxBodyWidth).toBe(defaultCandleRenderingOptions.maxBodyWidth);
    expect(options.baseOpacity).toBe(0);
    expect(options.focusOpacity).toBe(1);
    expect(options.focusRadius).toBe(0);
  });

});
