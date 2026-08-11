import { registerIndicator, type IndicatorDef } from './registry';
import bollinger from './builtin/bollinger';
import ema from './builtin/ema';
import macd from './builtin/macd';
import pe from './builtin/pe';
import rsi from './builtin/rsi';
import sma from './builtin/sma';
import { indicators as taSuite } from './builtin/ta-suite';
import visibleRangeExtrema from './builtin/visible-range-extrema';
import volume from './builtin/volume';

/**
 * Built-ins are imported explicitly so the public bundle always contains the
 * full indicator registry. Local custom indicators remain auto-discovered.
 */
const builtins: IndicatorDef[] = [
  sma,
  ema,
  bollinger,
  visibleRangeExtrema,
  volume,
  pe,
  rsi,
  macd,
  ...taSuite,
];

const modules = import.meta.glob('./custom/*.ts', { eager: true }) as Record<
  string,
  { default?: IndicatorDef; indicators?: IndicatorDef[] }
>;

/**
 * Register every bundled and locally discovered indicator.
 *
 * The registry is a Map, so registering again is idempotent. Avoid keeping a
 * separate "registered" flag here: during HMR this module and the registry can
 * be replaced independently, leaving the flag set while the registry is empty.
 */
export function registerAllIndicators(): void {
  for (const def of builtins) registerIndicator(def);

  for (const mod of Object.values(modules)) {
    const def = mod.default;
    if (def && typeof def.id === 'string' && typeof def.create === 'function') {
      registerIndicator(def);
    }
    for (const item of mod.indicators ?? []) {
      if (item && typeof item.id === 'string' && typeof item.create === 'function') {
        registerIndicator(item);
      }
    }
  }
}
