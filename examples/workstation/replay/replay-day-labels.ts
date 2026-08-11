import type { BarLabel } from '../../../src/core/chart';
import type { Candle } from '../../../src/core/types';

export const DEFAULT_REPLAY_DAY_LABEL_COLORS = ['#64748b', '#cbd5e1'] as const;

/** Calendar day labels used by the daily chart under a monthly replay chart. */
export function buildReplayDayLabels(
  candles: readonly Candle[],
  utcOffsetMinutes = 0,
  colors: readonly [string, string] = DEFAULT_REPLAY_DAY_LABEL_COLORS,
): BarLabel[] {
  const offsetSeconds = utcOffsetMinutes * 60;
  return candles.flatMap((candle) => {
    const date = new Date((candle.time + offsetSeconds) * 1000);
    const day = date.getUTCDate();
    if (day % 2 !== 0) return [];
    const monthIndex = date.getUTCFullYear() * 12 + date.getUTCMonth() + 1;
    return [{
      time: candle.time,
      text: String(day),
      color: colors[monthIndex % 2],
    }];
  });
}
