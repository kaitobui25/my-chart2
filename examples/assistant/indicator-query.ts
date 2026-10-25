import type { Candle } from '../../src/core/types';
import { builtinIndicators } from '../../src/indicators/builtin/all';
import nikkei225 from '../../src/indicators/external/nikkei-225';
import { defaultParams, type ParamDef, type Params } from '../../src/indicators/registry';

export interface IndicatorQueryArgs {
  id: string;
  params?: Record<string, unknown>;
  candles: readonly Candle[];
  limit?: number;
}

export interface IndicatorQueryResult {
  id: string;
  params: Params;
  formula: string;
  values: Record<string, Array<{ time: number; value: number | null }>>;
}

const definitions = new Map(builtinIndicators.map((definition) => [definition.id, definition]));
definitions.set(nikkei225.id, nikkei225);

export const STRUCTURED_INDICATORS = new Set([
  'darvas-box', 'smart-money-concepts', 'smart-money-concepts-v2', 'smart-money-concepts-v3', 'nikkei-225',
]);

const aliases: Record<string, string> = {
  darvas: 'darvas-box', 'hop-darvas': 'darvas-box',
  smc: 'smart-money-concepts-v3', 'smc-v3': 'smart-money-concepts-v3',
  'smc-v2': 'smart-money-concepts-v2', 'smc-v1': 'smart-money-concepts',
  nikkei: 'nikkei-225', '^n225': 'nikkei-225',
};

export function indicatorId(id: string): string {
  const key = id.trim().toLowerCase();
  return aliases[key] ?? key;
}

export const indicatorCatalog = [...definitions.values()]
  .filter(def => (!!def.calculate && !!def.formula) || STRUCTURED_INDICATORS.has(def.id))
  .map(def => ({ id: def.id, name: def.name }));

export function resolveIndicatorParams(id: string, params: Record<string, unknown> = {}): Params {
  const definition = definitions.get(indicatorId(id));
  if (!definition) throw new Error(`Unknown indicator: ${id}`);
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new Error('Indicator parameters must be an object');
  }
  const paramDefs = new Map((definition.params ?? []).map(param => [param.key, param]));
  const effective = defaultParams(definition);
  for (const [key, value] of Object.entries(params)) {
    const param = paramDefs.get(key);
    if (!param) throw new Error(`Unknown indicator parameter: ${key}`);
    validateParam(param, value);
    effective[key] = value;
  }
  return effective;
}

function validateParam(definition: ParamDef, value: unknown): asserts value is string | number | boolean {
  const { key, type, min, max } = definition;
  if (type === 'int' || type === 'float') {
    if (typeof value !== 'number' || !Number.isFinite(value)
      || (type === 'int' && !Number.isInteger(value))
      || (min !== undefined && value < min)
      || (max !== undefined && value > max)) {
      throw new Error(`Invalid indicator parameter: ${key}`);
    }
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`Invalid indicator parameter: ${key}`);
  } else if (typeof value !== 'string'
    || (type === 'select' && !definition.options?.some((option) => option.value === value))) {
    throw new Error(`Invalid indicator parameter: ${key}`);
  }
}

/** Compute chart-identical, candle-aligned indicator values without chart state or registration. */
export function queryIndicator({ id, params = {}, candles, limit }: IndicatorQueryArgs): IndicatorQueryResult {
  const definition = definitions.get(indicatorId(id));
  if (!definition) throw new Error(`Unknown indicator: ${id}`);
  if (!definition.calculate || !definition.formula) {
    throw new Error(`Indicator does not support data queries: ${id}`);
  }
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new Error('Indicator parameters must be an object');
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error('Indicator limit must be a positive integer');
  }

  const effectiveParams = resolveIndicatorParams(id, params);

  const computed = definition.calculate(candles, effectiveParams);
  const start = limit === undefined ? 0 : Math.max(0, candles.length - limit);
  const values: IndicatorQueryResult['values'] = {};
  for (const [label, series] of Object.entries(computed)) {
    if (series.length !== candles.length) {
      throw new Error(`Indicator output length mismatch: ${id}.${label}`);
    }
    values[label] = series.slice(start).map((value, index) => ({
      time: candles[start + index].time,
      value: value !== null && Number.isFinite(value) ? value : null,
    }));
  }

  return { id: definition.id, params: effectiveParams, formula: definition.formula, values };
}
