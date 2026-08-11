import type { BarLabel } from '../../../src/core/chart';
import type { Candle } from '../../../src/core/types';

export const DEFAULT_REPLAY_DAY_LABEL_COLORS = ['#64748b', '#cbd5e1'] as const;
export const REPLAY_MONTH_UNDERLINE_COLOR = 'rgba(250, 204, 21, 0.2)';

const REPLAY_LABEL_DAYS = [10, 20, 30] as const;

/** Calendar day labels used by the daily chart under a monthly replay chart. */
export function buildReplayDayLabels(
  candles: readonly Candle[],
  utcOffsetMinutes = 0,
  colors: readonly [string, string] = DEFAULT_REPLAY_DAY_LABEL_COLORS,
): BarLabel[] {
  const offsetSeconds = utcOffsetMinutes * 60;
  const months = new Map<number, Array<{ candle: Candle; day: number }>>();
  for (const candle of candles) {
    const date = new Date((candle.time + offsetSeconds) * 1000);
    const day = date.getUTCDate();
    const monthIndex = date.getUTCFullYear() * 12 + date.getUTCMonth() + 1;
    const month = months.get(monthIndex) ?? [];
    month.push({ candle, day });
    months.set(monthIndex, month);
  }

  const orderedMonths = [...months.entries()].sort(([left], [right]) => left - right);
  return orderedMonths.flatMap(([monthIndex, month], monthPosition) => {
    month.sort((left, right) => left.candle.time - right.candle.time);
    const completed = monthPosition < orderedMonths.length - 1;
    const latestDay = Math.max(...month.map(({ day }) => day));
    const labeledCandles = new Set<number>();
    return REPLAY_LABEL_DAYS.flatMap((targetDay) => {
      if (!completed && latestDay < targetDay) return [];
      const nearest = month.reduce((best, candidate) => (
        Math.abs(candidate.day - targetDay) < Math.abs(best.day - targetDay) ? candidate : best
      ));
      if (labeledCandles.has(nearest.candle.time)) return [];
      labeledCandles.add(nearest.candle.time);
      return [{
        time: nearest.candle.time,
        text: String(targetDay),
        color: colors[monthIndex % 2],
        ...(targetDay === 10 ? { underlineColor: REPLAY_MONTH_UNDERLINE_COLOR } : {}),
      }];
    });
  });
}
