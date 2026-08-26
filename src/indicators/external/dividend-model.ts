import type { Candle } from '../../core/types';

const VIETNAM_UTC_OFFSET_SECONDS = 7 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;
const WEEK_INTERVAL_MIN_SECONDS = 5 * DAY_SECONDS;
const MONTH_INTERVAL_MIN_SECONDS = 20 * DAY_SECONDS;
const VIETNAM_EQUITY_TICKER = /^[A-Z]{3}$/;

export interface DividendEvent {
  exDate: string;
  cashVndPerShare: number | null;
  cashPercent: number | null;
  stockPercent: number | null;
  bonusPercent: number | null;
}

export interface DividendMarker {
  index: number;
  stack: number;
  event: DividendEvent;
}

export function isDividendVietnamEquitySymbol(symbol: string): boolean {
  return VIETNAM_EQUITY_TICKER.test(symbol.trim().toUpperCase());
}

function vietnamDateKey(timeSeconds: number): string {
  const date = new Date((timeSeconds + VIETNAM_UTC_OFFSET_SECONDS) * 1000);
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function weekKey(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return `W:${date.toISOString().slice(0, 10)}`;
}

function bucketKey(dateKey: string, intervalSec: number): string {
  if (intervalSec >= MONTH_INTERVAL_MIN_SECONDS) return `M:${dateKey.slice(0, 7)}`;
  if (intervalSec >= WEEK_INTERVAL_MIN_SECONDS) return weekKey(dateKey);
  return `D:${dateKey}`;
}

/** Map each ex-date to the first candle in its day/week/month bucket. */
export function mapDividendEventsToCandles(
  candles: readonly Candle[],
  events: readonly DividendEvent[],
  intervalSec: number,
): DividendMarker[] {
  if (candles.length === 0 || events.length === 0) return [];

  const firstIndexByBucket = new Map<string, number>();
  candles.forEach((candle, index) => {
    const key = bucketKey(vietnamDateKey(candle.time), intervalSec);
    if (!firstIndexByBucket.has(key)) firstIndexByBucket.set(key, index);
  });

  const stacks = new Map<number, number>();
  const markers: DividendMarker[] = [];
  for (const event of [...events].sort((left, right) => left.exDate.localeCompare(right.exDate))) {
    const index = firstIndexByBucket.get(bucketKey(event.exDate, intervalSec));
    if (index === undefined) continue;
    const stack = stacks.get(index) ?? 0;
    stacks.set(index, stack + 1);
    markers.push({ index, stack, event });
  }
  return markers;
}
