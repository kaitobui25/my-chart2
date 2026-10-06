import type { Candle } from '../../core/types';

export type SmcDirection = 'bullish' | 'bearish';
export type SmcStructureKind = 'BOS' | 'CHoCH';
export type SmcStructureScope = 'internal' | 'swing';

export interface SmcStructureEvent {
  originIndex: number;
  index: number;
  price: number;
  direction: SmcDirection;
  kind: SmcStructureKind;
  scope: SmcStructureScope;
}

export interface SmcSwingPoint {
  index: number;
  price: number;
  label: 'HH' | 'LH' | 'HL' | 'LL';
  direction: SmcDirection;
}

export interface SmcPriceZone {
  startIndex: number;
  endIndex: number;
  top: number;
  bottom: number;
  direction: SmcDirection;
}

export interface SmcResult {
  structures: SmcStructureEvent[];
  swingPoints: SmcSwingPoint[];
  orderBlocks: SmcPriceZone[];
  fairValueGaps: SmcPriceZone[];
}

interface Pivot {
  index: number;
  confirmedAt: number;
  price: number;
  crossed: boolean;
}

interface StructureState {
  high: Pivot | null;
  low: Pivot | null;
  bias: -1 | 0 | 1;
}

const MAX_ORDER_BLOCKS = 20;
const MAX_FAIR_VALUE_GAPS = 40;
const ORDER_BLOCK_SEARCH_LIMIT = 100;

function isPivotHigh(candles: readonly Candle[], index: number, length: number): boolean {
  const price = candles[index].high;
  for (let offset = 1; offset <= length; offset++) {
    if (candles[index - offset].high >= price || candles[index + offset].high >= price) return false;
  }
  return true;
}

function isPivotLow(candles: readonly Candle[], index: number, length: number): boolean {
  const price = candles[index].low;
  for (let offset = 1; offset <= length; offset++) {
    if (candles[index - offset].low <= price || candles[index + offset].low <= price) return false;
  }
  return true;
}

function makeStructureState(): StructureState {
  return { high: null, low: null, bias: 0 };
}

function lastOpposingCandle(
  candles: readonly Candle[],
  from: number,
  to: number,
  direction: SmcDirection,
): number | null {
  const first = Math.max(from, to - ORDER_BLOCK_SEARCH_LIMIT);
  for (let index = to - 1; index >= first; index--) {
    const candle = candles[index];
    const isOpposing = direction === 'bullish'
      ? candle.close < candle.open
      : candle.close > candle.open;
    if (isOpposing) return index;
  }
  return null;
}

function appendStructureEvents(
  candles: readonly Candle[],
  length: number,
  scope: SmcStructureScope,
  state: StructureState,
  index: number,
  result: SmcStructureEvent[],
  onSwingPoint?: (point: SmcSwingPoint) => void,
): void {
  const pivotIndex = index - length;
  if (pivotIndex >= length) {
    const candle = candles[pivotIndex];
    if (isPivotHigh(candles, pivotIndex, length)) {
      if (scope === 'swing' && state.high) {
        onSwingPoint?.({
          index: pivotIndex,
          price: candle.high,
          label: candle.high > state.high.price ? 'HH' : 'LH',
          direction: 'bearish',
        });
      }
      state.high = { index: pivotIndex, confirmedAt: index, price: candle.high, crossed: false };
    }
    if (isPivotLow(candles, pivotIndex, length)) {
      if (scope === 'swing' && state.low) {
        onSwingPoint?.({
          index: pivotIndex,
          price: candle.low,
          label: candle.low > state.low.price ? 'HL' : 'LL',
          direction: 'bullish',
        });
      }
      state.low = { index: pivotIndex, confirmedAt: index, price: candle.low, crossed: false };
    }
  }

  const close = candles[index].close;
  const high = state.high;
  if (high && !high.crossed && index > high.confirmedAt && close > high.price) {
    result.push({
      originIndex: high.index,
      index,
      price: high.price,
      direction: 'bullish',
      kind: state.bias === -1 ? 'CHoCH' : 'BOS',
      scope,
    });
    state.high = { ...high, crossed: true };
    state.bias = 1;
  }

  const low = state.low;
  if (low && !low.crossed && index > low.confirmedAt && close < low.price) {
    result.push({
      originIndex: low.index,
      index,
      price: low.price,
      direction: 'bearish',
      kind: state.bias === 1 ? 'CHoCH' : 'BOS',
      scope,
    });
    state.low = { ...low, crossed: true };
    state.bias = -1;
  }
}

/** Find confirmed pivots, structure breaks, unmitigated order blocks, and gaps. */
export function calculateSmartMoneyConcepts(
  candles: readonly Candle[],
  swingLength = 12,
  internalLength = 4,
): SmcResult {
  const result: SmcResult = {
    structures: [],
    swingPoints: [],
    orderBlocks: [],
    fairValueGaps: [],
  };
  const swingState = makeStructureState();
  const internalState = makeStructureState();
  const activeOrderBlocks: SmcPriceZone[] = [];
  const activeGaps: SmcPriceZone[] = [];

  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index];
    for (let zoneIndex = activeOrderBlocks.length - 1; zoneIndex >= 0; zoneIndex--) {
      const zone = activeOrderBlocks[zoneIndex];
      zone.endIndex = index;
      const invalidated = zone.direction === 'bullish'
        ? candle.close < zone.bottom
        : candle.close > zone.top;
      if (invalidated) activeOrderBlocks.splice(zoneIndex, 1);
    }
    for (let gapIndex = activeGaps.length - 1; gapIndex >= 0; gapIndex--) {
      const gap = activeGaps[gapIndex];
      gap.endIndex = index;
      const filled = gap.direction === 'bullish'
        ? candle.low <= gap.bottom
        : candle.high >= gap.top;
      if (filled) activeGaps.splice(gapIndex, 1);
    }

    const structureStart = result.structures.length;
    appendStructureEvents(
      candles,
      swingLength,
      'swing',
      swingState,
      index,
      result.structures,
      (point) => result.swingPoints.push(point),
    );
    appendStructureEvents(
      candles,
      internalLength,
      'internal',
      internalState,
      index,
      result.structures,
    );

    for (let eventIndex = structureStart; eventIndex < result.structures.length; eventIndex++) {
      const event = result.structures[eventIndex];
      if (event.scope !== 'swing') continue;
      const origin = lastOpposingCandle(candles, event.originIndex, event.index, event.direction);
      if (origin === null) continue;
      const source = candles[origin];
      activeOrderBlocks.unshift({
        startIndex: origin,
        endIndex: index,
        top: source.high,
        bottom: source.low,
        direction: event.direction,
      });
      if (activeOrderBlocks.length > MAX_ORDER_BLOCKS) activeOrderBlocks.pop();
    }

    if (index < 2) continue;
    const twoBarsBack = candles[index - 2];
    if (candle.low > twoBarsBack.high) {
      activeGaps.unshift({
        startIndex: index - 2,
        endIndex: index,
        top: candle.low,
        bottom: twoBarsBack.high,
        direction: 'bullish',
      });
    } else if (candle.high < twoBarsBack.low) {
      activeGaps.unshift({
        startIndex: index - 2,
        endIndex: index,
        top: twoBarsBack.low,
        bottom: candle.high,
        direction: 'bearish',
      });
    }
    if (activeGaps.length > MAX_FAIR_VALUE_GAPS) activeGaps.pop();
  }

  result.orderBlocks = activeOrderBlocks;
  result.fairValueGaps = activeGaps;
  return result;
}
