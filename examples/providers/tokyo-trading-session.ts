import type { HistoryRange } from '../../src/datafeed';

const DAY_SECONDS = 86_400;
const TOKYO_OFFSET_SECONDS = 9 * 3_600;
const EXTENDED_SESSION_START = Date.parse('2024-11-05T00:00:00+09:00') / 1_000;

/** Whether an inclusive range can contain TSE intraday data.
 * Closing auction timestamps remain eligible. Holidays are deliberately not
 * inferred: an unconfirmed weekday must still be checked with the provider.
 */
export function overlapsTokyoTradingSession(range: HistoryRange): boolean {
  const firstDay = Math.floor((range.from + TOKYO_OFFSET_SECONDS) / DAY_SECONDS);
  const lastDay = Math.floor((range.to + TOKYO_OFFSET_SECONDS) / DAY_SECONDS);
  for (let day = firstDay; day <= lastDay; day += 1) {
    const midnight = day * DAY_SECONDS - TOKYO_OFFSET_SECONDS;
    const weekday = new Date(day * DAY_SECONDS * 1_000).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const afternoonClose = midnight >= EXTENDED_SESSION_START ? 15.5 : 15;
    for (const [open, close] of [[9, 11.5], [12.5, afternoonClose]]) {
      if (range.from <= midnight + close * 3_600
        && range.to >= midnight + open * 3_600) return true;
    }
  }
  return false;
}
