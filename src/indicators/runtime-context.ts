import { L2Chart } from '../core/chart';

type SymbolListener = (symbol: string) => void;
type ProviderListener = (provider: string) => void;
export type IndicatorRuntimeParamValue = number | string | boolean;
export type IndicatorRuntimeParamPatch = Record<string, IndicatorRuntimeParamValue>;
type ParamPatchListener = (id: string, patch: IndicatorRuntimeParamPatch) => void;

const chartSymbols = new WeakMap<L2Chart, string>();
const chartSymbolListeners = new WeakMap<L2Chart, Set<SymbolListener>>();
const chartProviders = new WeakMap<L2Chart, string>();
const chartProviderListeners = new WeakMap<L2Chart, Set<ProviderListener>>();
const chartParamPatchListeners = new WeakMap<L2Chart, Set<ParamPatchListener>>();
let installed = false;

/**
 * Async indicators need active-instrument/runtime context, while L2Chart
 * intentionally keeps provider concerns outside core. The workstation feeds
 * that context through this adapter rather than forcing provider state into the
 * chart engine itself.
 */
export function installIndicatorRuntimeContextTracking(): void {
  if (installed) return;
  installed = true;

  const originalSetWatermark = L2Chart.prototype.setWatermark;
  L2Chart.prototype.setWatermark = function setTrackedWatermark(text: string): void {
    const symbol = text.trim().toUpperCase();
    const previous = chartSymbols.get(this) ?? '';
    originalSetWatermark.call(this, text);
    chartSymbols.set(this, symbol);
    if (symbol === previous) return;
    for (const listener of chartSymbolListeners.get(this) ?? []) listener(symbol);
  };
}

export function getIndicatorChartSymbol(chart: L2Chart): string {
  return chartSymbols.get(chart) ?? '';
}

export function onIndicatorChartSymbolChange(
  chart: L2Chart,
  listener: SymbolListener,
): () => void {
  let listeners = chartSymbolListeners.get(chart);
  if (!listeners) {
    listeners = new Set();
    chartSymbolListeners.set(chart, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) chartSymbolListeners.delete(chart);
  };
}

/**
 * Set the provider that is actually driving this chart instance. Pass an empty
 * string when market data is disabled. This is deliberately runtime state, not
 * localStorage state: restored workspaces can otherwise make the UI and an
 * async indicator disagree about which provider is active.
 */
export function setIndicatorChartProvider(chart: L2Chart, provider: string): void {
  const normalized = provider.trim().toLowerCase();
  const previous = chartProviders.get(chart) ?? '';
  chartProviders.set(chart, normalized);
  if (normalized === previous) return;
  for (const listener of chartProviderListeners.get(chart) ?? []) listener(normalized);
}

export function getIndicatorChartProvider(chart: L2Chart): string {
  return chartProviders.get(chart) ?? '';
}

export function onIndicatorChartProviderChange(
  chart: L2Chart,
  listener: ProviderListener,
): () => void {
  let listeners = chartProviderListeners.get(chart);
  if (!listeners) {
    listeners = new Set();
    chartProviderListeners.set(chart, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) chartProviderListeners.delete(chart);
  };
}

/**
 * Indicators with direct manipulation can publish a small parameter patch
 * without knowing how the host persists chart preferences. The workstation
 * listens once per chart and stores the patch alongside normal indicator params.
 */
export function emitIndicatorRuntimeParamPatch(
  chart: L2Chart,
  id: string,
  patch: IndicatorRuntimeParamPatch,
): void {
  for (const listener of chartParamPatchListeners.get(chart) ?? []) listener(id, patch);
}

export function onIndicatorRuntimeParamPatch(
  chart: L2Chart,
  listener: ParamPatchListener,
): () => void {
  let listeners = chartParamPatchListeners.get(chart);
  if (!listeners) {
    listeners = new Set();
    chartParamPatchListeners.set(chart, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) chartParamPatchListeners.delete(chart);
  };
}
