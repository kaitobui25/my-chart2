import bollinger from './bollinger';
import ema from './ema';
import macd from './macd';
import rsi from './rsi';
import sma from './sma';
import { indicators as taSuite } from './ta-suite';
import visibleRangeExtrema from './visible-range-extrema';
import volume from './volume';
import type { IndicatorDef } from '../registry';

/** Pure OHLCV indicators that do not depend on market-specific repositories. */
export const builtinIndicators: readonly IndicatorDef[] = Object.freeze([
  volume,
  sma,
  ema,
  bollinger,
  visibleRangeExtrema,
  rsi,
  macd,
  ...taSuite,
]);
