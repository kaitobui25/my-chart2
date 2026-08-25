const VIETNAM_EQUITY_TICKER = /^[A-Z]{3}$/;

/**
 * P/E V1 is backed by Vnstock/FiinQuant Vietnam-equity fundamentals.
 * Keep unsupported instruments out before any cache or network work starts.
 *
 * Current listed Vietnam equities use three-letter alphabetic tickers. This
 * deliberately excludes indices, derivatives, warrants, and crypto pairs.
 */
export function isPeEligibleVietnamEquitySymbol(symbol: string): boolean {
  return VIETNAM_EQUITY_TICKER.test(symbol.trim().toUpperCase());
}
