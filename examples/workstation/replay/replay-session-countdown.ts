import type { BarLabel } from '../../../src/core/chart';
import { intervalApproxSeconds, intervalStart } from '../../../src/interval';
import { tokyoTradingDayClose } from '../../providers/tokyo-trading-session';

/** Only timestamps from full history are used; future prices never enter labels. */
export function buildReplaySessionCountdown(
  visibleTimes: readonly number[], historyTimes: readonly number[], interval: string,
  provider: string, symbol: string,
): BarLabel[] {
  const seconds = intervalApproxSeconds(interval);
  if (seconds >= 86_400) return [];
  const japan = provider === 'yfinance-jp' && (symbol.endsWith('.T') || symbol === '^N225');
  const vietnam = ['vnstock', 'fiinquant', 'dnse'].includes(provider);
  if (!japan && !vietnam) return [];
  const offset = japan ? 540 : 420;
  const days = new Map<number, number[]>();
  for (const time of historyTimes) {
    const day = intervalStart(time, '1d', offset);
    const close = japan ? tokyoTradingDayClose(time) : day + 15 * 3_600;
    if (time > close) continue;
    const times = days.get(day) ?? [];
    times.push(time); days.set(day, times);
  }
  const numbers = new Map<number, string>();
  for (const [day, times] of days) {
    const sorted = [...new Set(times)].sort((a, b) => a - b);
    const close = japan ? tokyoTradingDayClose(day) : day + 15 * 3_600;
    // An incomplete latest day must not be mistaken for the end of a session.
    if (sorted[sorted.length - 1] + seconds < close) continue;
    const buckets = [...new Set(sorted.map(time => intervalStart(time, interval, offset)))];
    buckets.slice(-5).forEach((time, index, tail) => numbers.set(time, String(tail.length - index)));
  }
  return visibleTimes.flatMap(time => {
    const text = numbers.get(intervalStart(time, interval, offset));
    return text ? [{ time, text, position: 'above' as const }] : [];
  });
}
