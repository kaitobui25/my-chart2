import type { L2Chart } from '../core/chart';

/** Registry shared by bundled and local indicator modules. */

export type IndicatorCategory = 'overlay' | 'oscillator' | 'volume' | 'custom';

export type ParamValue = number | string | boolean;
export type Params = Record<string, ParamValue>;

/** Parameter metadata used to generate indicator settings controls. */
export interface ParamDef {
  key: string;
  label: string;
  type: 'int' | 'float' | 'select';
  default: ParamValue;
  min?: number;
  max?: number;
  step?: number;
  /** Options for `select` parameters. */
  options?: { value: string; label: string }[];
}

/** Lifecycle for an indicator attached to a chart. */
export interface IndicatorInstance {
  /** Recompute values after chart data changes. */
  recompute(): void;
  /** Remove every series created by this indicator. */
  remove(): void;
}

export interface IndicatorDef {
  /** Unique kebab-case identifier, such as `sma` or `bollinger-bands`. */
  id: string;
  /** Display name. */
  name: string;
  category: IndicatorCategory;
  /** Parameters exposed by generated settings controls. */
  params?: ParamDef[];
  /**
   * Create chart series and return their lifecycle object.
   * `params` contains every declared key merged with its default value.
   */
  create(chart: L2Chart, params: Params): IndicatorInstance;
  /** Display order; lower values appear first. */
  order?: number;
}

export function defaultParams(def: IndicatorDef): Params {
  return Object.fromEntries((def.params ?? []).map((p) => [p.key, p.default]));
}

/** Shared source parameter for price-based indicators. */
export const SOURCE_PARAM: ParamDef = {
  key: 'source',
  label: 'Source',
  type: 'select',
  default: 'close',
  options: [
    { value: 'close', label: 'Close' },
    { value: 'open', label: 'Open' },
    { value: 'high', label: 'High' },
    { value: 'low', label: 'Low' },
    { value: 'hl2', label: 'HL2' },
    { value: 'hlc3', label: 'HLC3' },
  ],
};

const registry = new Map<string, IndicatorDef>();

export function registerIndicator(def: IndicatorDef): void {
  if (registry.has(def.id)) {
    console.warn(`[l2chart] indicator "${def.id}" is already registered; replacing it`);
  }
  registry.set(def.id, def);
}

export function getIndicator(id: string): IndicatorDef | undefined {
  return registry.get(id);
}

export function getIndicators(): IndicatorDef[] {
  return [...registry.values()].sort(
    (a, b) => (a.order ?? 100) - (b.order ?? 100) || a.name.localeCompare(b.name),
  );
}
