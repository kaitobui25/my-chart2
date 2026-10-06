import { createProtectedStructurePath } from './smart-money-concepts-v3-path';
import type { Candle } from '../../core/types';
import {
  calculateSmartMoneyConceptsV2, type SmcStructurePolicy, type SmcV2Options,
  type SmcV2Scope, type SmcV2StructureLine, type SmcV2Pivot, type SmcV2Result, type SmcV2Structure,
} from './smart-money-concepts-v2-model';

interface ProtectedPivot extends SmcV2Pivot { crossed: boolean }
interface ProtectedStructureState { high: SmcV2Pivot | null; low: SmcV2Pivot | null; index: number }

/** Super SMC: candidates never replace an unbroken protected level. */
export function createProtectedStructurePolicy(
  scope: SmcV2Scope,
  onState?: (state: ProtectedStructureState) => void,
  confluence = false,
): SmcStructurePolicy {
  let high: ProtectedPivot | null = null;
  let low: ProtectedPivot | null = null;
  let bias: -1 | 0 | 1 = 0;
  const protect = (pivot: SmcV2Pivot): ProtectedPivot => ({ ...pivot, crossed: false });

  return (candidateHigh, candidateLow, candle, index) => {
    if (candidateHigh && (!high || (high.crossed && candidateHigh.index > high.index && candidateHigh.price > high.price))) {
      high = protect(candidateHigh);
    }
    if (candidateLow && (!low || (low.crossed && candidateLow.index > low.index && candidateLow.price < low.price))) {
      low = protect(candidateLow);
    }
    const events: SmcV2Structure[] = [];
    // Match the reference's deterministic bullish-then-bearish order on outside bars.
    for (const bullish of [true, false]) {
      const pivot = bullish ? high : low;
      if (!pivot || pivot.crossed || !(bullish ? candle.high > pivot.price : candle.low < pivot.price)) continue;
      if (confluence) {
        // Preserve the existing Internal confluence option and its source formula.
        const upper = candle.high - Math.max(candle.close, candle.open);
        const lower = Math.min(candle.close, candle.open - candle.low);
        if (!(bullish ? upper > lower : upper < lower)) continue;
      }
      events.push({ originIndex: pivot.index, index, price: pivot.price, scope,
        direction: bullish ? 'bullish' : 'bearish', type: bias === (bullish ? -1 : 1) ? 'CHoCH' : 'BOS' });
      const candidate = bullish ? candidateLow : candidateHigh;
      const opposite = bullish ? low : high;
      if (candidate && (!opposite || candidate.index > opposite.index)) {
        if (bullish) low = protect(candidate);
        else high = protect(candidate);
      }
      pivot.crossed = true;
      bias = bullish ? 1 : -1;
    }
    onState?.({ high, low, index });
    return events;
  };
}

function updateStructurePath(
  state: ProtectedStructureState, previous: ProtectedStructureState | undefined,
  append: (pivot: SmcV2Pivot, confirmedAt: number) => void,
): void {
  const changed = [state.high !== previous?.high ? state.high : null, state.low !== previous?.low ? state.low : null]
    .filter((pivot): pivot is SmcV2Pivot => pivot !== null)
    .sort((a, b) => a.index - b.index);
  for (const pivot of changed) append(pivot, state.index);
}

/** Shares raw pivot detection, zones and timeframe calculations with V2. */
export function calculateSmartMoneyConceptsV3(candles: readonly Candle[], options: SmcV2Options): SmcV2Result {
  const states: ProtectedStructureState[] = [];
  const internalLines: SmcV2StructureLine[] = [];
  const internalPath = createProtectedStructurePath('internal', internalLines);
  let previousInternal: ProtectedStructureState | undefined;
  const result = calculateSmartMoneyConceptsV2(candles, options, {
    swing: createProtectedStructurePolicy('swing', state => states.push(state)),
    internal: createProtectedStructurePolicy('internal', state => {
      updateStructurePath(state, previousInternal, internalPath);
      previousInternal = state;
    }, options.internalConfluence),
  });
  result.structureLines = internalLines;
  result.swingAnchors = [];
  const swingPath = createProtectedStructurePath('swing', result.structureLines);
  let previousHigh: SmcV2Pivot | null = null;
  let previousLow: SmcV2Pivot | null = null;
  let high: SmcV2Pivot | null = null;
  let low: SmcV2Pivot | null = null;
  let rangeAnchorIndex: number | null = null;
  const trailingEnabled = (options.showStrongWeak ?? true) || options.showPremiumDiscount === true || options.showFib === true;
  const extend = (pivot: SmcV2Pivot | null, price: number, index: number, upper: boolean): SmcV2Pivot | null =>
    pivot && (upper ? price >= pivot.price : price <= pivot.price)
      ? { ...pivot, index, confirmedAt: index, price } : pivot;
  for (const state of states) {
    const candle = candles[state.index];
    // Keep V2's trailing behavior, but reset only when a V3 structural pivot changes.
    if (trailingEnabled) {
      high = extend(high, candle.high, state.index, true);
      low = extend(low, candle.low, state.index, false);
    }
    const highChanged = state.high !== previousHigh;
    const lowChanged = state.low !== previousLow;
    for (const [changed, pivot] of [[highChanged, state.high], [lowChanged, state.low]] as const) {
      if (!changed || !pivot) continue;
      // The structural anchor becomes available now, even if the raw pivot was confirmed earlier.
      const anchor: SmcV2Pivot = { ...pivot, scope: 'swing', confirmedAt: state.index };
      result.swingAnchors.push(anchor);
      if (pivot === state.high) high = anchor;
      else low = anchor;
      rangeAnchorIndex = anchor.index;
    }
    updateStructurePath(state, { high: previousHigh, low: previousLow, index: state.index - 1 }, swingPath);
    const barState = result.barStates[state.index];
    barState.high = high;
    barState.low = low;
    barState.rangeAnchorIndex = rangeAnchorIndex;
    previousHigh = state.high;
    previousLow = state.low;
  }
  result.extremes = { high, low };
  return result;
}
