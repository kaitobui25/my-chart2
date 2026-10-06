import type { Candle } from '../../core/types';
import { buildSmcTimeframe, smcPeriodLevels, type SmcTimeframeOptions } from './smart-money-concepts-v2-timeframes';

export type SmcV2Direction = 'bullish' | 'bearish';
export type SmcV2StructureType = 'BOS' | 'CHoCH';
export type SmcV2Scope = 'internal' | 'swing';

export interface SmcV2Structure {
  originIndex: number;
  index: number;
  price: number;
  direction: SmcV2Direction;
  type: SmcV2StructureType;
  scope: SmcV2Scope;
}

export interface SmcV2Pivot {
  index: number;
  confirmedAt: number;
  price: number;
  direction: SmcV2Direction;
  label: 'HH' | 'LH' | 'HL' | 'LL' | 'PH' | 'PL';
  scope?: SmcV2Scope;
}

export interface SmcV2Zone {
  startIndex: number;
  endIndex: number;
  top: number;
  bottom: number;
  direction: SmcV2Direction;
  scope?: SmcV2Scope;
}

export interface SmcV2StructureLine {
  fromIndex: number;
  fromPrice: number;
  toIndex: number;
  toPrice: number;
  confirmedAt: number;
  /** V3 keeps replaced legs for causal historical views, but renders only active legs. */
  supersededAt?: number;
  scope: SmcV2Scope;
}

export interface SmcV2EqualLevel {
  firstIndex: number;
  index: number;
  confirmedAt: number;
  firstPrice: number;
  price: number;
  label: 'EQH' | 'EQL';
}

export interface SmcV2PeriodLevel {
  startIndex: number;
  endIndex: number;
  high: number;
  low: number;
  highIndex: number;
  lowIndex: number;
  label: 'D' | 'W' | 'M';
}

export interface SmcV2BarState {
  index: number;
  high: SmcV2Pivot | null;
  low: SmcV2Pivot | null;
  bias: -1 | 0 | 1;
  internalBias: -1 | 0 | 1;
  rangeAnchorIndex: number | null;
  atr: number | null;
  atr14: number | null;
}

export interface SmcV2Alert {
  index: number;
  name: `${SmcV2Scope}${'Bullish' | 'Bearish'}${SmcV2StructureType | 'OrderBlock'}`
    | 'bullishFairValueGap' | 'bearishFairValueGap';
}

export interface SmcV2Result {
  structures: SmcV2Structure[];
  structureLines: SmcV2StructureLine[];
  pivots: SmcV2Pivot[];
  /** Active inventory (100 per scope); display counts do not evict backend state. */
  orderBlocks: SmcV2Zone[];
  fairValueGaps: SmcV2Zone[];
  equalLevels: SmcV2EqualLevel[];
  periodLevels: SmcV2PeriodLevel[];
  swingAnchors: SmcV2Pivot[];
  swingBiasHistory: Array<{ index: number; bias: -1 | 0 | 1 }>;
  barStates: SmcV2BarState[];
  alerts: SmcV2Alert[];
  extremes: { high: SmcV2Pivot | null; low: SmcV2Pivot | null };
  swingBias: -1 | 0 | 1;
}

interface PivotState extends SmcV2Pivot { crossed: boolean }
interface StructureState {
  leg: 0 | 1;
  high: PivotState | null;
  low: PivotState | null;
  bias: -1 | 0 | 1;
}

export interface SmcV2Options extends SmcTimeframeOptions {
  swingLength: number;
  internalLength: number;
  equalLength: number;
  equalThreshold: number;
  showInternalPivots: boolean;
  showSwingPivots: boolean;
  internalConfluence: boolean;
  showEqualLevels: boolean;
  showDailyLevels: boolean;
  showWeeklyLevels: boolean;
  showMonthlyLevels: boolean;
  showInternalOrderBlocks: boolean;
  showSwingOrderBlocks: boolean;
  internalOrderBlockCount: number;
  swingOrderBlockCount: number;
  mitigation: 'close' | 'wick';
  orderBlockFilter: 'atr' | 'range';
  showFairValueGaps: boolean;
  filterFairValueGaps: boolean;
  showInternal?: boolean;
  showSwing?: boolean;
  showStrongWeak?: boolean;
  showPremiumDiscount?: boolean;
  showFib?: boolean;
  fvgTimeframe?: string;
  /** Exchange bars override calendar aggregation, also allowing lower-timeframe requests. */
  fvgCandles?: readonly Candle[];
}

const FIBONACCI_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;
function blankStructure(): StructureState { return { leg: 0, high: null, low: null, bias: 0 }; }

function trueRange(candle: Candle, previous?: Candle): number {
  if (!previous) return candle.high - candle.low;
  return Math.max(candle.high - candle.low, Math.abs(candle.high - previous.close), Math.abs(candle.low - previous.close));
}

/** DucTri leg(): right window only, inclusive ties, independent alternating state per scope. */
function nextPivot(state: StructureState, candles: readonly Candle[], index: number, length: number): PivotState | null {
  const origin = index - length;
  if (origin < 0) return null;
  let rightHigh = -Infinity;
  let rightLow = Infinity;
  for (let i = origin + 1; i <= index; i++) {
    rightHigh = Math.max(rightHigh, candles[i].high);
    rightLow = Math.min(rightLow, candles[i].low);
  }
  const source = candles[origin];
  const newHigh = source.high >= rightHigh;
  const newLow = source.low <= rightLow;
  const nextLeg = newHigh && newLow ? (state.leg === 1 ? 0 : 1) : newHigh ? 0 : newLow ? 1 : state.leg;
  if (nextLeg === state.leg) return null;
  state.leg = nextLeg;
  const bullish = nextLeg === 1;
  const previous = bullish ? state.low : state.high;
  const price = bullish ? source.low : source.high;
  const pivot: PivotState = {
    index: origin, confirmedAt: index, price, crossed: false, direction: bullish ? 'bullish' : 'bearish',
    // Comparisons with an uninitialized Pine level are false: first labels are HL / LH.
    label: bullish ? (previous && price < previous.price ? 'LL' : 'HL')
      : (previous && price > previous.price ? 'HH' : 'LH'),
  };
  if (bullish) state.low = pivot;
  else state.high = pivot;
  return pivot;
}

function copyPivot(pivot: PivotState, scope: SmcV2Scope): SmcV2Pivot {
  return { index: pivot.index, confirmedAt: pivot.confirmedAt, price: pivot.price, direction: pivot.direction, label: pivot.label, scope };
}

/** Pine getCurrentStructure draws high-low connectors on each leg change, even with BOS hidden. */
function recordStructureLines(result: SmcV2Result, swing: StructureState, internal: StructureState, index: number): void {
  for (const [scope, state] of [['internal', internal], ['swing', swing]] as const) {
    if (!state.high || !state.low) continue;
    const from = state.high.index < state.low.index ? state.high : state.low;
    const to = from === state.high ? state.low : state.high;
    result.structureLines.push({
      fromIndex: from.index, fromPrice: from.price, toIndex: to.index, toPrice: to.price,
      confirmedAt: index, scope,
    });
  }
}

function recordAlert(result: SmcV2Result, alert: SmcV2Alert): void {
  // Pine currentAlerts has boolean fields: several OB removals still fire one alert per bar.
  for (let i = result.alerts.length - 1; i >= 0 && result.alerts[i].index === alert.index; i--) {
    if (result.alerts[i].name === alert.name) return;
  }
  result.alerts.push(alert);
}

function recordStructure(
  result: SmcV2Result, state: StructureState, swing: StructureState,
  candle: Candle, previous: Candle | undefined, index: number, scope: SmcV2Scope,
  previousLevels: { high: number | null; low: number | null }, confluence: boolean,
): SmcV2Structure[] {
  const events: SmcV2Structure[] = [];
  if (!previous) return events;
  // Preserve the source's literal math.min(close, open - low), even though it is unusual.
  const upper = candle.high - Math.max(candle.close, candle.open);
  const lower = Math.min(candle.close, candle.open - candle.low);
  for (const bullish of [true, false]) {
    const pivot = bullish ? state.high : state.low;
    const priorLevel = bullish ? previousLevels.high : previousLevels.low;
    if (!pivot || pivot.crossed || priorLevel === null) continue;
    const crossed = bullish ? candle.close > pivot.price && previous.close <= priorLevel
      : candle.close < pivot.price && previous.close >= priorLevel;
    const swingPivot = bullish ? swing.high : swing.low;
    const extra = scope !== 'internal' || (swingPivot !== null && pivot.price !== swingPivot.price
      && (!confluence || (bullish ? upper > lower : upper < lower)));
    if (!crossed || !extra) continue;
    const event: SmcV2Structure = {
      originIndex: pivot.index, index, price: pivot.price, scope,
      direction: bullish ? 'bullish' : 'bearish',
      type: state.bias === (bullish ? -1 : 1) ? 'CHoCH' : 'BOS',
    };
    pivot.crossed = true;
    state.bias = bullish ? 1 : -1;
    result.structures.push(event);
    events.push(event);
    recordAlert(result, { index, name: `${scope}${bullish ? 'Bullish' : 'Bearish'}${event.type}` });
    if (scope === 'swing') result.swingBiasHistory.push({ index, bias: state.bias });
  }
  return events;
}

function storeOrderBlock(blocks: SmcV2Zone[], event: SmcV2Structure, highs: readonly number[], lows: readonly number[]): void {
  let origin = event.originIndex;
  const bearish = event.direction === 'bearish';
  const prices = bearish ? highs : lows;
  // slice(origin, bar_index) excludes the breakout candle; indexof chooses the first tie.
  for (let i = origin + 1; i < event.index; i++) {
    if (bearish ? prices[i] > prices[origin] : prices[i] < prices[origin]) origin = i;
  }
  if (blocks.length >= 100) blocks.pop();
  blocks.unshift({ startIndex: origin, endIndex: event.index, top: highs[origin], bottom: lows[origin], direction: event.direction, scope: event.scope });
}

function deleteOrderBlocks(
  blocks: SmcV2Zone[], scope: SmcV2Scope, candle: Candle, index: number, mitigation: SmcV2Options['mitigation'], result: SmcV2Result,
): void {
  // Pine iterates forward while removing: a shifted neighbour is visited on the next bar.
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const bullish = block.direction === 'bullish';
    const crossed = bullish ? (mitigation === 'close' ? candle.close : candle.low) < block.bottom
      : (mitigation === 'close' ? candle.close : candle.high) > block.top;
    if (crossed) {
      recordAlert(result, { index, name: `${scope}${bullish ? 'Bullish' : 'Bearish'}OrderBlock` });
      blocks.splice(i, 1);
    }
  }
}

function deleteGaps(gaps: SmcV2Zone[], candle: Candle): void {
  for (let i = 0; i < gaps.length; i++) {
    const gap = gaps[i];
    if (gap.direction === 'bullish' ? candle.low < gap.bottom : candle.high > gap.top) gaps.splice(i, 1);
  }
}

/** A fresh policy per scope is created for each calculation; raw pivots remain owned by the engine. */
export type SmcStructurePolicy = (
  high: SmcV2Pivot | null, low: SmcV2Pivot | null, candle: Candle, index: number,
) => SmcV2Structure[];

function recordPolicyEvents(result: SmcV2Result, state: StructureState, events: SmcV2Structure[]): void {
  for (const event of events) {
    state.bias = event.direction === 'bullish' ? 1 : -1;
    result.structures.push(event);
    if (event.scope === 'swing') result.swingBiasHistory.push({ index: event.index, bias: state.bias });
    recordAlert(result, { index: event.index, name: `${event.scope}${event.direction === 'bullish' ? 'Bullish' : 'Bearish'}${event.type}` });
  }
}

/** Historical bar-by-bar port of ref/indicator/02_SMC_ductri.pine, including its source quirks. */
export function calculateSmartMoneyConceptsV2(candles: readonly Candle[], options: SmcV2Options, policies: Partial<Record<SmcV2Scope, SmcStructurePolicy>> = {}): SmcV2Result {
  for (const length of [options.swingLength, options.internalLength, options.equalLength]) {
    if (!Number.isInteger(length) || length < 1) throw new RangeError('SMC pivot lengths must be positive integers');
  }
  const result: SmcV2Result = {
    structures: [], structureLines: [], pivots: [], orderBlocks: [], fairValueGaps: [], equalLevels: [], periodLevels: [],
    swingAnchors: [], swingBiasHistory: [], barStates: [], alerts: [], extremes: { high: null, low: null }, swingBias: 0,
  };
  const swing = blankStructure();
  const internal = blankStructure();
  const equal = blankStructure();
  const internalBlocks: SmcV2Zone[] = [];
  const swingBlocks: SmcV2Zone[] = [];
  const parsedHighs: number[] = [];
  const parsedLows: number[] = [];
  let rangeAnchorIndex: number | null = null;
  let atrSum = 0;
  let atr: number | null = null;
  let atr14Sum = 0;
  let atr14: number | null = null;
  let cumulativeTR = 0;
  let gapDeltaSum = 0;
  const fvg = options.showFairValueGaps
    ? buildSmcTimeframe(candles, options.fvgTimeframe ?? 'chart', options, options.fvgCandles) : null;
  const trailingEnabled = (options.showStrongWeak ?? true) || options.showPremiumDiscount === true || options.showFib === true;

  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index];
    const previous = candles[index - 1];
    const tr = trueRange(candle, previous);
    atr14Sum += tr;
    if (index === 13) atr14 = atr14Sum / 14;
    else if (atr14 !== null) atr14 = tr / 14 + (13 / 14) * atr14;
    // ta.atr(200) = ta.rma(ta.tr(true), 200), SMA seed, na until bar 199.
    // https://www.tradingview.com/pine-script-reference/v6/#fun_ta.atr
    atrSum += tr;
    if (index === 199) atr = atrSum / 200;
    else if (atr !== null) atr = (1 / 200) * tr + (1 - 1 / 200) * atr;
    // ta.tr (variable) is na on the first bar, unlike ta.tr(true).
    if (index > 0) cumulativeTR += tr;
    const volatility = options.orderBlockFilter === 'atr' ? atr : (index > 0 ? cumulativeTR / index : null);
    const highVolatility = volatility !== null && candle.high - candle.low >= 2 * volatility;
    parsedHighs.push(highVolatility ? candle.low : candle.high);
    parsedLows.push(highVolatility ? candle.high : candle.low);

    // Source execution order: update old trailing extremes BEFORE resetting on a new pivot.
    if (trailingEnabled) {
      for (const high of [true, false]) {
        const point = high ? result.extremes.high : result.extremes.low;
        const price = high ? candle.high : candle.low;
        if (point && (high ? price >= point.price : price <= point.price)) {
          const next = { ...point, index, confirmedAt: index, price };
          if (high) result.extremes.high = next;
          else result.extremes.low = next;
        }
      }
    }
    if (options.showFairValueGaps) deleteGaps(result.fairValueGaps, candle);
    const previousSwingLevels = { high: swing.high?.price ?? null, low: swing.low?.price ?? null };
    const previousInternalLevels = { high: internal.high?.price ?? null, low: internal.low?.price ?? null };
    const swingPivot = nextPivot(swing, candles, index, options.swingLength);
    if (swingPivot) {
      const point = copyPivot(swingPivot, 'swing');
      result.swingAnchors.push(point);
      if (options.showSwingPivots) result.pivots.push(point);
      if (point.direction === 'bearish') result.extremes.high = point;
      else result.extremes.low = point;
      rangeAnchorIndex = point.index;
      recordStructureLines(result, swing, internal, index);
    }
    const internalPivot = nextPivot(internal, candles, index, options.internalLength);
    if (internalPivot && options.showInternalPivots) result.pivots.push(copyPivot(internalPivot, 'internal'));
    if (internalPivot) recordStructureLines(result, swing, internal, index);
    if (options.showEqualLevels) {
      const oldHigh = equal.high;
      const oldLow = equal.low;
      const point = nextPivot(equal, candles, index, options.equalLength);
      if (point) {
        recordStructureLines(result, swing, internal, index);
        const prior = point.direction === 'bullish' ? oldLow : oldHigh;
        if (prior && atr !== null && Math.abs(prior.price - point.price) < options.equalThreshold * atr) {
          result.equalLevels.push({ firstIndex: prior.index, index: point.index, confirmedAt: index,
            firstPrice: prior.price, price: point.price, label: point.direction === 'bullish' ? 'EQL' : 'EQH' });
          // DucTri draws Equal levels but never sets currentAlerts.equalHighs/equalLows.
        }
      }
    }
    if (policies.internal || (options.showInternal ?? true) || options.showInternalOrderBlocks) {
      const events = policies.internal
        ? policies.internal(internal.high, internal.low, candle, index)
        : recordStructure(result, internal, swing, candle, previous, index, 'internal', previousInternalLevels, options.internalConfluence);
      if (policies.internal) recordPolicyEvents(result, internal, events);
      if (options.showInternalOrderBlocks) for (const event of events) storeOrderBlock(internalBlocks, event, parsedHighs, parsedLows);
    }
    if (policies.swing || (options.showSwing ?? false) || options.showSwingOrderBlocks || (options.showStrongWeak ?? true)) {
      const events = policies.swing
        ? policies.swing(swing.high, swing.low, candle, index)
        : recordStructure(result, swing, swing, candle, previous, index, 'swing', previousSwingLevels, false);
      if (policies.swing) recordPolicyEvents(result, swing, events);
      if (options.showSwingOrderBlocks) for (const event of events) storeOrderBlock(swingBlocks, event, parsedHighs, parsedLows);
    }
    if (options.showInternalOrderBlocks) deleteOrderBlocks(internalBlocks, 'internal', candle, index, options.mitigation, result);
    if (options.showSwingOrderBlocks) deleteOrderBlocks(swingBlocks, 'swing', candle, index, options.mitigation, result);
    if (fvg) {
      const frameIndex = fvg.at[index];
      const last = fvg.candles[frameIndex - 1];
      const last2 = fvg.candles[frameIndex - 2];
      const current = fvg.candles[frameIndex];
      const newTimeframe = index === 0 || fvg.keys[index] !== fvg.keys[index - 1];
      const delta = last && last.open !== 0 ? (last.close - last.open) / (last.open * 100) : null;
      if (newTimeframe && delta !== null) gapDeltaSum += Math.abs(delta);
      const threshold = options.filterFairValueGaps ? (index > 0 ? gapDeltaSum / index * 2 : NaN) : 0;
      if (newTimeframe && current && last && last2 && delta !== null) {
        const bullish = current.low > last2.high && last.close > last2.high && delta > threshold;
        const bearish = current.high < last2.low && last.close < last2.low && -delta > threshold;
        if (bullish || bearish) {
          // Preserve bearish UDT field ordering: top=currentHigh, bottom=last2Low.
          result.fairValueGaps.unshift({ startIndex: fvg.firstIndices[frameIndex - 1], endIndex: index,
            top: bullish ? current.low : current.high, bottom: bullish ? last2.high : last2.low,
            direction: bullish ? 'bullish' : 'bearish' });
          recordAlert(result, { index, name: bullish ? 'bullishFairValueGap' : 'bearishFairValueGap' });
        }
      }
    }
    result.swingBias = swing.bias;
    result.barStates.push({ index, high: result.extremes.high, low: result.extremes.low, bias: swing.bias,
      internalBias: internal.bias, rangeAnchorIndex, atr, atr14 });
  }
  const lastIndex = candles.length - 1;
  for (const block of [...internalBlocks, ...swingBlocks]) block.endIndex = lastIndex;
  result.orderBlocks = [...internalBlocks, ...swingBlocks];
  result.periodLevels = smcPeriodLevels(candles, options);
  return result;
}

export function smcV2SwingContext(result: SmcV2Result, throughIndex = Infinity): SmcV2BarState {
  const index = Math.min(Math.floor(throughIndex), result.barStates.length - 1);
  return result.barStates[index] ?? { index, high: null, low: null, bias: 0, internalBias: 0, rangeAnchorIndex: null, atr: null, atr14: null };
}

export function smcV2FibLevels(
  result: SmcV2Result, direction: 'auto' | 'high-to-low' | 'low-to-high', throughIndex = Infinity,
  ratios: readonly number[] = FIBONACCI_RATIOS,
): Array<{ ratio: number; price: number }> {
  const { high, low, bias } = smcV2SwingContext(result, throughIndex);
  if (!high || !low || high.index === low.index || (direction === 'auto' && bias === 0)) return [];
  const bearish = direction === 'high-to-low' || (direction === 'auto' && bias < 0);
  const start = bearish ? high.price : low.price;
  const end = bearish ? low.price : high.price;
  return ratios.map(ratio => ({ ratio, price: start + (end - start) * ratio }));
}

/** The source uses narrow 5% bands, not the entire upper/lower halves of the range. */
export function smcV2PremiumDiscountZones(result: SmcV2Result, throughIndex = Infinity): Array<{
  label: 'Premium' | 'Equilibrium' | 'Discount'; startIndex: number; top: number; bottom: number;
}> {
  const { high, low, rangeAnchorIndex } = smcV2SwingContext(result, throughIndex);
  if (!high || !low || rangeAnchorIndex === null) return [];
  const top = high.price;
  const bottom = low.price;
  return [
    { label: 'Premium', startIndex: rangeAnchorIndex, top, bottom: 0.95 * top + 0.05 * bottom },
    { label: 'Equilibrium', startIndex: rangeAnchorIndex, top: 0.525 * top + 0.475 * bottom, bottom: 0.525 * bottom + 0.475 * top },
    { label: 'Discount', startIndex: rangeAnchorIndex, top: 0.95 * bottom + 0.05 * top, bottom },
  ];
}
