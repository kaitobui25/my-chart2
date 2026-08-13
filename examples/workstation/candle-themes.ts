import type { Theme } from '../../src/core/types';

export type CandleThemeId = 'default' | 'cyber';

export type CandleThemeColors = Pick<Theme, 'up' | 'down' | 'wickUp' | 'wickDown'>;

export interface CandleThemePreset {
  id: CandleThemeId;
  label: string;
  darkOnly: boolean;
  colors?: CandleThemeColors;
}

export const CANDLE_THEME_STORAGE_KEY = 'l2chart.candleTheme.v1';

export const CANDLE_THEME_PRESETS: readonly CandleThemePreset[] = [
  {
    id: 'default',
    label: 'Default',
    darkOnly: false,
  },
  {
    id: 'cyber',
    label: 'Cyber',
    darkOnly: true,
    colors: {
      up: '#00D4FF',
      wickUp: '#00D4FF',
      down: '#394150',
      wickDown: '#394150',
    },
  },
] as const;

export function normalizeCandleTheme(value: unknown): CandleThemeId {
  return value === 'cyber' ? 'cyber' : 'default';
}

export function resolveCandleThemeColors(
  id: CandleThemeId,
  darkMode: boolean,
): Partial<CandleThemeColors> {
  const preset = CANDLE_THEME_PRESETS.find((candidate) => candidate.id === id);
  if (!preset?.colors || (preset.darkOnly && !darkMode)) return {};
  return preset.colors;
}

export function applyCandleTheme(base: Theme, id: CandleThemeId, darkMode: boolean): Theme {
  return {
    ...base,
    ...resolveCandleThemeColors(id, darkMode),
  };
}
