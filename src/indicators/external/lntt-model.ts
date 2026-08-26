import type { Candle } from '../../core/types';

const VIETNAM_OFFSET_SECONDS = 7 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;
const WEEK_INTERVAL_MIN_SECONDS = 5 * DAY_SECONDS;
const MONTH_INTERVAL_MIN_SECONDS = 20 * DAY_SECONDS;

export type LnttValueMode = 'percent' | 'vnd';

export interface LnttQuarter {
  period: string;
  year: number;
  quarter: number;
  profitBeforeTaxVnd: number;
}

export interface LnttPoint {
  index: number;
  value: number;
  period: string;
  profitBeforeTaxVnd: number;
  yoyPercent: number | null;
}

function vietnamDateParts(time: number): { year: number; month: number; day: number; weekday: number } {
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

function quarterBounds(year: number, quarter: number): { start: number; end: number; startMonth: number } {
  const startMonth = (quarter - 1) * 3;
  return {
    start: vietnamMidnight(year, startMonth, 1),
    end: vietnamMidnight(year, startMonth + 3, 1),
    startMonth,
  };
}

function lowerBoundTime(candles: readonly Candle[], target: number): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (candles[middle].time < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function weekBucketEnd(time: number): number {
  const local = vietnamDateParts(time);
  const daysToSunday = (7 - local.weekday) % 7;
  return vietnamMidnight(local.year, local.month, local.day + daysToSunday + 1) - 1;
}

/** Map a quarter to the first chart bucket that represents that quarter. */
export function firstCandleIndexForQuarter(
  candles: readonly Candle[],
  year: number,
  quarter: number,
  intervalSec: number,
): number {
  if (candles.length === 0 || quarter < 1 || quarter > 4) return -1;
  const { start, end, startMonth } = quarterBounds(year, quarter);
  const index = lowerBoundTime(candles, start);

  if (intervalSec >= MONTH_INTERVAL_MIN_SECONDS) {
    const candle = candles[index];
    if (!candle || candle.time >= end) return -1;
    const local = vietnamDateParts(candle.time);
    return local.year === year && local.month === startMonth ? index : -1;
  }

  if (intervalSec >= WEEK_INTERVAL_MIN_SECONDS) {
    const previousIndex = index - 1;
    const previous = candles[previousIndex];
    if (previous && previous.time < end && weekBucketEnd(previous.time) >= start) {
      return previousIndex;
    }
  }

  const candle = candles[index];
  return candle && candle.time < end ? index : -1;
}

export function lnttYoyPercent(current: number, previous: number | null): number | null {
  if (!Number.isFinite(current) || previous === null || !Number.isFinite(previous) || previous === 0) return null;
  return (current / previous - 1) * 100;
}

/** Build sparse quarterly histogram points aligned to candle indices. */
export function computeLnttPoints(
  candles: readonly Candle[],
  quarters: readonly LnttQuarter[],
  intervalSec: number,
  mode: LnttValueMode,
): LnttPoint[] {
  if (candles.length === 0 || quarters.length === 0) return [];

  const values = new Map<string, number>();
  for (const item of quarters) {
    if (item.quarter < 1 || item.quarter > 4 || !Number.isFinite(item.profitBeforeTaxVnd)) continue;
    values.set(`${item.year}:${item.quarter}`, item.profitBeforeTaxVnd);
  }

  const points: LnttPoint[] = [];
  const ordered = [...quarters].sort((left, right) => left.year - right.year || left.quarter - right.quarter);
  for (const item of ordered) {
    if (item.quarter < 1 || item.quarter > 4 || !Number.isFinite(item.profitBeforeTaxVnd)) continue;
    const previous = values.get(`${item.year - 1}:${item.quarter}`) ?? null;
    const yoyPercent = lnttYoyPercent(item.profitBeforeTaxVnd, previous);
    const value = mode === 'percent' ? yoyPercent : item.profitBeforeTaxVnd / 1_000_000_000;
    if (value === null || !Number.isFinite(value)) continue;

    const index = firstCandleIndexForQuarter(candles, item.year, item.quarter, intervalSec);
    if (index < 0) continue;
    points.push({
      index,
      value,
      period: item.period,
      profitBeforeTaxVnd: item.profitBeforeTaxVnd,
      yoyPercent,
    });
  }
  return points;
}
