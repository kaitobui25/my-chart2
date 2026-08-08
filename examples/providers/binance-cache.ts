import type { Candle } from '../../src/core/types';
import {
  BINANCE_SPOT_HISTORY_SOURCE,
  BINANCE_USDM_HISTORY_SOURCE,
  BrowserHistoryCache,
  type BrowserHistoryCacheApi,
} from './browser-history-cache';

export type BinanceMarket = 'spot' | 'usdm';

export interface BinanceCacheCoverage {
  from: number;
  to: number;
}

function sourceForMarket(market: BinanceMarket): string {
  return market === 'spot' ? BINANCE_SPOT_HISTORY_SOURCE : BINANCE_USDM_HISTORY_SOURCE;
}

/**
 * Backwards-compatible Binance adapter over the provider-neutral browser cache.
 * Keeping this facade avoids widening the Binance refactor while all persisted
 * data now lives in l2chart.market.history.v1 and is keyed by stable source ID.
 */
export class BinanceHistoryCache {
  constructor(private readonly cache: BrowserHistoryCacheApi = new BrowserHistoryCache()) {}

  get available(): boolean {
    return this.cache.available;
  }

  async coverage(market: BinanceMarket, symbol: string, interval: string): Promise<BinanceCacheCoverage | null> {
    const ranges = await this.cache.coverage(sourceForMarket(market), symbol, interval);
    if (ranges.length === 0) return null;
    return {
      from: ranges[0].from,
      to: ranges[ranges.length - 1].to,
    };
  }

  async readLatest(
    market: BinanceMarket,
    symbol: string,
    interval: string,
    limit: number,
  ): Promise<Candle[]> {
    return this.cache.readLatest(sourceForMarket(market), symbol, interval, limit);
  }

  async readRange(
    market: BinanceMarket,
    symbol: string,
    interval: string,
    from: number,
    to: number,
    limit?: number,
  ): Promise<Candle[]> {
    return this.cache.readRange(sourceForMarket(market), symbol, interval, from, to, limit);
  }

  async write(
    market: BinanceMarket,
    symbol: string,
    interval: string,
    candles: Candle[],
  ): Promise<void> {
    await this.cache.write(sourceForMarket(market), symbol, interval, candles);
  }

  async clearMarket(market: BinanceMarket): Promise<void> {
    await this.cache.clearSource(sourceForMarket(market));
  }
}
