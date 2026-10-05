import { intervalApproxSeconds, type Candle, type L2Chart } from '../../src/library';
import type { Datafeed, SymbolSearchResult } from '../../src/datafeed';
import {
  normalizeYFinanceJapanSymbol,
  YFinanceJapanDatafeed,
} from '../providers/yfinance-jp';
import {
  historyRangeForTimeframe,
  JAPAN_MARKET_CONFIG,
  type JapanTimeframe,
} from './japan-market-config';

export interface JapanMarketDatafeed extends Datafeed {
  searchSymbols(query: string, limit?: number): Promise<SymbolSearchResult[]>;
  dispose?(): void;
}

export interface MarketLoadResult {
  symbol: string;
  timeframe: JapanTimeframe;
  candles: Candle[];
}

export interface JapanMarketSnapshot {
  symbol: string;
  timeframe: JapanTimeframe;
}

export class JapanMarketController {
  private generation = 0;
  private unsubscribe: (() => void) | null = null;
  private current: JapanMarketSnapshot | null = null;

  constructor(
    private readonly chart: L2Chart,
    private readonly feed: JapanMarketDatafeed = new YFinanceJapanDatafeed(JAPAN_MARKET_CONFIG.apiBaseUrl),
  ) {}

  async load(symbolInput: string, timeframe: JapanTimeframe): Promise<MarketLoadResult | null> {
    const symbol = normalizeYFinanceJapanSymbol(symbolInput);
    if (!symbol) throw new Error('Mã Nhật phải là mã TSE 4 ký tự.');

    const generation = ++this.generation;
    const limit = JAPAN_MARKET_CONFIG.historyLimit;
    const range = historyRangeForTimeframe(timeframe);

    let candles: Candle[] = [];
    try {
      candles = await this.feed.getHistory(symbol, timeframe, limit, range);
    } catch {
      // Yahoo can reject explicit intraday ranges that are wider than the
      // provider currently allows. The no-range request uses provider-safe
      // defaults in the sidecar.
    }
    if (candles.length === 0) {
      candles = await this.feed.getHistory(symbol, timeframe, limit);
    }
    if (generation !== this.generation) return null;
    if (candles.length === 0) throw new Error(`Không có dữ liệu ${symbol} · ${timeframe}.`);

    // Keep the previous market subscription alive until the replacement data
    // is ready. A failed reload must not leave the visible chart frozen.
    this.stopLive();
    this.chart.setIntervalSec(intervalApproxSeconds(timeframe));
    this.chart.setData(candles);
    this.chart.fitContent();
    this.current = { symbol, timeframe };
    this.unsubscribe = this.feed.subscribe(symbol, timeframe, (candle) => {
      if (generation !== this.generation) return;
      this.chart.updateCandle(candle);
    });

    return { symbol, timeframe, candles };
  }

  searchSymbols(query: string): Promise<SymbolSearchResult[]> {
    return this.feed.searchSymbols(query, JAPAN_MARKET_CONFIG.symbolSearchLimit);
  }

  getDatafeed(): Datafeed {
    return this.feed;
  }

  getSnapshot(): JapanMarketSnapshot | null {
    return this.current ? { ...this.current } : null;
  }

  pause(): void {
    this.generation += 1;
    this.stopLive();
  }

  dispose(): void {
    this.pause();
    this.feed.dispose?.();
  }

  private stopLive(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
