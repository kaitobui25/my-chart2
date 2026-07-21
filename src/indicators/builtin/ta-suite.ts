import type { Candle, LinePoint } from '../../core/types';
import { atr, rsi, sourceValues, type Source } from '../index';
import { SOURCE_PARAM, type IndicatorCategory, type IndicatorDef, type ParamDef, type Params } from '../registry';

const lengthParam = (value = 14, max = 500): ParamDef => ({
  key: 'length', label: 'Length', type: 'int', default: value, min: 1, max,
});
const fastSlowParams = (fast = 12, slow = 26): ParamDef[] => [
  { key: 'fast', label: 'Fast Length', type: 'int', default: fast, min: 1, max: 500 },
  { key: 'slow', label: 'Slow Length', type: 'int', default: slow, min: 2, max: 500 },
];
const n = (params: Params, key: string, fallback: number): number => Number(params[key] ?? fallback);
const source = (params: Params): Source => String(params.source ?? 'close') as Source;
const blank = (size: number): LinePoint[] => new Array(size).fill(null);

function smaValues(values: readonly number[], period: number): LinePoint[] {
  const out = blank(values.length);
  if (period < 1) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function emaValues(values: readonly number[], period: number): LinePoint[] {
  const out = blank(values.length);
  if (period < 1 || values.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let value = seed / period;
  out[period - 1] = value;
  const alpha = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    value += alpha * (values[i] - value);
    out[i] = value;
  }
  return out;
}

function emaLine(values: readonly LinePoint[], period: number): LinePoint[] {
  const out = blank(values.length);
  const start = values.findIndex((value) => value !== null);
  if (start < 0) return out;
  const dense = values.slice(start).map((value) => value ?? 0);
  const computed = emaValues(dense, period);
  computed.forEach((value, index) => { out[start + index] = value; });
  return out;
}

function smaLine(values: readonly LinePoint[], period: number): LinePoint[] {
  const out = blank(values.length);
  const start = values.findIndex((value) => value !== null);
  if (start < 0) return out;
  const dense = values.slice(start).map((value) => value ?? 0);
  const computed = smaValues(dense, period);
  computed.forEach((value, index) => { out[start + index] = value; });
  return out;
}

function wmaValues(values: readonly number[], period: number): LinePoint[] {
  const out = blank(values.length);
  const denominator = period * (period + 1) / 2;
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let offset = 0; offset < period; offset++) sum += values[i - period + 1 + offset] * (offset + 1);
    out[i] = sum / denominator;
  }
  return out;
}

function wmaLine(values: readonly LinePoint[], period: number): LinePoint[] {
  const out = blank(values.length);
  const start = values.findIndex((value) => value !== null);
  if (start < 0) return out;
  const computed = wmaValues(values.slice(start).map((value) => value ?? 0), period);
  computed.forEach((value, index) => { out[start + index] = value; });
  return out;
}

function rollingExtremes(values: readonly number[], period: number): { high: LinePoint[]; low: LinePoint[] } {
  const high = blank(values.length);
  const low = blank(values.length);
  for (let i = period - 1; i < values.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      hi = Math.max(hi, values[j]);
      lo = Math.min(lo, values[j]);
    }
    high[i] = hi;
    low[i] = lo;
  }
  return { high, low };
}

function trueRange(candles: readonly Candle[]): number[] {
  return candles.map((candle, index) => {
    const previous = candles[index - 1]?.close ?? candle.close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previous), Math.abs(candle.low - previous));
  });
}

function wilderValues(values: readonly number[], period: number): LinePoint[] {
  const out = blank(values.length);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let average = sum / period;
  out[period - 1] = average;
  for (let i = period; i < values.length; i++) {
    average = (average * (period - 1) + values[i]) / period;
    out[i] = average;
  }
  return out;
}

function wilderLine(values: readonly LinePoint[], period: number): LinePoint[] {
  const out = blank(values.length);
  const start = values.findIndex((value) => value !== null);
  if (start < 0) return out;
  const computed = wilderValues(values.slice(start).map((value) => value!), period);
  computed.forEach((value, index) => { out[start + index] = value; });
  return out;
}

function rollingStats(values: readonly number[], period: number): { mean: LinePoint[]; variance: LinePoint[]; stddev: LinePoint[] } {
  const mean = smaValues(values, period);
  const variance = blank(values.length);
  const stddev = blank(values.length);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += (values[j] - mean[i]!) ** 2;
    variance[i] = sum / period;
    stddev[i] = Math.sqrt(variance[i]!);
  }
  return { mean, variance, stddev };
}

type Outputs = Record<string, LinePoint[]>;
interface IndicatorSpec {
  id: string;
  name: string;
  category: IndicatorCategory;
  params?: ParamDef[];
  compute(candles: readonly Candle[], params: Params): Outputs;
  histogram?: boolean;
}

function makeDef(spec: IndicatorSpec, order: number): IndicatorDef {
  return {
    id: spec.id,
    name: spec.name,
    category: spec.category,
    params: spec.params,
    order,
    create(chart, params) {
      const pane = spec.category === 'overlay' ? undefined : chart.addPane(1);
      const initial = spec.compute(chart.getCandles(), params);
      const entries = Object.keys(initial);
      const series = entries.map((label, index) => {
        const title = entries.length === 1 || label === spec.name ? spec.name : `${spec.name} ${label}`;
        if (spec.histogram && index === 0) return chart.addHistogram({ title, pane });
        return chart.addLine({ title, pane, color: chart.theme.palette[index % chart.theme.palette.length] });
      });
      return {
        recompute: () => {
          const outputs = spec.compute(chart.getCandles(), params);
          entries.forEach((key, index) => series[index].setData(outputs[key]));
        },
        remove: () => series.forEach((item) => chart.removeSeries(item)),
      };
    },
  };
}

function directional(candles: readonly Candle[], period: number): { plus: LinePoint[]; minus: LinePoint[]; dx: LinePoint[]; adx: LinePoint[] } {
  const tr = trueRange(candles);
  const plusDm = candles.map((candle, index) => {
    if (!index) return 0;
    const up = candle.high - candles[index - 1].high;
    const down = candles[index - 1].low - candle.low;
    return up > down && up > 0 ? up : 0;
  });
  const minusDm = candles.map((candle, index) => {
    if (!index) return 0;
    const up = candle.high - candles[index - 1].high;
    const down = candles[index - 1].low - candle.low;
    return down > up && down > 0 ? down : 0;
  });
  const atrLine = wilderValues(tr, period);
  const plusSmooth = wilderValues(plusDm, period);
  const minusSmooth = wilderValues(minusDm, period);
  const plus = blank(candles.length);
  const minus = blank(candles.length);
  const dx = blank(candles.length);
  for (let i = period - 1; i < candles.length; i++) {
    if (!atrLine[i]) continue;
    plus[i] = 100 * plusSmooth[i]! / atrLine[i]!;
    minus[i] = 100 * minusSmooth[i]! / atrLine[i]!;
    const sum = plus[i]! + minus[i]!;
    dx[i] = sum ? 100 * Math.abs(plus[i]! - minus[i]!) / sum : 0;
  }
  return { plus, minus, dx, adx: wilderLine(dx, period) };
}

function stochastic(candles: readonly Candle[], period: number, smooth: number): Outputs {
  const highs = rollingExtremes(candles.map((c) => c.high), period).high;
  const lows = rollingExtremes(candles.map((c) => c.low), period).low;
  const k = blank(candles.length);
  for (let i = period - 1; i < candles.length; i++) {
    const range = highs[i]! - lows[i]!;
    k[i] = range ? 100 * (candles[i].close - lows[i]!) / range : 0;
  }
  return { '%K': k, '%D': smaLine(k, smooth) };
}

function aroon(candles: readonly Candle[], period: number): Outputs {
  const up = blank(candles.length);
  const down = blank(candles.length);
  for (let i = period - 1; i < candles.length; i++) {
    let highIndex = i - period + 1;
    let lowIndex = highIndex;
    for (let j = highIndex + 1; j <= i; j++) {
      if (candles[j].high >= candles[highIndex].high) highIndex = j;
      if (candles[j].low <= candles[lowIndex].low) lowIndex = j;
    }
    up[i] = 100 * (period - (i - highIndex)) / period;
    down[i] = 100 * (period - (i - lowIndex)) / period;
  }
  return { Up: up, Down: down };
}

function psar(candles: readonly Candle[], step: number, maximum: number): LinePoint[] {
  const out = blank(candles.length);
  if (candles.length < 2) return out;
  let rising = candles[1].close >= candles[0].close;
  let sar = rising ? candles[0].low : candles[0].high;
  let extreme = rising ? candles[0].high : candles[0].low;
  let acceleration = step;
  for (let i = 1; i < candles.length; i++) {
    sar += acceleration * (extreme - sar);
    if (rising) {
      sar = Math.min(sar, candles[i - 1].low, candles[i - 2]?.low ?? candles[i - 1].low);
      if (candles[i].low < sar) {
        rising = false; sar = extreme; extreme = candles[i].low; acceleration = step;
      } else if (candles[i].high > extreme) {
        extreme = candles[i].high; acceleration = Math.min(maximum, acceleration + step);
      }
    } else {
      sar = Math.max(sar, candles[i - 1].high, candles[i - 2]?.high ?? candles[i - 1].high);
      if (candles[i].high > sar) {
        rising = true; sar = extreme; extreme = candles[i].high; acceleration = step;
      } else if (candles[i].low < extreme) {
        extreme = candles[i].low; acceleration = Math.min(maximum, acceleration + step);
      }
    }
    out[i] = sar;
  }
  return out;
}

const specs: IndicatorSpec[] = [
  { id: 'wma', name: 'WMA', category: 'overlay', params: [lengthParam(20), SOURCE_PARAM], compute: (c, p) => ({ WMA: wmaValues(sourceValues(c, source(p)), n(p, 'length', 20)) }) },
  { id: 'dema', name: 'DEMA', category: 'overlay', params: [lengthParam(20), SOURCE_PARAM], compute: (c, p) => { const e1 = emaValues(sourceValues(c, source(p)), n(p, 'length', 20)); const e2 = emaLine(e1, n(p, 'length', 20)); return { DEMA: e1.map((v, i) => v !== null && e2[i] !== null ? 2 * v - e2[i]! : null) }; } },
  { id: 'tema', name: 'TEMA', category: 'overlay', params: [lengthParam(20), SOURCE_PARAM], compute: (c, p) => { const period = n(p, 'length', 20); const e1 = emaValues(sourceValues(c, source(p)), period); const e2 = emaLine(e1, period); const e3 = emaLine(e2, period); return { TEMA: e1.map((v, i) => v !== null && e2[i] !== null && e3[i] !== null ? 3 * v - 3 * e2[i]! + e3[i]! : null) }; } },
  { id: 'trima', name: 'TRIMA', category: 'overlay', params: [lengthParam(20), SOURCE_PARAM], compute: (c, p) => { const period = n(p, 'length', 20); const first = smaValues(sourceValues(c, source(p)), Math.ceil((period + 1) / 2)); return { TRIMA: smaLine(first, Math.floor((period + 1) / 2)) }; } },
  { id: 'kama', name: 'KAMA', category: 'overlay', params: [lengthParam(10), SOURCE_PARAM], compute: (c, p) => { const values = sourceValues(c, source(p)); const period = n(p, 'length', 10); const out = blank(values.length); if (values.length > period) { let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period; out[period - 1] = value; for (let i = period; i < values.length; i++) { let volatility = 0; for (let j = i - period + 1; j <= i; j++) volatility += Math.abs(values[j] - values[j - 1]); const er = volatility ? Math.abs(values[i] - values[i - period]) / volatility : 0; const sc = (er * (2 / 3 - 2 / 31) + 2 / 31) ** 2; value += sc * (values[i] - value); out[i] = value; } } return { KAMA: out }; } },
  { id: 'midpoint', name: 'Midpoint', category: 'overlay', params: [lengthParam(14), SOURCE_PARAM], compute: (c, p) => { const ex = rollingExtremes(sourceValues(c, source(p)), n(p, 'length', 14)); return { Midpoint: ex.high.map((v, i) => v !== null ? (v + ex.low[i]!) / 2 : null) }; } },
  { id: 'midprice', name: 'Midprice', category: 'overlay', params: [lengthParam(14)], compute: (c, p) => { const period = n(p, 'length', 14); const high = rollingExtremes(c.map((x) => x.high), period).high; const low = rollingExtremes(c.map((x) => x.low), period).low; return { Midprice: high.map((v, i) => v !== null ? (v + low[i]!) / 2 : null) }; } },
  { id: 'psar', name: 'Parabolic SAR', category: 'overlay', params: [{ key: 'step', label: 'Step', type: 'float', default: 0.02, min: 0.001, max: 1, step: 0.01 }, { key: 'max', label: 'Maximum', type: 'float', default: 0.2, min: 0.01, max: 2, step: 0.01 }], compute: (c, p) => ({ SAR: psar(c, n(p, 'step', 0.02), n(p, 'max', 0.2)) }) },
  { id: 'hma', name: 'Hull MA', category: 'overlay', params: [lengthParam(20), SOURCE_PARAM], compute: (c, p) => { const period = n(p, 'length', 20); const values = sourceValues(c, source(p)); const half = wmaValues(values, Math.max(1, Math.floor(period / 2))); const full = wmaValues(values, period); const raw = half.map((v, i) => v !== null && full[i] !== null ? 2 * v - full[i]! : null); return { HMA: wmaLine(raw, Math.max(1, Math.round(Math.sqrt(period)))) }; } },
  { id: 'vwap', name: 'VWAP', category: 'overlay', params: [], compute: (c) => { let pv = 0; let volume = 0; return { VWAP: c.map((x) => { const v = x.volume ?? 0; pv += ((x.high + x.low + x.close) / 3) * v; volume += v; return volume ? pv / volume : x.close; }) }; } },
  { id: 'vwma', name: 'VWMA', category: 'overlay', params: [lengthParam(20), SOURCE_PARAM], compute: (c, p) => { const period = n(p, 'length', 20); const values = sourceValues(c, source(p)); const out = blank(c.length); let pv = 0; let volume = 0; for (let i = 0; i < c.length; i++) { const v = c[i].volume ?? 0; pv += values[i] * v; volume += v; if (i >= period) { const old = c[i - period].volume ?? 0; pv -= values[i - period] * old; volume -= old; } if (i >= period - 1) out[i] = volume ? pv / volume : values[i]; } return { VWMA: out }; } },
  { id: 'adx', name: 'ADX', category: 'oscillator', params: [lengthParam(14)], compute: (c, p) => { const d = directional(c, n(p, 'length', 14)); return { ADX: d.adx, '+DI': d.plus, '-DI': d.minus }; } },
  { id: 'aroon', name: 'Aroon', category: 'oscillator', params: [lengthParam(14)], compute: (c, p) => aroon(c, n(p, 'length', 14)) },
  { id: 'aroon-osc', name: 'Aroon Oscillator', category: 'oscillator', params: [lengthParam(14)], compute: (c, p) => { const values = aroon(c, n(p, 'length', 14)); return { Osc: values.Up.map((v, i) => v !== null ? v - values.Down[i]! : null) }; } },
  { id: 'bop', name: 'Balance of Power', category: 'oscillator', compute: (c) => ({ BOP: c.map((x) => x.high === x.low ? 0 : (x.close - x.open) / (x.high - x.low)) }) },
  { id: 'cci', name: 'CCI', category: 'oscillator', params: [lengthParam(20)], compute: (c, p) => { const period = n(p, 'length', 20); const values = c.map((x) => (x.high + x.low + x.close) / 3); const mean = smaValues(values, period); const out = blank(c.length); for (let i = period - 1; i < c.length; i++) { let deviation = 0; for (let j = i - period + 1; j <= i; j++) deviation += Math.abs(values[j] - mean[i]!); deviation /= period; out[i] = deviation ? (values[i] - mean[i]!) / (0.015 * deviation) : 0; } return { CCI: out }; } },
  { id: 'cmo', name: 'Chande Momentum', category: 'oscillator', params: [lengthParam(14), SOURCE_PARAM], compute: (c, p) => { const values = sourceValues(c, source(p)); const period = n(p, 'length', 14); const out = blank(c.length); for (let i = period; i < values.length; i++) { let gains = 0; let losses = 0; for (let j = i - period + 1; j <= i; j++) { const delta = values[j] - values[j - 1]; gains += Math.max(0, delta); losses += Math.max(0, -delta); } out[i] = gains + losses ? 100 * (gains - losses) / (gains + losses) : 0; } return { CMO: out }; } },
  { id: 'dx', name: 'Directional Movement Index', category: 'oscillator', params: [lengthParam(14)], compute: (c, p) => ({ DX: directional(c, n(p, 'length', 14)).dx }) },
  { id: 'mfi', name: 'Money Flow Index', category: 'volume', params: [lengthParam(14)], compute: (c, p) => { const period = n(p, 'length', 14); const typical = c.map((x) => (x.high + x.low + x.close) / 3); const out = blank(c.length); for (let i = period; i < c.length; i++) { let positive = 0; let negative = 0; for (let j = i - period + 1; j <= i; j++) { const flow = typical[j] * (c[j].volume ?? 0); if (typical[j] >= typical[j - 1]) positive += flow; else negative += flow; } out[i] = negative ? 100 - 100 / (1 + positive / negative) : 100; } return { MFI: out }; } },
  { id: 'momentum', name: 'Momentum', category: 'oscillator', params: [lengthParam(10), SOURCE_PARAM], compute: (c, p) => { const values = sourceValues(c, source(p)); const period = n(p, 'length', 10); return { MOM: values.map((value, i) => i >= period ? value - values[i - period] : null) }; } },
  { id: 'ppo', name: 'PPO', category: 'oscillator', params: [...fastSlowParams(), SOURCE_PARAM], compute: (c, p) => { const values = sourceValues(c, source(p)); const fast = emaValues(values, n(p, 'fast', 12)); const slow = emaValues(values, n(p, 'slow', 26)); return { PPO: fast.map((v, i) => v !== null && slow[i] ? 100 * (v - slow[i]!) / slow[i]! : null) }; } },
  { id: 'roc', name: 'Rate of Change', category: 'oscillator', params: [lengthParam(10), SOURCE_PARAM], compute: (c, p) => { const values = sourceValues(c, source(p)); const period = n(p, 'length', 10); return { ROC: values.map((value, i) => i >= period && values[i - period] ? 100 * (value / values[i - period] - 1) : null) }; } },
  { id: 'stochastic', name: 'Stochastic', category: 'oscillator', params: [lengthParam(14), { key: 'smooth', label: 'Smooth', type: 'int', default: 3, min: 1, max: 50 }], compute: (c, p) => stochastic(c, n(p, 'length', 14), n(p, 'smooth', 3)) },
  { id: 'stoch-rsi', name: 'Stochastic RSI', category: 'oscillator', params: [lengthParam(14), { key: 'smooth', label: 'Smooth', type: 'int', default: 3, min: 1, max: 50 }], compute: (c, p) => { const period = n(p, 'length', 14); const r = rsi(c, period); const start = r.findIndex((value) => value !== null); const k = blank(r.length); if (start >= 0) { const dense = r.slice(start).map((value) => value!); const ex = rollingExtremes(dense, period); dense.forEach((value, index) => { if (ex.high[index] === null) return; const range = ex.high[index]! - ex.low[index]!; k[start + index] = range ? 100 * (value - ex.low[index]!) / range : 0; }); } return { '%K': k, '%D': smaLine(k, n(p, 'smooth', 3)) }; } },
  { id: 'trix', name: 'TRIX', category: 'oscillator', params: [lengthParam(15), SOURCE_PARAM], compute: (c, p) => { const period = n(p, 'length', 15); const e1 = emaValues(sourceValues(c, source(p)), period); const e2 = emaLine(e1, period); const e3 = emaLine(e2, period); return { TRIX: e3.map((value, i) => value !== null && i > 0 && e3[i - 1] ? 100 * (value / e3[i - 1]! - 1) : null) }; } },
  { id: 'ultimate-osc', name: 'Ultimate Oscillator', category: 'oscillator', params: [], compute: (c) => { const bp = c.map((x, i) => x.close - Math.min(x.low, c[i - 1]?.close ?? x.close)); const tr = c.map((x, i) => Math.max(x.high, c[i - 1]?.close ?? x.close) - Math.min(x.low, c[i - 1]?.close ?? x.close)); const avg = (i: number, period: number) => { let b = 0; let t = 0; for (let j = i - period + 1; j <= i; j++) { b += bp[j]; t += tr[j]; } return t ? b / t : 0; }; return { UO: c.map((_, i) => i >= 27 ? 100 * (4 * avg(i, 7) + 2 * avg(i, 14) + avg(i, 28)) / 7 : null) }; } },
  { id: 'williams-r', name: 'Williams %R', category: 'oscillator', params: [lengthParam(14)], compute: (c, p) => { const period = n(p, 'length', 14); const high = rollingExtremes(c.map((x) => x.high), period).high; const low = rollingExtremes(c.map((x) => x.low), period).low; return { '%R': c.map((x, i) => high[i] !== null && high[i] !== low[i] ? -100 * (high[i]! - x.close) / (high[i]! - low[i]!) : null) }; } },
  { id: 'awesome-osc', name: 'Awesome Oscillator', category: 'oscillator', compute: (c) => { const median = c.map((x) => (x.high + x.low) / 2); const fast = smaValues(median, 5); const slow = smaValues(median, 34); return { AO: fast.map((v, i) => v !== null && slow[i] !== null ? v - slow[i]! : null) }; }, histogram: true },
  { id: 'force-index', name: 'Force Index', category: 'volume', params: [lengthParam(13)], compute: (c, p) => { const raw = c.map((x, i) => i ? (x.close - c[i - 1].close) * (x.volume ?? 0) : 0); return { Force: emaValues(raw, n(p, 'length', 13)) }; } },
  { id: 'obv', name: 'On Balance Volume', category: 'volume', compute: (c) => { let total = 0; return { OBV: c.map((x, i) => { if (i) total += x.close > c[i - 1].close ? (x.volume ?? 0) : x.close < c[i - 1].close ? -(x.volume ?? 0) : 0; return total; }) }; } },
  { id: 'adl', name: 'Accumulation/Distribution', category: 'volume', compute: (c) => { let total = 0; return { ADL: c.map((x) => { const range = x.high - x.low; total += (range ? ((2 * x.close - x.low - x.high) / range) : 0) * (x.volume ?? 0); return total; }) }; } },
  { id: 'adosc', name: 'Chaikin Oscillator', category: 'volume', params: fastSlowParams(3, 10), compute: (c, p) => { let total = 0; const ad = c.map((x) => { const range = x.high - x.low; total += (range ? ((2 * x.close - x.low - x.high) / range) : 0) * (x.volume ?? 0); return total; }); const fast = emaValues(ad, n(p, 'fast', 3)); const slow = emaValues(ad, n(p, 'slow', 10)); return { Chaikin: fast.map((v, i) => v !== null && slow[i] !== null ? v - slow[i]! : null) }; } },
  { id: 'cmf', name: 'Chaikin Money Flow', category: 'volume', params: [lengthParam(20)], compute: (c, p) => { const period = n(p, 'length', 20); const mfv = c.map((x) => { const range = x.high - x.low; return (range ? (2 * x.close - x.low - x.high) / range : 0) * (x.volume ?? 0); }); const out = blank(c.length); for (let i = period - 1; i < c.length; i++) { let flow = 0; let volume = 0; for (let j = i - period + 1; j <= i; j++) { flow += mfv[j]; volume += c[j].volume ?? 0; } out[i] = volume ? flow / volume : 0; } return { CMF: out }; } },
  { id: 'atr', name: 'ATR', category: 'oscillator', params: [lengthParam(14)], compute: (c, p) => ({ ATR: atr(c, n(p, 'length', 14)) }) },
  { id: 'natr', name: 'Normalized ATR', category: 'oscillator', params: [lengthParam(14)], compute: (c, p) => { const values = atr(c, n(p, 'length', 14)); return { NATR: values.map((value, i) => value !== null && c[i].close ? 100 * value / c[i].close : null) }; } },
  { id: 'true-range', name: 'True Range', category: 'oscillator', compute: (c) => ({ TR: trueRange(c) }) },
  { id: 'keltner', name: 'Keltner Channels', category: 'overlay', params: [lengthParam(20), { key: 'mult', label: 'ATR Multiplier', type: 'float', default: 2, min: 0.1, max: 20, step: 0.1 }], compute: (c, p) => { const period = n(p, 'length', 20); const middle = emaValues(c.map((x) => (x.high + x.low + x.close) / 3), period); const range = atr(c, period); const mult = n(p, 'mult', 2); return { Upper: middle.map((v, i) => v !== null && range[i] !== null ? v + mult * range[i]! : null), Middle: middle, Lower: middle.map((v, i) => v !== null && range[i] !== null ? v - mult * range[i]! : null) }; } },
  { id: 'donchian', name: 'Donchian Channels', category: 'overlay', params: [lengthParam(20)], compute: (c, p) => { const period = n(p, 'length', 20); const high = rollingExtremes(c.map((x) => x.high), period).high; const low = rollingExtremes(c.map((x) => x.low), period).low; return { Upper: high, Middle: high.map((v, i) => v !== null ? (v + low[i]!) / 2 : null), Lower: low }; } },
  { id: 'stddev', name: 'Standard Deviation', category: 'oscillator', params: [lengthParam(20), SOURCE_PARAM], compute: (c, p) => ({ StdDev: rollingStats(sourceValues(c, source(p)), n(p, 'length', 20)).stddev }) },
  { id: 'variance', name: 'Variance', category: 'oscillator', params: [lengthParam(20), SOURCE_PARAM], compute: (c, p) => ({ Variance: rollingStats(sourceValues(c, source(p)), n(p, 'length', 20)).variance }) },
  { id: 'linear-regression', name: 'Linear Regression', category: 'overlay', params: [lengthParam(14), SOURCE_PARAM], compute: (c, p) => { const values = sourceValues(c, source(p)); const period = n(p, 'length', 14); const out = blank(c.length); const xMean = (period - 1) / 2; let xVar = 0; for (let x = 0; x < period; x++) xVar += (x - xMean) ** 2; for (let i = period - 1; i < values.length; i++) { let yMean = 0; for (let j = 0; j < period; j++) yMean += values[i - period + 1 + j]; yMean /= period; let covariance = 0; for (let j = 0; j < period; j++) covariance += (j - xMean) * (values[i - period + 1 + j] - yMean); const slope = covariance / xVar; out[i] = yMean + slope * xMean; } return { LinReg: out }; } },
  { id: 'zscore', name: 'Z-Score', category: 'oscillator', params: [lengthParam(20), SOURCE_PARAM], compute: (c, p) => { const values = sourceValues(c, source(p)); const stats = rollingStats(values, n(p, 'length', 20)); return { Z: values.map((value, i) => stats.stddev[i] ? (value - stats.mean[i]!) / stats.stddev[i]! : null) }; } },
];

export const indicators: IndicatorDef[] = specs.map((spec, index) => makeDef(spec, 100 + index));
