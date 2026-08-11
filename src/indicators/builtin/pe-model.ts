import type { Candle, LinePoint } from '../../core/types';
import type { PeValuationPoint } from './pe-valuation-cache';

const VIETNAM_OFFSET_SECONDS = 7 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;

export interface PeQuarter {
  period: string;
  periodEnd: number;
  trailingEps: number;
  peRatio: number | null;
  /** Earliest wall-clock time this client has actually observed the row. */
  firstObservedAt: number;
}

export interface PeMarker {
  index: number;
  value: number;
  period: string;
}

export interface PeQuarterPresentation {
  markers: PeMarker[];
  latestReportedPe: number | null;
}

function localDateParts(time: number): { year: number; month: number; day: number; weekday: number } {
  const date = new Date((time + VIETNAM_OFFSET_SECONDS) * 1000);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
  };
}

function vietnamMidnight(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month, day) / 1000) - VIETNAM_OFFSET_SECONDS;
}

function startOfTradingBucket(time: number, intervalSec: number): number {
  const local = localDateParts(time);
  if (intervalSec >= 20 * DAY_SECONDS) {
    return vietnamMidnight(local.year, local.month, 1);
  }
  if (intervalSec >= 5 * DAY_SECONDS) {
    const daysSinceMonday = (local.weekday + 6) % 7;
    return vietnamMidnight(local.year, local.month, local.day - daysSinceMonday);
  }
  return vietnamMidnight(local.year, local.month, local.day);
}

function endOfTradingBucket(time: number, intervalSec: number): number {
  const local = localDateParts(time);
  if (intervalSec >= 20 * DAY_SECONDS) {
    return vietnamMidnight(local.year, local.month + 1, 1) - 1;
  }
  if (intervalSec >= 5 * DAY_SECONDS) {
    const daysToSunday = (7 - local.weekday) % 7;
    return vietnamMidnight(local.year, local.month, local.day + daysToSunday + 1) - 1;
  }
  return vietnamMidnight(local.year, local.month, local.day + 1) - 1;
}

/** End of a Day / Week / Month bar, capped at wall-clock now for the active bucket. */
export function peBarEvaluationTime(
  candle: Candle,
  intervalSec: number,
  nowSec = Math.floor(Date.now() / 1000),
): number {
  return Math.min(endOfTradingBucket(candle.time, intervalSec), nowSec);
}

export function peValuationRangeForCandles(
  candles: readonly Candle[],
  intervalSec: number,
  nowSec = Math.floor(Date.now() / 1000),
): { from: number; to: number } | null {
  if (candles.length === 0 || intervalSec < DAY_SECONDS) return null;
  return {
    from: startOfTradingBucket(candles[0].time, intervalSec),
    to: peBarEvaluationTime(candles[candles.length - 1], intervalSec, nowSec),
  };
}

function quarterNumber(period: string): number | null {
  const match = period.trim().toUpperCase().match(/^\d{4}-Q([1-4])$/);
  return match ? Number(match[1]) : null;
}

/**
 * Vnstock Free does not expose the exact filing timestamp with ratio().
 * This availability rule only controls when the raw quarterly yellow marker may
 * appear in Replay. It is never used to derive the blue FiinQuant P/E line.
 */
export function peQuarterEffectiveAt(quarter: PeQuarter): number {
  const q = quarterNumber(quarter.period);
  const fallbackDays = q === 2 ? 60 : q === 4 ? 90 : 30;
  const conservative = quarter.periodEnd + fallbackDays * DAY_SECONDS;
  return Math.max(quarter.periodEnd, Math.min(conservative, quarter.firstObservedAt));
}

/**
 * Map raw FiinQuant daily P/E onto the chart. Day uses that trading day's raw
 * value. Week / Month use the last valid trading-day P/E inside the bucket.
 * Missing daily values are not forward-filled across buckets.
 */
export function computeFiinQuantPeLine(
  candles: readonly Candle[],
  points: readonly PeValuationPoint[],
  intervalSec: number,
  nowSec = Math.floor(Date.now() / 1000),
): LinePoint[] {
  const values: LinePoint[] = new Array(candles.length).fill(null);
  if (candles.length === 0 || points.length === 0 || intervalSec < DAY_SECONDS) return values;

  const ordered = [...points]
    .filter((item) => Number.isFinite(item.time) && item.pe !== null && Number.isFinite(item.pe) && item.pe > 0)
    .sort((left, right) => left.time - right.time);
  let pointIndex = 0;

  for (let index = 0; index < candles.length; index += 1) {
    const start = startOfTradingBucket(candles[index].time, intervalSec);
    const end = peBarEvaluationTime(candles[index], intervalSec, nowSec);
    while (pointIndex < ordered.length && ordered[pointIndex].time < start) pointIndex += 1;

    let scan = pointIndex;
    let last: number | null = null;
    while (scan < ordered.length && ordered[scan].time <= end) {
      if (ordered[scan].time >= start && ordered[scan].pe !== null) last = ordered[scan].pe;
      scan += 1;
    }
    values[index] = last;
    pointIndex = scan;
  }

  return values;
}

function markerIndexForPeriodEnd(
  candles: readonly Candle[],
  periodEnd: number,
  intervalSec: number,
  nowSec: number,
): number {
  for (let index = candles.length - 1; index >= 0; index -= 1) {
    const candle = candles[index];
    if (candle.time <= periodEnd && peBarEvaluationTime(candle, intervalSec, nowSec) >= periodEnd) {
      return index;
    }
  }
  return -1;
}

export function computeQuarterPePresentation(
  candles: readonly Candle[],
  quarters: readonly PeQuarter[],
  intervalSec: number,
  nowSec = Math.floor(Date.now() / 1000),
): PeQuarterPresentation {
  if (candles.length === 0 || quarters.length === 0 || intervalSec < DAY_SECONDS) {
    return { markers: [], latestReportedPe: null };
  }

  const ordered = [...quarters]
    .filter((item) => Number.isFinite(item.periodEnd))
    .sort((left, right) => peQuarterEffectiveAt(left) - peQuarterEffectiveAt(right));
  const horizon = peBarEvaluationTime(candles[candles.length - 1], intervalSec, nowSec);
  const available = ordered.filter((item) => peQuarterEffectiveAt(item) <= horizon);
  const latestReportedPe = [...available]
    .reverse()
    .find((item) => item.peRatio !== null && item.peRatio > 0)?.peRatio ?? null;

  const markers: PeMarker[] = [];
  for (const quarter of available) {
    if (quarter.peRatio === null || !(quarter.peRatio > 0)) continue;
    const index = markerIndexForPeriodEnd(candles, quarter.periodEnd, intervalSec, nowSec);
    if (index >= 0) markers.push({ index, value: quarter.peRatio, period: quarter.period });
  }

  return { markers, latestReportedPe };
}
