import {
  YFINANCE_JP_DEFAULT_SYMBOLS,
  YFINANCE_JP_SUPPORTED_INTERVALS,
} from '../providers/yfinance-jp';
import type { HistoryRange } from '../../src/datafeed';

export type JapanTimeframe = (typeof YFINANCE_JP_SUPPORTED_INTERVALS)[number];

export interface TimeframeOption {
  value: JapanTimeframe;
  label: string;
  lookbackDays: number;
}

const DAY_SECONDS = 86_400;

export const JAPAN_MARKET_CONFIG = Object.freeze({
  apiBaseUrl: '/yfinance-jp-api',
  defaultSymbol: YFINANCE_JP_DEFAULT_SYMBOLS[0],
  defaultTimeframe: '1d' as JapanTimeframe,
  historyLimit: 5_000,
  symbolSearchLimit: 20,
  symbolSearchDebounceMs: 180,
  defaultSymbols: YFINANCE_JP_DEFAULT_SYMBOLS,
});

/**
 * Explicit ranges request materially more intraday history than yfinance's safe
 * no-range defaults while staying inside commonly supported Yahoo horizons.
 */
export const JAPAN_TIMEFRAMES: readonly TimeframeOption[] = Object.freeze([
  { value: '1m', label: '1m', lookbackDays: 7 },
  { value: '5m', label: '5m', lookbackDays: 60 },
  { value: '15m', label: '15m', lookbackDays: 60 },
  { value: '30m', label: '30m', lookbackDays: 60 },
  { value: '1h', label: '1H', lookbackDays: 730 },
  { value: '4h', label: '4H', lookbackDays: 730 },
  { value: '1d', label: '1D', lookbackDays: 7_305 },
  { value: '1w', label: '1W', lookbackDays: 18_263 },
  { value: '1M', label: '1M', lookbackDays: 36_525 },
]);

export function historyRangeForTimeframe(
  timeframe: JapanTimeframe,
  nowSeconds = Math.floor(Date.now() / 1_000),
): HistoryRange {
  const option = JAPAN_TIMEFRAMES.find((item) => item.value === timeframe);
  if (!option) throw new Error(`Unsupported Japan timeframe: ${timeframe}`);
  return {
    from: nowSeconds - option.lookbackDays * DAY_SECONDS,
    to: nowSeconds,
  };
}
