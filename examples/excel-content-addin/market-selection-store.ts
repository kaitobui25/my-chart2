import { normalizeYFinanceJapanSymbol } from '../providers/yfinance-jp';
import {
  JAPAN_MARKET_CONFIG,
  JAPAN_TIMEFRAMES,
  type JapanTimeframe,
} from './japan-market-config';

export interface MarketSelection {
  symbol: string;
  timeframe: JapanTimeframe;
}

export interface MarketSelectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'l2chart.excel.market-selection.v1';

export class MarketSelectionStore {
  private value: MarketSelection;

  constructor(private readonly storage: MarketSelectionStorage | null = browserStorage()) {
    this.value = this.load();
  }

  get(): Readonly<MarketSelection> {
    return { ...this.value };
  }

  update(selection: MarketSelection): Readonly<MarketSelection> {
    const symbol = normalizeYFinanceJapanSymbol(selection.symbol);
    if (!symbol || !isJapanTimeframe(selection.timeframe)) return this.get();
    this.value = { symbol, timeframe: selection.timeframe };
    this.persist();
    return this.get();
  }

  private load(): MarketSelection {
    const fallback = defaultSelection();
    if (!this.storage) return fallback;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw) as Partial<MarketSelection>;
      const symbol = normalizeYFinanceJapanSymbol(parsed.symbol ?? '');
      const timeframe = parsed.timeframe;
      if (!symbol || !isJapanTimeframe(timeframe)) return fallback;
      return { symbol, timeframe };
    } catch {
      return fallback;
    }
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.value));
    } catch {
      // Persistence is optional in restricted Office WebViews.
    }
  }
}

function defaultSelection(): MarketSelection {
  return {
    symbol: JAPAN_MARKET_CONFIG.defaultSymbol,
    timeframe: JAPAN_MARKET_CONFIG.defaultTimeframe,
  };
}

function isJapanTimeframe(value: unknown): value is JapanTimeframe {
  return typeof value === 'string' && JAPAN_TIMEFRAMES.some((item) => item.value === value);
}

function browserStorage(): MarketSelectionStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
