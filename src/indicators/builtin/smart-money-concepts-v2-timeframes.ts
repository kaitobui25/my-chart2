import type { Candle } from '../../core/types';
import { intervalStart } from '../../interval';
import type { SmcV2Options, SmcV2PeriodLevel } from './smart-money-concepts-v2-model';

export interface SmcTimeframeOptions {
  periodUtcOffsetHours: number;
  chartIntervalSeconds?: number;
  /** Pine timeframe string, useful when interval seconds cannot distinguish calendar frames. */
  chartTimeframe?: string;
  /** Authoritative exchange bars, including bars preceding the chart's loaded history. */
  periodCandles?: Partial<Record<'D' | 'W' | 'M', readonly Candle[]>>;
}

interface Frame {
  seconds: number;
  count: number;
  unit: 'S' | 'minute' | 'D' | 'W' | 'M';
}

export interface SmcTimeframe {
  candles: readonly Candle[];
  /** request.security(..., lookahead_on): current requested bar at each chart index. */
  at: number[];
  keys: number[];
  firstIndices: number[];
}

function frame(value: string): Frame {
  const match = /^(\d*)(S|D|W|M)?$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new RangeError(`Unsupported SMC timeframe: ${value}`);
  const count = match[1] ? Number(match[1]) : 1;
  if (count < 1) throw new RangeError('SMC timeframe must be positive');
  const unit = (match[2] || 'minute') as Frame['unit'];
  const seconds = count * ({ S: 1, minute: 60, D: 86400, W: 604800, M: 2628000 }[unit]);
  return { count, unit, seconds };
}

function chartSeconds(candles: readonly Candle[], options: SmcTimeframeOptions): number {
  if (options.chartTimeframe) return frame(options.chartTimeframe).seconds;
  if (options.chartIntervalSeconds !== undefined) return options.chartIntervalSeconds;
  const diffs = candles.slice(1).map((c, i) => c.time - candles[i].time).filter(d => d > 0).sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)] ?? 60;
}

/** Calendar fallback for continuous markets; exchange session bars should be supplied explicitly. */
function frameKey(time: number, spec: Frame, offsetHours: number): number {
  if (spec.count === 1 && (spec.unit === 'D' || spec.unit === 'W' || spec.unit === 'M')) {
    const interval = spec.unit === 'D' ? '1d' : spec.unit === 'W' ? '1w' : '1M';
    return intervalStart(time, interval, offsetHours * 60);
  }
  const shifted = time + offsetHours * 3600;
  const date = new Date(shifted * 1000);
  let key: number;
  if (spec.unit === 'M') {
    const month = date.getUTCFullYear() * 12 + date.getUTCMonth();
    const start = Math.floor(month / spec.count) * spec.count;
    key = Date.UTC(Math.floor(start / 12), start % 12, 1) / 1000;
  } else if (spec.unit === 'W') {
    // 1970-01-05 was Monday, matching Pine's calendar week convention.
    key = Math.floor((shifted - 345600) / spec.seconds) * spec.seconds + 345600;
  } else {
    key = Math.floor(shifted / spec.seconds) * spec.seconds;
  }
  return key - offsetHours * 3600;
}

function indexAtOrBefore(candles: readonly Candle[], time: number): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (candles[middle].time <= time) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

function chartIndexAtOrAfter(candles: readonly Candle[], time: number): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (candles[middle].time < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Mirrors historical lookahead_on, including unoffset current HTF high/low in DucTri FVG.
 * https://www.tradingview.com/pine-script-docs/concepts/other-timeframes-and-data/#lookahead
 */
export function buildSmcTimeframe(
  candles: readonly Candle[], timeframe: string, options: SmcTimeframeOptions, supplied?: readonly Candle[],
): SmcTimeframe {
  const same = timeframe === '' || timeframe === 'chart' || timeframe === options.chartTimeframe;
  const requested = same ? null : frame(timeframe);
  const seconds = chartSeconds(candles, options);
  const lower = requested !== null && requested.seconds < seconds;
  if (lower && !supplied) throw new RangeError('SMC lower-timeframe requests require fvgCandles from the data provider');
  if (supplied) {
    const at = candles.map(candle => {
      if (!lower) return indexAtOrBefore(supplied, candle.time);
      // Historical request.security with lookahead_on selects the FIRST intrabar, not the last.
      const first = chartIndexAtOrAfter(supplied, candle.time);
      return first < supplied.length && supplied[first].time < candle.time + seconds ? first : -1;
    });
    return {
      candles: supplied, at,
      keys: candles.map((c, i) => lower && requested ? frameKey(c.time, requested, options.periodUtcOffsetHours) : supplied[at[i]]?.time ?? NaN),
      firstIndices: supplied.map(c => chartIndexAtOrAfter(candles, c.time)),
    };
  }
  if (same || requested?.seconds === seconds) {
    return { candles, at: candles.map((_, i) => i), keys: candles.map(c => c.time), firstIndices: candles.map((_, i) => i) };
  }
  const aggregated: Candle[] = [];
  const at: number[] = [];
  const keys: number[] = [];
  const firstIndices: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const key = frameKey(c.time, requested!, options.periodUtcOffsetHours);
    if (i === 0 || key !== keys[i - 1]) {
      aggregated.push({ ...c, time: key });
      firstIndices.push(i);
    } else {
      const current = aggregated[aggregated.length - 1];
      current.high = Math.max(current.high, c.high);
      current.low = Math.min(current.low, c.low);
      current.close = c.close;
    }
    keys.push(key);
    at.push(aggregated.length - 1);
  }
  return { candles: aggregated, at, keys, firstIndices };
}

export function smcPeriodLevels(candles: readonly Candle[], options: SmcV2Options): SmcV2PeriodLevel[] {
  const levels: SmcV2PeriodLevel[] = [];
  const seconds = chartSeconds(candles, options);
  for (const [label, enabled] of [
    ['D', options.showDailyLevels], ['W', options.showWeeklyLevels], ['M', options.showMonthlyLevels],
  ] as const) {
    const target = frame(label);
    if (!enabled || seconds > target.seconds || candles.length === 0) continue;
    const same = options.chartTimeframe ? options.chartTimeframe === label || options.chartTimeframe === `1${label}` : seconds === target.seconds;
    const frames = buildSmcTimeframe(candles, label, options, options.periodCandles?.[label]);
    // Pine drawLevels owns one persistent pair per timeframe; only the latest levels survive.
    const endIndex = candles.length - 1;
    const current = frames.at[endIndex];
    const source = same ? candles[endIndex] : frames.candles[current - 1];
    if (!source) continue;
    const startTime = same ? source.time : frames.candles[current - 1].time;
    const endTime = same ? source.time : frames.candles[current].time;
    let highIndex = endIndex;
    let lowIndex = endIndex;
    if (!same) {
      const first = chartIndexAtOrAfter(candles, startTime);
      const last = chartIndexAtOrAfter(candles, endTime);
      highIndex = lowIndex = first < last ? first : 0;
      for (let i = first + 1; i < last; i++) {
        if (candles[i].high > candles[highIndex].high) highIndex = i;
        if (candles[i].low < candles[lowIndex].low) lowIndex = i;
      }
    }
    levels.push({ startIndex: Math.min(highIndex, lowIndex), endIndex, high: source.high, low: source.low, highIndex, lowIndex, label });
  }
  return levels;
}
