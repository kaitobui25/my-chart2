import { intervalStart, nextIntervalStart } from '../../../src/interval';

const PERIOD_PROGRESS_FULL_COLOR = [180, 125, 0] as const;
const PERIOD_PROGRESS_EMPTY_COLOR = [253, 230, 138] as const;

export type ReplayProgressInterval = '1w' | '1M';

export interface ReplayPeriodProgress {
  time: number;
  remaining: number;
  color: string;
}

export function supportsReplayPeriodProgress(interval: string): interval is ReplayProgressInterval {
  return interval === '1w' || interval === '1M';
}

function progressColor(remaining: number): string {
  const faded = 1 - remaining;
  return `rgb(${PERIOD_PROGRESS_FULL_COLOR.map((channel, index) => (
    Math.round(channel + (PERIOD_PROGRESS_EMPTY_COLOR[index] - channel) * faded)
  )).join(', ')})`;
}

/** Remaining calendar-period progress for the weekly/monthly candle being built. */
export function buildReplayPeriodProgress(
  interval: ReplayProgressInterval,
  candleTime: number,
  currentTime: number,
  utcOffsetMinutes = 0,
): ReplayPeriodProgress {
  const start = intervalStart(candleTime, interval, utcOffsetMinutes);
  const end = nextIntervalStart(start, interval, utcOffsetMinutes);
  const remaining = Math.max(0, Math.min(1, (end - currentTime) / (end - start)));
  return {
    time: candleTime,
    remaining,
    color: progressColor(remaining),
  };
}
