import type { Candle } from '../../src/core/types';
import type { HistoryRange } from '../../src/datafeed';
import {
  isVietnamTradingSession,
  VnstockDatafeed as RawVnstockDatafeed,
  type VnstockDatafeedOptions,
} from './vnstock';

export type { VnstockHealth } from './vnstock';

const CRYPTO_QUOTE_ASSETS = [
  'USDT',
  'USDC',
  'FDUSD',
  'BUSD',
  'TUSD',
  'DAI',
  'BTC',
  'ETH',
  'BNB',
] as const;
const SESSION_RECHECK_MS = 60_000;

/**
 * Conservative market-routing guard for the Vnstock workstation provider.
 *
 * Vnstock remains the authority for whether a Vietnam-market ticker actually
 * exists. This function only rejects symbols that are clearly cross-market
 * crypto pairs, while leaving equities, indices, derivatives, and warrants for
 * the provider itself to validate. Keeping the guard conservative avoids
 * hard-coding the full Vietnam instrument catalogue in the browser.
 */
export function isVnstockRoutableSymbol(symbol: string): boolean {
  const normalized = symbol.trim().toUpperCase();
  if (!normalized || !/^[A-Z0-9]+$/.test(normalized)) return false;
  return !CRYPTO_QUOTE_ASSETS.some((quote) => (
    normalized.length > quote.length + 1 && normalized.endsWith(quote)
  ));
}

/**
 * Workstation-facing Vnstock datafeed with a hard market-routing boundary.
 *
 * The UI also filters its watchlist before subscribing, but every public data
 * entry point repeats the guard here. A stale tile, autosave snapshot, or future
 * caller therefore cannot turn BTCUSDT/ETHUSDT-style symbols into Vnstock HTTP
 * requests. Watchlist polling is also detached outside Vietnam trading hours;
 * the lightweight local session check wakes once per minute and reconnects the
 * underlying Vnstock subscription when the market opens again.
 */
export class VnstockDatafeed extends RawVnstockDatafeed {
  private readonly routedWatchlistStops = new Set<() => void>();

  constructor(baseUrl = '/vnstock-api', options: VnstockDatafeedOptions = {}) {
    super(baseUrl, options);
  }

  override async getCachedHistory(
    symbol: string,
    interval: string,
    limit = 500,
    range?: HistoryRange,
  ): Promise<Candle[]> {
    if (!isVnstockRoutableSymbol(symbol)) return [];
    return super.getCachedHistory(symbol, interval, limit, range);
  }

  override async getHistory(
    symbol: string,
    interval: string,
    limit = 500,
    range?: HistoryRange,
  ): Promise<Candle[]> {
    if (!isVnstockRoutableSymbol(symbol)) return [];
    return super.getHistory(symbol, interval, limit, range);
  }

  override subscribe(
    symbol: string,
    interval: string,
    onCandle: (candle: Candle) => void,
  ): () => void {
    if (!isVnstockRoutableSymbol(symbol)) return () => undefined;
    return super.subscribe(symbol, interval, onCandle);
  }

  override subscribeMany(
    symbols: string[],
    interval: string,
    onCandle: (symbol: string, candle: Candle) => void,
  ): () => void {
    const routable = symbols.filter(isVnstockRoutableSymbol);
    if (routable.length === 0) return () => undefined;

    let active = true;
    let innerUnsubscribe: (() => void) | null = null;
    let sessionTimer: ReturnType<typeof setTimeout> | null = null;

    const syncSession = () => {
      if (!active) return;
      if (isVietnamTradingSession(new Date())) {
        innerUnsubscribe ??= super.subscribeMany(routable, interval, onCandle);
      } else if (innerUnsubscribe) {
        innerUnsubscribe();
        innerUnsubscribe = null;
      }
      sessionTimer = setTimeout(syncSession, SESSION_RECHECK_MS);
    };

    const stop = () => {
      if (!active) return;
      active = false;
      if (sessionTimer) clearTimeout(sessionTimer);
      sessionTimer = null;
      innerUnsubscribe?.();
      innerUnsubscribe = null;
      this.routedWatchlistStops.delete(stop);
    };

    this.routedWatchlistStops.add(stop);
    syncSession();
    return stop;
  }

  override dispose(): void {
    for (const stop of [...this.routedWatchlistStops]) stop();
    super.dispose();
  }
}
