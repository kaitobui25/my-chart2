import type { Candle } from '../../core/types';

export type DarvasBoxState = 'forming' | 'bull' | 'bear' | 'weak';

export interface DarvasBox {
  startIndex: number;
  endIndex: number;
  top: number;
  bottom: number;
  state: DarvasBoxState;
}

interface Pivot {
  index: number;
  price: number;
}

const VOLUME_PERIOD = 20;

/** No volume reading means price-only classification remains available. */
function hasBreakoutVolume(candles: readonly Candle[], index: number): boolean {
  const current = candles[index].volume;
  // Yahoo Japan sometimes reports zero for an active opening-hour candle.
  // When the breakout bar is unavailable we cannot reject its volume.
  if (current === undefined || current <= 0 || index < VOLUME_PERIOD) return true;
  let sum = 0;
  let samples = 0;
  for (let j = index - VOLUME_PERIOD; j < index; j++) {
    const volume = candles[j].volume;
    // Missing readings in the lookback cannot waive confirmation for a
    // breakout with known volume. Use available samples as an estimate.
    if (volume === undefined || volume <= 0) continue;
    sum += volume;
    samples++;
  }
  return samples === 0 || current > sum / samples;
}

/** A pivot is usable only after the `size` candles to its right have arrived. */
function pivotAt(candles: readonly Candle[], index: number, size: number, side: 'high' | 'low'): Pivot | null {
  if (index < size || index + size >= candles.length) return null;
  const price = candles[index][side];
  for (let offset = 1; offset <= size; offset++) {
    const before = candles[index - offset][side];
    const after = candles[index + offset][side];
    if (side === 'high' ? before >= price || after >= price : before <= price || after <= price) return null;
  }
  return { index, price };
}

/**
 * Detect Darvas consolidation rectangles using independently confirmed swing highs/lows.
 * Each box is frozen by the first close outside its boundaries; the next box must
 * use fresh pivots. Older rectangles therefore stay anchored while new bars arrive.
 *
 * A confirmed pivot's bar is used as the left edge, matching how TradingView
 * pivot-based indicators backfill shapes after confirmation. No future candle is
 * inspected when deciding a box's state on a given bar.
 */
export function calculateDarvasBoxes(candles: readonly Candle[], pivotSize = 3, intervalSeconds = 86400): DarvasBox[] {
  const size = Math.max(1, Math.floor(pivotSize));
  // Old, unpaired pivots are swing levels, not the bounds of a local consolidation.
  const maxPivotAge = size * 6;
  // Hourly bars are sparse across market closures. Allow their pivots to
  // survive weekends; keep the bar-count cap and stricter subhour limit.
  const maxPivotAgeSeconds = intervalSeconds >= 3600
    ? Math.max(3 * 86400, maxPivotAge * intervalSeconds)
    : maxPivotAge * intervalSeconds;
  const boxes: DarvasBox[] = [];
  let high: Pivot | null = null;
  let low: Pivot | null = null;
  let active: DarvasBox | null = null;
  let firstEligiblePivotIndex = 0;

  for (let i = 0; i < candles.length; i++) {
    const close = candles[i].close;
    if (active) {
      active.endIndex = i;
      if (close > active.top || close < active.bottom) {
        active.state = hasBreakoutVolume(candles, i) ? (close > active.top ? 'bull' : 'bear') : 'weak';
        active = null;
        high = null;
        low = null;
        // A pivot confirmed after the breakout can still belong to an older
        // candle. Never reuse any candle from the box that just ended.
        firstEligiblePivotIndex = i + 1;
      }
      continue;
    }

    // An unpaired pivot cannot be reused after the market has broken it, or
    // after it has become too distant from the potential consolidation.
    if (high && (close > high.price || i - high.index > maxPivotAge
      || candles[i].time - candles[high.index].time > maxPivotAgeSeconds)) high = null;
    if (low && (close < low.price || i - low.index > maxPivotAge
      || candles[i].time - candles[low.index].time > maxPivotAgeSeconds)) low = null;

    const pivotIndex = i - size;
    const newHigh = pivotAt(candles, pivotIndex, size, 'high');
    const newLow = pivotAt(candles, pivotIndex, size, 'low');
    if (newHigh && newHigh.index >= firstEligiblePivotIndex) high = newHigh;
    if (newLow && newLow.index >= firstEligiblePivotIndex) low = newLow;
    if (!high || !low || high.index === low.index) continue;

    const start = Math.min(high.index, low.index);
    const top = high.price;
    const bottom = low.price;
    if (bottom >= top) continue;

    // The two pivots must describe an intact range, including the bars that
    // elapsed while the later pivot was being confirmed.
    let intact = true;
    for (let j = start; j <= i; j++) {
      if (candles[j].close > top || candles[j].close < bottom) {
        intact = false;
        break;
      }
    }
    if (!intact) {
      high = null;
      low = null;
      continue;
    }

    active = { startIndex: start, endIndex: i, top, bottom, state: 'forming' };
    boxes.push(active);
  }

  return boxes;
}
