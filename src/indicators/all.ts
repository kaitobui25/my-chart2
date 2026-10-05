import { registerIndicator, type IndicatorDef } from './registry';
import { builtinIndicators } from './builtin/all';
import dividend from './external/dividend';
import institutionalFlow from './external/institutional-flow';
import lntt from './external/lntt';
import pe from './external/pe';

/**
 * Bundled indicators are imported explicitly so the public bundle always
 * contains the full indicator registry. Local custom indicators remain auto-discovered.
 */
const bundled: IndicatorDef[] = [
  ...builtinIndicators,
  pe,
  institutionalFlow,
  dividend,
  lntt,
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
  for (const def of bundled) registerIndicator(def);

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
