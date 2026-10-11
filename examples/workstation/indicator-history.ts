import type { Datafeed, HistoryRange } from '../../src/datafeed';
import type { Candle } from '../../src/core/types';

/** Count-based warmup works across exchange sessions and continuous markets. */
export async function loadIndicatorHistory(
  feed: Datafeed, symbol: string, interval: string, range: HistoryRange & { limit?: number },
): Promise<readonly Candle[]> {
  if (range.limit === undefined) return feed.getHistory(symbol, interval, undefined, range);
  let latest: Candle[];
  try {
    latest = await feed.getHistory(symbol, interval, range.limit);
  } catch (error) {
    const cached = await feed.getCachedHistory?.(symbol, interval, range.limit);
    if (!cached?.length) throw error;
    latest = cached;
  }
  const bars = latest.filter(bar => bar.time <= range.to);
  // An older chart/replay can fall outside the provider's latest history window.
  if (!bars.length && latest.length) return feed.getHistory(symbol, interval, range.limit, range);
  return bars;
}
