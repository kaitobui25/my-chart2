import type { Candle, LinePoint } from '../core/types';

/**
 * Indicators are pure functions: (candles, params) -> value arrays aligned to
 * candle indices, null during warm-up. Adding a new indicator = adding a function.
 */

export type Source = 'open' | 'high' | 'low' | 'close' | 'hl2' | 'hlc3';

export function sourceValues(candles: readonly Candle[], source: Source = 'close'): number[] {
  return candles.map((c) => {
    switch (source) {
      case 'open': return c.open;
      case 'high': return c.high;
      case 'low': return c.low;
      case 'hl2': return (c.high + c.low) / 2;
      case 'hlc3': return (c.high + c.low + c.close) / 3;
      default: return c.close;
    }
  });
}
export function sma(candles: readonly Candle[], period: number, source: Source = 'close'): LinePoint[] {
  const src = sourceValues(candles, source);
  const out: LinePoint[] = new Array(src.length).fill(null);
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    sum += src[i];
    if (i >= period) sum -= src[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(candles: readonly Candle[], period: number, source: Source = 'close'): LinePoint[] {
  const src = sourceValues(candles, source);
  return emaOf(src, period);
}

function emaOf(src: readonly number[], period: number): LinePoint[] {
  const out: LinePoint[] = new Array(src.length).fill(null);
  if (src.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += src[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < src.length; i++) {
    prev = src[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rsi(candles: readonly Candle[], period = 14): LinePoint[] {
  const src = sourceValues(candles, 'close');
  const out: LinePoint[] = new Array(src.length).fill(null);
  if (src.length <= period) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = src[i] - src[i - 1];
    if (d > 0) avgGain += d;
    else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < src.length; i++) {
    const d = src[i] - src[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export interface MacdResult {
  macd: LinePoint[];
  signal: LinePoint[];
  histogram: LinePoint[];
}

export function macd(candles: readonly Candle[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const src = sourceValues(candles, 'close');
  const emaFast = emaOf(src, fast);
  const emaSlow = emaOf(src, slow);
  const macdLine: LinePoint[] = src.map((_, i) =>
    emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i]! - emaSlow[i]! : null,
  );
  // Signal = EMA of the MACD line, starting where MACD becomes defined.
  const start = macdLine.findIndex((v) => v !== null);
  const signal: LinePoint[] = new Array(src.length).fill(null);
  if (start >= 0) {
    const defined = macdLine.slice(start) as number[];
    const sig = emaOf(defined, signalPeriod);
    for (let i = 0; i < sig.length; i++) signal[start + i] = sig[i];
  }
  const histogram: LinePoint[] = macdLine.map((v, i) =>
    v !== null && signal[i] !== null ? v - signal[i]! : null,
  );
  return { macd: macdLine, signal, histogram };
}

export interface BollingerResult {
  upper: LinePoint[];
  middle: LinePoint[];
  lower: LinePoint[];
}

export function bollinger(
  candles: readonly Candle[],
  period = 20,
  mult = 2,
  source: Source = 'close',
): BollingerResult {
  const src = sourceValues(candles, source);
  const middle = sma(candles, period, source);
  const upper: LinePoint[] = new Array(src.length).fill(null);
  const lower: LinePoint[] = new Array(src.length).fill(null);
  for (let i = period - 1; i < src.length; i++) {
    const mean = middle[i]!;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) {
      variance += (src[j] - mean) ** 2;
    }
    const sd = Math.sqrt(variance / period);
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { upper, middle, lower };
}

export function volumes(candles: readonly Candle[]): LinePoint[] {
  return candles.map((c) => c.volume ?? null);
}

/** Average True Range (Wilder smoothing). */
export function atr(candles: readonly Candle[], period = 14): LinePoint[] {
  const out: LinePoint[] = new Array(candles.length).fill(null);
  let sum = 0;
  let prev = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const pc = i > 0 ? candles[i - 1].close : null;
    const tr =
      pc === null
        ? c.high - c.low
        : Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    if (i < period) {
      sum += tr;
      if (i === period - 1) {
        prev = sum / period;
        out[i] = prev;
      }
    } else {
      prev = (prev * (period - 1) + tr) / period;
      out[i] = prev;
    }
  }
  return out;
}
