import type { Candle, Datafeed } from '../../src/index';

export const ASSISTANT_TIMEFRAMES = new Set([
  '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w', '1M',
]);

const SECONDS: Record<string, number> = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
  '1h': 3600, '2h': 7200, '4h': 14400,
  '1d': 86400, '1w': 604800, '1M': 2592000,
};

/** Read one bounded interval, including market closures but never candles after the replay/visible anchor. */
export async function loadAssistantCandles(
  feed: Datafeed,
  symbol: string,
  timeframe: string,
  until: number,
  count: number,
): Promise<Candle[]> {
  const step = SECONDS[timeframe];
  if (!step) throw new Error(`Unsupported timeframe: ${timeframe}`);
  const slack = step < 86400 ? 4 : step < 604800 ? 3 : 2;
  const from = Math.max(0, until - step * count * slack);
  const requested = count * slack + 8;
  let candles: Candle[] = [];
  try {
    candles = await feed.getHistory(symbol, timeframe, requested, { from, to: until });
  } catch {
    // Feeds without ranged requests can still supply a bounded latest-history fallback.
  }
  candles = candles.filter(candle => candle.time >= from && candle.time <= until);
  if (!candles.length) {
    // Some feeds do not support bounded history. Filter the fallback by the same anchor.
    candles = (await feed.getHistory(symbol, timeframe, requested))
      .filter(candle => candle.time >= from && candle.time <= until);
  }
  return candles.sort((a, b) => a.time - b.time).slice(-count);
}
