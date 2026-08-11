import type { Candle } from './core/types';

export interface QuoteLevel {
  price: number;
  volume: number;
}

export interface QuoteUpdate {
  symbol: string;
  bids: QuoteLevel[];
  asks: QuoteLevel[];
  time: number;
}

export interface HistoryRange {
  /** Inclusive Unix timestamp in seconds. */
  from: number;
  /** Inclusive Unix timestamp in seconds. */
  to: number;
}

export interface SymbolSearchResult {
  symbol: string;
  name?: string;
  exchange?: string;
}

/**
 * The integration point for any data source (exchange, broker, backend).
 * Implement these two methods and the chart can consume your data.
 */
export interface Datafeed {
  /** Human-readable name shown in UIs. */
  readonly name: string;
  /** Optional fast path for rendering persisted history before a remote refresh completes. */
  getCachedHistory?(symbol: string, interval: string, limit?: number, range?: HistoryRange): Promise<Candle[]>;
  getHistory(symbol: string, interval: string, limit?: number, range?: HistoryRange): Promise<Candle[]>;
  /**
   * Stream live updates for the current bar (and new bars).
   * Returns an unsubscribe function.
   */
  subscribe(symbol: string, interval: string, onCandle: (c: Candle) => void): () => void;
  /**
   * Optional lifecycle hook fired when the realtime transport connects again.
   * Consumers can backfill a historical gap without opening another stream.
   */
  onRealtimeConnected?(listener: () => void): () => void;
  /**
   * Optional multiplexed stream for background surfaces such as watchlists.
   * Implementations should keep this on one provider connection when possible.
   */
  subscribeMany?(
    symbols: string[],
    interval: string,
    onCandle: (symbol: string, candle: Candle) => void,
  ): () => void;
  /** Optional provider-backed instrument lookup for symbol pickers. */
  searchSymbols?(query: string, limit?: number): Promise<SymbolSearchResult[]>;
  /** Optional Level 2/top-price stream used by bid/ask lines and DOM. */
  subscribeQuotes?(symbols: string[], onQuote: (quote: QuoteUpdate) => void): () => void;
}

/** Supported interval codes → seconds per bar. */
export const INTERVAL_SECONDS: Record<string, number> = {
  '1m': 60,
  '3m': 180,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '2h': 7200,
  '4h': 14400,
  '1d': 86400,
  '1w': 604800,
};
