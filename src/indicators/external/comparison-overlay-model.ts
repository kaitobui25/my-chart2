import type { Candle } from '../../core/types';
import { aggregateCandles } from '../../candle-aggregation';
import { intervalStart, nextIntervalStart } from '../../interval';

/** Filter raw closes before aggregation so a partial bucket cannot leak future OHLC. */
export function projectComparisonCandles(
  source: readonly Candle[], rawInterval: string, interval: string, replayTime: number | null,
): Candle[] {
  const revealed = replayTime === null ? source : source.filter(
    candle => nextIntervalStart(candle.time, rawInterval, 540) <= replayTime,
  );
  return rawInterval === interval ? revealed.map(candle => ({ ...candle }))
    : aggregateCandles(revealed, interval, 540);
}

export function alignComparisonCandles(primary: readonly Candle[], projected: readonly Candle[], interval: string): (Candle | null)[] {
  // Native Yahoo daily/session bars can open at 09:00/12:30 whereas projected
  // buckets use calendar boundaries. Match the bucket, never array positions.
  const key = (time: number) => intervalStart(time, interval, 540);
  const byTime = new Map(projected.map(candle => [key(candle.time), candle]));
  return primary.map(candle => byTime.get(key(candle.time)) ?? null);
}
