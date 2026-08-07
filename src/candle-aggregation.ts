import type { Candle } from './core/types';
import { intervalStart } from './interval';

export interface CandleProjectionUpdate {
  candle: Candle;
  appended: boolean;
}

function cloneBucket(candle: Candle, time: number): Candle {
  const result: Candle = {
    time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  };
  if (candle.volume !== undefined) result.volume = candle.volume;
  return result;
}

/** Gop mot nen nguon vao bucket dich ma khong sua nen dau vao. */
export function mergeCandleIntoInterval(
  current: Candle | null,
  source: Candle,
  targetInterval: string,
  utcOffsetMinutes = 0,
): CandleProjectionUpdate {
  const bucketTime = intervalStart(source.time, targetInterval, utcOffsetMinutes);
  if (!current || current.time !== bucketTime) {
    return { candle: cloneBucket(source, bucketTime), appended: true };
  }

  const next: Candle = {
    time: current.time,
    open: current.open,
    high: Math.max(current.high, source.high),
    low: Math.min(current.low, source.low),
    close: source.close,
  };
  if (current.volume !== undefined || source.volume !== undefined) {
    next.volume = (current.volume ?? 0) + (source.volume ?? 0);
  }
  return { candle: next, appended: false };
}

/** Tao chuoi OHLC dich tu raw candles; week/month dung dung calendar boundary. */
export function aggregateCandles(
  candles: readonly Candle[],
  targetInterval: string,
  utcOffsetMinutes = 0,
): Candle[] {
  const source = [...candles].sort((a, b) => a.time - b.time);
  const result: Candle[] = [];

  for (const candle of source) {
    const current = result[result.length - 1] ?? null;
    const update = mergeCandleIntoInterval(current, candle, targetInterval, utcOffsetMinutes);
    if (update.appended) result.push(update.candle);
    else result[result.length - 1] = update.candle;
  }

  return result;
}
