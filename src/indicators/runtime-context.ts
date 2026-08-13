import { L2Chart } from '../core/chart';

type SymbolListener = (symbol: string) => void;

const chartSymbols = new WeakMap<L2Chart, string>();
const chartSymbolListeners = new WeakMap<L2Chart, Set<SymbolListener>>();
let installed = false;

/**
 * Async indicators need the active instrument, while L2Chart intentionally keeps
 * provider concerns outside of core. Workstation charts already communicate the
 * active ticker through the public `setWatermark()` API, so this adapter observes
 * that public call rather than reaching into private chart fields.
 *
 * Keep this adapter small: if L2Chart later gains an explicit instrument-context
 * API, callers can move to it without changing indicator data/loading code.
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
