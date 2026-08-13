import { describe, expect, it } from 'vitest';

import { darkTheme, lightTheme } from '../../src/core/types';
import {
  applyCandleTheme,
  normalizeCandleTheme,
  resolveCandleThemeColors,
} from '../../examples/workstation/candle-themes';

describe('workstation candle themes', () => {
  it('keeps Default identical to the existing chart theme', () => {
    expect(applyCandleTheme(darkTheme, 'default', true)).toEqual(darkTheme);
    expect(applyCandleTheme(lightTheme, 'default', false)).toEqual(lightTheme);
  });

  it('Cyber overrides only candle body and wick colors in Dark Mode', () => {
    const cyber = applyCandleTheme(darkTheme, 'cyber', true);

    expect(resolveCandleThemeColors('cyber', true)).toEqual({
      up: '#00D4FF',
      wickUp: '#00D4FF',
      down: '#394150',
      wickDown: '#394150',
    });
    expect(cyber.up).toBe('#00D4FF');
    expect(cyber.wickUp).toBe('#00D4FF');
    expect(cyber.down).toBe('#394150');
    expect(cyber.wickDown).toBe('#394150');

    expect(cyber.bg).toBe(darkTheme.bg);
    expect(cyber.grid).toBe(darkTheme.grid);
    expect(cyber.axisBg).toBe(darkTheme.axisBg);
    expect(cyber.text).toBe(darkTheme.text);
    expect(cyber.border).toBe(darkTheme.border);
    expect(cyber.volUp).toBe(darkTheme.volUp);
    expect(cyber.volDown).toBe(darkTheme.volDown);
    expect(cyber.crosshair).toBe(darkTheme.crosshair);
    expect(cyber.palette).toEqual(darkTheme.palette);
  });

  it('does not apply Cyber in Light Mode', () => {
    expect(applyCandleTheme(lightTheme, 'cyber', false)).toEqual(lightTheme);
    expect(resolveCandleThemeColors('cyber', false)).toEqual({});
  });

  it('normalizes unknown persisted values to Default', () => {
    expect(normalizeCandleTheme('cyber')).toBe('cyber');
    expect(normalizeCandleTheme('anything-else')).toBe('default');
    expect(normalizeCandleTheme(null)).toBe('default');
  });
});
