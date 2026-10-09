import type { Candle } from '../../src/core/types';
import type { IndicatorDebugSnapshot, Params } from '../../src/indicators/registry';
import type { SmcResult } from '../../src/indicators/builtin/smart-money-concepts-model';
import {
  smcV2FibLevels,
  smcV2PremiumDiscountZones,
  type SmcV2Result,
} from '../../src/indicators/builtin/smart-money-concepts-v2-model';

export const SMC_IDS = new Set([
  'smart-money-concepts',
  'smart-money-concepts-v2',
  'smart-money-concepts-v3',
]);

export interface SmcExportIndicator {
  id: string;
  name: string;
  params: Params;
  snapshot: IndicatorDebugSnapshot;
}

export interface VisibleSmcExportInput {
  symbol: string;
  timeframe: string;
  source: 'market' | 'sheet';
  candles: readonly Candle[];
  visibleRange: { from: number; to: number } | null;
  indicators: readonly SmcExportIndicator[];
  exportedAt?: string;
}

const ORIGINAL_RULES = {
  reference: 'src/indicators/builtin/smart-money-concepts-model.ts',
  pivot: 'high/low strictly exceeds both neighboring windows of swingLength or internalLength bars; confirmed after length bars',
  structure: 'bullish: close > confirmed, unbroken pivot high; bearish: close < confirmed, unbroken pivot low; BOS/CHoCH depends on prior bias',
  orderBlock: 'last opposite-color candle within 100 bars before a Swing break; removed on close outside the block',
  fairValueGap: 'bullish: low[i] > high[i-2]; bearish: high[i] < low[i-2]; removed when a wick fills the gap',
} as const;

const V2_RULES = {
  reference: 'ref/indicator/02_SMC_ductri.pine; docs/SMC_V2_PARITY.md',
  pivot: 'right-window confirmed leg change, inclusive high/low comparisons, lengths from params',
  structure: 'bullish: close[i] > level[i] && close[i-1] <= level[i-1]; bearish: close[i] < level[i] && close[i-1] >= level[i-1]',
  confluence: 'upper = high - max(close, open); lower = min(close, open - low); internal uses upper > lower (bullish), upper < lower (bearish)',
  atr200: 'TR = max(high-low, abs(high-prevClose), abs(low-prevClose)); ATR200 seeded with SMA(TR[0..199]), then RMA length 200',
  orderBlock: 'search parsed high/low within [pivot, breakout), excluding breakout; remove on strictly breached wick/close per mitigation parameter',
  fairValueGap: 'three requested-timeframe candles, middle-body percentage threshold; calculations depend on timeframe data and Pine lookahead semantics',
  fibonacci: 'level = start + (end-start) * ratio; chosen from trailing Swing extremes and configured direction',
  premiumDiscount: 'Premium top 5%, Equilibrium middle 5%, Discount bottom 5% of trailing extremes',
} as const;

const V3_RULES = {
  ...V2_RULES,
  reference: 'src/indicators/builtin/smart-money-concepts-v3-model.ts; docs/SMC_V3.md',
  structure: 'bullish: high[i] > protectedHigh; bearish: low[i] < protectedLow (strict wick breaks); BOS/CHoCH uses prior scope bias',
  protectedPivot: 'a raw candidate cannot replace an unbroken protected level; opposite pivot promotion occurs on a confirmed structure break',
} as const;

const within = (index: number, from: number, to: number) => index >= from && index <= to;
const overlaps = (start: number, end: number, from: number, to: number) => start <= to && end >= from;

/** Creates an audit view; all original bar indices remain absolute. */
export function buildVisibleSmcExport(input: VisibleSmcExportInput) {
  const { candles, visibleRange } = input;
  if (candles.length === 0 || !visibleRange) throw new Error('Chart chưa có vùng nến để export.');
  const from = Math.max(0, Math.ceil(visibleRange.from));
  const to = Math.min(candles.length - 1, Math.floor(visibleRange.to));
  if (from > to) throw new Error('Phạm vi nến hiện tại không hợp lệ.');

  const at = (index: number) => candles[index]?.time ?? null;
  const zone = <T extends { startIndex: number; endIndex: number }>(item: T) => ({
    ...item,
    startTime: at(item.startIndex),
    endTime: at(item.endIndex),
  });
  const structure = <T extends { index: number; originIndex: number; price: number }>(item: T, id: string) => ({
    ...item,
    time: at(item.index),
    originTime: at(item.originIndex),
    observed: {
      close: candles[item.index]?.close ?? null,
      previousClose: candles[item.index - 1]?.close ?? null,
      high: candles[item.index]?.high ?? null,
      low: candles[item.index]?.low ?? null,
      breakValue: id === 'smart-money-concepts-v3'
        ? (item as T & { direction: string }).direction === 'bullish' ? candles[item.index]?.high : candles[item.index]?.low
        : candles[item.index]?.close,
      level: item.price,
    },
  });
  const results = input.indicators.filter(({ id }) => SMC_IDS.has(id)).map((ind) => {
    const { id, name, params, snapshot } = ind;
    if (id === 'smart-money-concepts') {
      const result = snapshot.result as SmcResult;
      return {
        id, name, params, calculation: snapshot.calculation, rules: ORIGINAL_RULES,
        results: {
          structures: result.structures.filter(e => within(e.index, from, to)).map(e => structure(e, id)),
          swingPoints: result.swingPoints.filter(e => within(e.index, from, to)).map(e => ({ ...e, time: at(e.index) })),
          orderBlocks: result.orderBlocks.filter(e => overlaps(e.startIndex, e.endIndex, from, to)).map(zone),
          fairValueGaps: result.fairValueGaps.filter(e => overlaps(e.startIndex, e.endIndex, from, to)).map(zone),
        },
        limitations: ['Order blocks and fair value gaps contain only active inventory; mitigated historical zones are unavailable.'],
      };
    }

    const result = snapshot.result as SmcV2Result;
    const fibRatios = [0, 236, 382, 500, 618, 786, 1000]
      .filter(key => params[`showFib${key}`] !== false)
      .map(key => Number(params[`fibValue${key}`] ?? key / 1000));
    const derivedAt = (throughIndex: number) => ({
      index: throughIndex,
      time: at(throughIndex),
      fibonacci: params.showFib === true
        ? smcV2FibLevels(result, String(params.fibDirection ?? 'auto') as 'auto' | 'high-to-low' | 'low-to-high', throughIndex, fibRatios)
        : [],
      premiumDiscount: params.showPremiumDiscount === true
        ? smcV2PremiumDiscountZones(result, throughIndex)
        : [],
    });
    return {
      id, name, params, calculation: snapshot.calculation,
      rules: id === 'smart-money-concepts-v3' ? V3_RULES : V2_RULES,
      results: {
        structures: result.structures.filter(e => within(e.index, from, to)).map(e => structure(e, id)),
        structureLines: result.structureLines.filter(e => overlaps(Math.min(e.fromIndex, e.toIndex), Math.max(e.fromIndex, e.toIndex), from, to))
          .map(e => ({ ...e, fromTime: at(e.fromIndex), toTime: at(e.toIndex), confirmedTime: at(e.confirmedAt) })),
        pivots: result.pivots.filter(e => within(e.index, from, to) || within(e.confirmedAt, from, to))
          .map(e => ({ ...e, time: at(e.index), confirmedTime: at(e.confirmedAt) })),
        swingAnchors: result.swingAnchors.filter(e => within(e.index, from, to) || within(e.confirmedAt, from, to))
          .map(e => ({ ...e, time: at(e.index), confirmedTime: at(e.confirmedAt) })),
        orderBlocks: result.orderBlocks.filter(e => overlaps(e.startIndex, e.endIndex, from, to)).map(zone),
        fairValueGaps: result.fairValueGaps.filter(e => overlaps(e.startIndex, e.endIndex + Number(params.fvgExtend ?? 0), from, to)).map(zone),
        equalLevels: result.equalLevels.filter(e => overlaps(e.firstIndex, e.index, from, to) || within(e.confirmedAt, from, to))
          .map(e => ({ ...e, firstTime: at(e.firstIndex), time: at(e.index), confirmedTime: at(e.confirmedAt) })),
        periodLevels: result.periodLevels.filter(e => overlaps(e.startIndex, e.endIndex, from, to)).map(zone),
        barStates: result.barStates.slice(from, to + 1).map(e => ({ ...e, time: at(e.index) })),
        swingBiasHistory: result.swingBiasHistory.filter(e => within(e.index, from, to)).map(e => ({ ...e, time: at(e.index) })),
        alerts: result.alerts.filter(e => within(e.index, from, to)).map(e => ({ ...e, time: at(e.index) })),
        derivedAtVisibleRightEdge: derivedAt(to),
        derivedAtLastLoadedBar: derivedAt(candles.length - 1),
      },
      limitations: [
        'Order blocks and fair value gaps include only active inventory; historical removals are represented by alerts where available.',
        'Displayed Present mode and per-scope OB count can hide calculated events; results represent the model inventory.',
        'Higher-timeframe calculations can change when provider candles arrive; calculation includes the actual timeframe inputs used.',
      ],
    };
  });

  return {
    schemaVersion: 1,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    meta: {
      symbol: input.symbol,
      timeframe: input.timeframe,
      source: input.source,
      timeUnit: 'unix-seconds (UTC)',
      loadedRange: { fromIndex: 0, toIndex: candles.length - 1, fromTime: at(0), toTime: at(candles.length - 1) },
      visibleRange: { fromIndex: from, toIndex: to, fromTime: at(from), toTime: at(to) },
      calculationScope: 'full loaded candle history; outputs filtered to visible bar indices',
    },
    candles: candles.slice(from, to + 1).map((candle, offset) => ({ index: from + offset, ...candle })),
    indicators: results,
  };
}
