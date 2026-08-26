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

function lnttDisplayWindow(year: number, quarter: number): {
  monthStart: number;
  monthEnd: number;
  weekStart: number;
  weekEnd: number;
  tuesdayStart: number;
  tuesdayEnd: number;
} {
  const monthStart = vietnamMidnight(year, quarter * 3, 1);
  const monthEnd = vietnamMidnight(year, quarter * 3 + 1, 1);
  const lastDay = vietnamDateParts(monthEnd - DAY_SECONDS);
  const daysSinceMonday = (lastDay.weekday + 6) % 7;
  const weekStart = vietnamMidnight(lastDay.year, lastDay.month, lastDay.day - daysSinceMonday);
  const weekEnd = weekStart + 7 * DAY_SECONDS;
  const tuesdayStart = weekStart + DAY_SECONDS;
  return {
    monthStart,
    monthEnd,
    weekStart,
    weekEnd,
    tuesdayStart,
    tuesdayEnd: tuesdayStart + DAY_SECONDS,
  };
}

/**
 * Place quarterly LNTT after the reporting quarter:
 * Month -> next month; Week -> last week of that month; Day -> Tuesday of that
 * week; intraday -> last candle of that Tuesday.
 */
export function lnttDisplayCandleIndex(
  candles: readonly Candle[],
  year: number,
  quarter: number,
  intervalSec: number,
): number {
  if (candles.length === 0 || quarter < 1 || quarter > 4) return -1;
  const window = lnttDisplayWindow(year, quarter);

  if (intervalSec >= MONTH_INTERVAL_MIN_SECONDS) {
    const index = lowerBoundTime(candles, window.monthStart);
    const candle = candles[index];
    return candle && candle.time < window.monthEnd ? index : -1;
  }

  if (intervalSec >= WEEK_INTERVAL_MIN_SECONDS) {
    const index = lowerBoundTime(candles, window.weekStart);
    const candle = candles[index];
    return candle && candle.time < window.weekEnd ? index : -1;
  }

  if (intervalSec >= DAY_SECONDS) {
    const index = lowerBoundTime(candles, window.tuesdayStart);
    const candle = candles[index];
    return candle && candle.time < window.tuesdayEnd ? index : -1;
  }

  const index = lowerBoundTime(candles, window.tuesdayEnd) - 1;
  const candle = candles[index];
  return candle && candle.time >= window.tuesdayStart ? index : -1;
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

    const index = lnttDisplayCandleIndex(candles, item.year, item.quarter, intervalSec);
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
