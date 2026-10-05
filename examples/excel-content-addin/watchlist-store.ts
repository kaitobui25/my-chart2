import { normalizeYFinanceJapanSymbol } from '../providers/yfinance-jp';
import { WATCHLIST_CONFIG } from './watchlist-config';

export interface WatchListStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class WatchListStore {
  private symbols: string[];

  constructor(
    defaults: readonly string[],
    private readonly storage: WatchListStorage | null = browserStorage(),
    private readonly storageKey: string = WATCHLIST_CONFIG.storageKey,
  ) {
    this.symbols = this.load(defaults);
  }

  list(): readonly string[] {
    return [...this.symbols];
  }

  add(symbolInput: string): 'added' | 'exists' | 'invalid' | 'full' {
    const symbol = normalizeYFinanceJapanSymbol(symbolInput);
    if (!symbol) return 'invalid';
    if (this.symbols.includes(symbol)) return 'exists';
    if (this.symbols.length >= WATCHLIST_CONFIG.maxSymbols) return 'full';
    this.symbols = [...this.symbols, symbol];
    this.persist();
    return 'added';
  }

  remove(symbolInput: string): boolean {
    const symbol = normalizeYFinanceJapanSymbol(symbolInput);
    if (!symbol) return false;
    const next = this.symbols.filter((item) => item !== symbol);
    if (next.length === this.symbols.length) return false;
    this.symbols = next;
    this.persist();
    return true;
  }

  private load(defaults: readonly string[]): string[] {
    const fallback = normalizeSymbols(defaults).slice(0, WATCHLIST_CONFIG.maxSymbols);
    if (!this.storage) return fallback;
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return fallback;
      return normalizeSymbols(parsed.map(String)).slice(0, WATCHLIST_CONFIG.maxSymbols);
    } catch {
      return fallback;
    }
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(this.symbols));
    } catch {
      // Storage can be unavailable in restricted Office WebViews. The in-memory
      // list still remains usable for the lifetime of the add-in.
    }
  }
}

function normalizeSymbols(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const symbol = normalizeYFinanceJapanSymbol(value);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    output.push(symbol);
  }
  return output;
}

function browserStorage(): WatchListStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
