import type { IndicatorAppearance } from '../../src/library';
import {
  defaultParams,
  type IndicatorDef,
  type Params,
} from '../../src/indicators/registry';
import { excelStealthTheme } from './stealth-preset';

export const INDICATOR_STYLE_KEYS = {
  display: '__display',
  lineStyle: '__lineStyle',
  lineWidth: '__lineWidth',
  opacity: '__opacity',
  color1: '__color1',
  color2: '__color2',
  color3: '__color3',
} as const;

export function indicatorStyleDefaults(id?: string): Params {
  return {
    [INDICATOR_STYLE_KEYS.display]: 'line',
    [INDICATOR_STYLE_KEYS.lineStyle]: 'solid',
    [INDICATOR_STYLE_KEYS.lineWidth]: 1.8,
    [INDICATOR_STYLE_KEYS.opacity]: 100,
    [INDICATOR_STYLE_KEYS.color1]: id === 'volume' ? excelStealthTheme.up : excelStealthTheme.palette[0],
    [INDICATOR_STYLE_KEYS.color2]: id === 'volume' ? excelStealthTheme.down : excelStealthTheme.palette[1],
    [INDICATOR_STYLE_KEYS.color3]: excelStealthTheme.palette[2],
  };
}

export function defaultIndicatorSettings(def: IndicatorDef): Params {
  return { ...defaultParams(def), ...indicatorStyleDefaults(def.id) };
}

export function mergeIndicatorSettings(def: IndicatorDef, params: Params): Params {
  return { ...defaultIndicatorSettings(def), ...params };
}

export function indicatorAppearanceFromParams(id: string, params: Params): IndicatorAppearance {
  const values = { ...indicatorStyleDefaults(id), ...params };
  const lineStyleValue = String(values[INDICATOR_STYLE_KEYS.lineStyle]);
  return {
    display: values[INDICATOR_STYLE_KEYS.display] === 'area' ? 'area' : 'line',
    lineStyle: lineStyleValue === 'dashed' || lineStyleValue === 'dotted' ? lineStyleValue : 'solid',
    lineWidth: Math.min(5, Math.max(0.5, Number(values[INDICATOR_STYLE_KEYS.lineWidth]) || 1.8)),
    opacity: Math.min(100, Math.max(0, Number(values[INDICATOR_STYLE_KEYS.opacity]) || 0)) / 100,
    colors: [
      String(values[INDICATOR_STYLE_KEYS.color1]),
      String(values[INDICATOR_STYLE_KEYS.color2]),
      String(values[INDICATOR_STYLE_KEYS.color3]),
    ],
  };
}
