import type { Candle } from './types';

/** Tao mot nen Heikin Ashi tu nen gia that va nen HA truoc do. */
export function heikinAshiCandle(candle: Candle, previousHeikinAshi?: Candle): Candle {
  const close = (candle.open + candle.high + candle.low + candle.close) / 4;
  const open = previousHeikinAshi
    ? (previousHeikinAshi.open + previousHeikinAshi.close) / 2
    : (candle.open + candle.close) / 2;

  const result: Candle = {
    time: candle.time,
    open,
    high: Math.max(candle.high, open, close),
    low: Math.min(candle.low, open, close),
    close,
  };
  if (candle.volume !== undefined) result.volume = candle.volume;
  return result;
}

/** Chuyen ca chuoi OHLC that sang Heikin Ashi ma khong sua du lieu dau vao. */
export function heikinAshi(candles: readonly Candle[]): Candle[] {
  const result: Candle[] = [];
  let previousHeikinAshi: Candle | undefined;

  for (const candle of candles) {
    // HA Open dung nen HA truoc, khong dung truc tiep nen gia that truoc.
    const next = heikinAshiCandle(candle, previousHeikinAshi);
    result.push(next);
    previousHeikinAshi = next;
  }

  return result;
}
