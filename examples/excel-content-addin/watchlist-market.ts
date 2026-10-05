import type { Candle } from '../../src/library';
import type { JapanMarketDatafeed } from './japan-market-controller';
import { WATCHLIST_CONFIG } from './watchlist-config';

export interface WatchListQuote {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  time: number;
}

export async function loadWatchListQuotes(
  feed: JapanMarketDatafeed,
  symbols: readonly string[],
): Promise<Map<string, WatchListQuote>> {
  if (symbols.length === 0) return new Map();
  const histories = feed.getDailyHistoryMany
    ? await feed.getDailyHistoryMany(symbols, WATCHLIST_CONFIG.historyLimit)
    : await loadFallbackHistories(feed, symbols);

  const quotes = new Map<string, WatchListQuote>();
  for (const symbol of symbols) {
    const candles = histories[symbol] ?? [];
    const quote = quoteFromHistory(symbol, candles);
    if (quote) quotes.set(symbol, quote);
  }
  return quotes;
}

export function quoteFromHistory(symbol: string, candles: readonly Candle[]): WatchListQuote | null {
  const current = candles[candles.length - 1];
  if (!current) return null;
  const previousClose = candles.length > 1
    ? candles[candles.length - 2].close
    : current.open;
  const change = current.close - previousClose;
  return {
    symbol,
    price: current.close,
    change,
    changePercent: previousClose === 0 ? 0 : (change / previousClose) * 100,
    time: current.time,
  };
}

async function loadFallbackHistories(
  feed: JapanMarketDatafeed,
  symbols: readonly string[],
): Promise<Record<string, Candle[]>> {
  const entries = await Promise.all(symbols.map(async (symbol) => [
    symbol,
    await feed.getHistory(symbol, '1d', WATCHLIST_CONFIG.historyLimit),
  ] as const));
  return Object.fromEntries(entries);
}
