import type { Candle } from '../../core/types';

const VIETNAM_UTC_OFFSET_SECONDS = 7 * 60 * 60;
const VIETNAM_EQUITY_TICKER = /^[A-Z]{3}$/;

export interface InstitutionalFlowMonth {
  period: string;
  foreignNetValueVnd: number | null;
  proprietaryNetValueVnd: number | null;
}

export interface InstitutionalFlowPoint {
  foreign: number | null;
  proprietary: number | null;
}

export interface InstitutionalFlowRange {
  from: string;
  to: string;
}

export function isInstitutionalFlowVietnamEquitySymbol(symbol: string): boolean {
  return VIETNAM_EQUITY_TICKER.test(symbol.trim().toUpperCase());
}

/** Calendar month in Vietnam, independent of the browser/OS timezone. */
export function vietnamMonthKey(timeSeconds: number): string {
  const date = new Date((timeSeconds + VIETNAM_UTC_OFFSET_SECONDS) * 1000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function institutionalFlowRangeForCandles(
  candles: readonly Candle[],
): InstitutionalFlowRange | null {
  if (candles.length === 0) return null;
  return {
    from: vietnamMonthKey(candles[0].time),
    to: vietnamMonthKey(candles[candles.length - 1].time),
  };
}

/** Align sparse monthly flow data to the chart's candle indices. */
export function alignInstitutionalFlowToCandles(
  candles: readonly Candle[],
  months: readonly InstitutionalFlowMonth[],
): InstitutionalFlowPoint[] {
  const byPeriod = new Map(months.map((month) => [month.period, month]));
  return candles.map((candle) => {
    const month = byPeriod.get(vietnamMonthKey(candle.time));
    return {
      foreign: month?.foreignNetValueVnd ?? null,
      proprietary: month?.proprietaryNetValueVnd ?? null,
    };
  });
}
