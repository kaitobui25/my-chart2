import type { Candle } from '../../src/core/types';
import { builtinIndicators } from '../../src/indicators/builtin/all';
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
  const definition = definitions.get(id);
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

  const paramDefs = new Map((definition.params ?? []).map((param) => [param.key, param]));
  const effectiveParams = defaultParams(definition);
  for (const [key, value] of Object.entries(params)) {
    const param = paramDefs.get(key);
    if (!param) throw new Error(`Unknown indicator parameter: ${key}`);
    validateParam(param, value);
    effectiveParams[key] = value;
  }

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
