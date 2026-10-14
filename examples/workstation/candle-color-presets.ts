import type { Theme } from '../../src/core/types';

export type CandleColors = Pick<Theme, 'up' | 'down' | 'wickUp' | 'wickDown'> & {
  line: string; area: string; hollowUp?: boolean; hollowDown?: boolean;
};
export const CANDLE_COLOR_PRESETS = [
  { id: 'default', label: 'Hiện tại' },
  { id: 'mt5-gray', label: 'Gray · MT5' },
] as const;
export function candleColorPreset(id: string, defaults: CandleColors, dark: boolean): CandleColors {
  if (id !== 'mt5-gray') return { ...defaults, hollowUp: false, hollowDown: false };
  const gray = dark ? '#9ca3af' : '#6b7280';
  return { ...defaults, up: gray, down: gray, wickUp: gray, wickDown: gray, hollowUp: true, hollowDown: false };
}
export function identifyCandleColorPreset(colors: CandleColors, defaults: CandleColors, dark: boolean): string {
  const keys = ['up', 'down', 'wickUp', 'wickDown', 'line', 'area'] as const;
  return CANDLE_COLOR_PRESETS.find(preset => {
    const candidate = candleColorPreset(preset.id, defaults, dark);
    return keys.every(key => colors[key] === candidate[key])
      && !!colors.hollowUp === !!candidate.hollowUp && !!colors.hollowDown === !!candidate.hollowDown;
  })?.id ?? 'custom';
}
