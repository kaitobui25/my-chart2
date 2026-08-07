import type { Candle } from './core/types';
import { intervalStart } from './interval';

export type CalendarInterval = '1w' | '1M';

/** Gop OHLC theo tuan/thang, giu dung open dau, close cuoi va tong volume. */
export function aggregateCalendarCandles(
  candles: readonly Candle[],
  interval: CalendarInterval,
  utcOffsetMinutes = 0,
): Candle[] {
  const sorted = [...candles].sort((left, right) => left.time - right.time);
  const result: Candle[] = [];

  for (const candle of sorted) {
    const bucket = intervalStart(candle.time, interval, utcOffsetMinutes);
    const previous = result[result.length - 1];
    if (!previous || previous.time !== bucket) {
      result.push({ ...candle, time: bucket });
      continue;
    }

    const hadVolume = previous.volume !== undefined || candle.volume !== undefined;
    previous.high = Math.max(previous.high, candle.high);
    previous.low = Math.min(previous.low, candle.low);
    previous.close = candle.close;
    previous.volume = hadVolume ? (previous.volume ?? 0) + (candle.volume ?? 0) : undefined;
  }

  return result;
}
