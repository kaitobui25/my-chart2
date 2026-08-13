const MONTH_PROGRESS_FULL_COLOR = [180, 125, 0] as const;
const MONTH_PROGRESS_EMPTY_COLOR = [253, 230, 138] as const;

export interface ReplayMonthProgress {
  time: number;
  remaining: number;
  color: string;
}

/** Remaining calendar-month progress for the monthly candle being built. */
export function buildReplayMonthProgress(
  monthCandleTime: number,
  currentTime: number,
  utcOffsetMinutes = 0,
): ReplayMonthProgress {
  const offsetSeconds = utcOffsetMinutes * 60;
  const localMonth = new Date((monthCandleTime + offsetSeconds) * 1000);
  const year = localMonth.getUTCFullYear();
  const month = localMonth.getUTCMonth();
  const monthStart = Date.UTC(year, month, 1) / 1000 - offsetSeconds;
  const monthEnd = Date.UTC(year, month + 1, 1) / 1000 - offsetSeconds;
  const remaining = Math.max(0, Math.min(1, (monthEnd - currentTime) / (monthEnd - monthStart)));
  const faded = 1 - remaining;
  const color = `rgb(${MONTH_PROGRESS_FULL_COLOR.map((channel, index) => (
    Math.round(channel + (MONTH_PROGRESS_EMPTY_COLOR[index] - channel) * faded)
  )).join(', ')})`;
  return { time: monthCandleTime, remaining, color };
}
