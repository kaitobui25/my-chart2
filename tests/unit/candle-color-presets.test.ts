import { describe, expect, it } from 'vitest';
import { darkTheme, lightTheme } from '../../src/core/types';
import { candleColorPreset, identifyCandleColorPreset } from '../../examples/workstation/candle-color-presets';

describe('Candle color presets', () => {
  it.each([true, false])('keeps defaults and creates hollow gray candles for dark=%s', dark => {
    const theme = dark ? darkTheme : lightTheme;
    const defaults = { up: theme.up, down: theme.down, wickUp: theme.wickUp, wickDown: theme.wickDown, line: theme.palette[0], area: theme.palette[0] };
    expect(identifyCandleColorPreset(defaults, defaults, dark)).toBe('default');
    const gray = candleColorPreset('mt5-gray', defaults, dark);
    expect(gray.up).toBe(gray.down);
    expect(gray.wickUp).toBe(gray.up);
    expect(gray.hollowUp).toBe(true);
    expect(gray.hollowDown).toBe(false);
    expect(identifyCandleColorPreset(gray, defaults, dark)).toBe('mt5-gray');
    expect(identifyCandleColorPreset({ ...gray, up: '#123456' }, defaults, dark)).toBe('custom');
    expect(candleColorPreset('default', defaults, dark).hollowUp).toBe(false);
    expect(defaults).not.toHaveProperty('hollowUp');
  });
});
