import type { Candle, LinePoint } from '../../core/types';

const VIETNAM_OFFSET_SECONDS = 7 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;
const PRICE_SCALE_CANDIDATES = [1, 10, 100, 1000, 10_000] as const;

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

export interface PeComputedSeries {
  values: LinePoint[];
  markers: PeMarker[];
  latestReportedPe: number | null;
  priceScale: number;
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

/**
 * Closing-price P/E is evaluated at the end of the Day / Week / Month bucket.
 * The current incomplete bucket is capped at wall-clock now so it cannot see a
 * disclosure from later in the same bucket.
 */
export function peBarEvaluationTime(
  candle: Candle,
  intervalSec: number,
  nowSec = Math.floor(Date.now() / 1000),
): number {
  return Math.min(endOfTradingBucket(candle.time, intervalSec), nowSec);
}

function quarterNumber(period: string): number | null {
  const match = period.trim().toUpperCase().match(/^\d{4}-Q([1-4])$/);
  return match ? Number(match[1]) : null;
}

/**
 * Vnstock Free does not expose the exact filing timestamp with `ratio()`.
 * These deliberately conservative windows avoid treating quarter-end as the
 * disclosure date. `firstObservedAt` can tighten the bound when we know the API
 * already exposed the quarter earlier than the fallback.
 */
export function peQuarterEffectiveAt(quarter: PeQuarter): number {
  const q = quarterNumber(quarter.period);
  const fallbackDays = q === 2 ? 60 : q === 4 ? 90 : 30;
  const conservative = quarter.periodEnd + fallbackDays * DAY_SECONDS;
  return Math.min(conservative, quarter.firstObservedAt);
}

export function inferPePriceScale(candles: readonly Candle[], quarters: readonly PeQuarter[]): number {
  const lastClose = [...candles].reverse().find((item) => Number.isFinite(item.close) && item.close > 0)?.close;
  const reference = [...quarters]
    .reverse()
    .find((item) => item.peRatio !== null && item.peRatio > 0 && item.trailingEps > 0);
  if (!lastClose || !reference?.peRatio) return 1;

  const expectedVnd = reference.peRatio * reference.trailingEps;
  let bestScale = 1;
  let bestError = Infinity;
  for (const scale of PRICE_SCALE_CANDIDATES) {
    const candidate = lastClose * scale;
    if (candidate <= 0 || expectedVnd <= 0) continue;
    const error = Math.abs(Math.log(candidate / expectedVnd));
    if (error < bestError) {
      bestError = error;
      bestScale = scale;
    }
  }
  return bestScale;
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

export function computePeSeries(
  candles: readonly Candle[],
  quarters: readonly PeQuarter[],
  intervalSec: number,
  nowSec = Math.floor(Date.now() / 1000),
): PeComputedSeries {
  const values: LinePoint[] = new Array(candles.length).fill(null);
  if (candles.length === 0 || quarters.length === 0 || intervalSec < DAY_SECONDS) {
    return { values, markers: [], latestReportedPe: null, priceScale: 1 };
  }

  const ordered = [...quarters]
    .filter((item) => Number.isFinite(item.periodEnd) && Number.isFinite(item.trailingEps))
    .sort((left, right) => peQuarterEffectiveAt(left) - peQuarterEffectiveAt(right));
  const priceScale = inferPePriceScale(candles, ordered);
  let quarterIndex = -1;

  for (let index = 0; index < candles.length; index += 1) {
    const effectiveTime = peBarEvaluationTime(candles[index], intervalSec, nowSec);
    while (
      quarterIndex + 1 < ordered.length
      && peQuarterEffectiveAt(ordered[quarterIndex + 1]) <= effectiveTime
    ) {
      quarterIndex += 1;
    }
    if (quarterIndex < 0) continue;
    const quarter = ordered[quarterIndex];
    if (!(quarter.trailingEps > 0) || !(candles[index].close > 0)) continue;
    const pe = (candles[index].close * priceScale) / quarter.trailingEps;
    values[index] = Number.isFinite(pe) && pe > 0 ? pe : null;
  }

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

  return { values, markers, latestReportedPe, priceScale };
}
