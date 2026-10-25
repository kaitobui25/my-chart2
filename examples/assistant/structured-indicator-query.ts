import type { Candle } from '../../src/core/types';
import type { IndicatorDebugSnapshot, Params } from '../../src/indicators/registry';
import { intervalApproxSeconds, nextIntervalStart } from '../../src/interval';
import { calculateDarvasBoxes } from '../../src/indicators/builtin/darvas-box-model';
import { calculateSmartMoneyConcepts } from '../../src/indicators/builtin/smart-money-concepts-model';
import { calculateSmartMoneyConceptsV2, smcV2FibLevels, smcV2PremiumDiscountZones } from '../../src/indicators/builtin/smart-money-concepts-v2-model';
import { calculateSmartMoneyConceptsV3 } from '../../src/indicators/builtin/smart-money-concepts-v3-model';
import { smcAnalysisOptions } from '../../src/indicators/builtin/smart-money-concepts-v2';
import { alignComparisonCandles, projectComparisonCandles } from '../../src/indicators/external/comparison-overlay-model';

export interface StructuredIndicatorArgs {
  id: string;
  params: Params;
  candles: readonly Candle[];
  timeframe: string;
  intervalSeconds: number;
  limit: number;
  /** Upper bound for external candles, which must have closed by this instant. */
  deadline: number;
  snapshot?: IndicatorDebugSnapshot;
  reuseSnapshot: boolean;
  loadCandles?(symbol: string | null, timeframe: string, count: number): Promise<Candle[]>;
}

function providerFrame(frame: string): string {
  return ({ D: '1d', W: '1w', M: '1M' } as Record<string, string>)[frame]
    ?? (/^\d+$/.test(frame) ? Number(frame) % 60 === 0 ? `${Number(frame) / 60}h` : `${frame}m` : frame);
}

function snapshotInputsBounded(args: StructuredIndicatorArgs): boolean {
  const calculation = args.snapshot?.calculation;
  if (!calculation || !args.id.startsWith('smart-money-concepts-v')) return true;
  const closed = (frame: string, bars?: readonly Candle[]) => !bars?.length
    || bars.every(bar => nextIntervalStart(bar.time, providerFrame(frame), Number(args.params.periodUtcOffsetHours) * 60) <= args.deadline);
  if (calculation.fvgCandles && !closed(String(calculation.fvgTimeframe), calculation.fvgCandles as Candle[])) return false;
  const periods = calculation.periodCandles as Record<string, Candle[]> | undefined;
  return Object.entries(periods ?? {}).every(([frame, bars]) => closed(frame, bars));
}

/** Bounded tool output only; raw calculation inputs never leave the chart. */
function withTimes<T extends object>(items: readonly T[], candles: readonly Candle[], limit: number) {
  const indexKeys = ['index', 'originIndex', 'startIndex', 'endIndex', 'confirmedAt', 'confirmedIndex', 'fromIndex', 'toIndex', 'firstIndex', 'highIndex', 'lowIndex', 'rangeAnchorIndex'];
  return items.slice(-limit).map(item => {
    const times: Record<string, number | null> = {};
    const fields = item as Record<string, unknown>;
    for (const key of indexKeys) {
      if (typeof fields[key] === 'number') {
        const name = key === 'index' ? 'time' : key === 'confirmedAt' ? 'confirmedTime' : key.replace('Index', 'Time');
        times[name] = candles[fields[key] as number]?.time ?? null;
      }
    }
    return { ...item, ...times };
  });
}

async function queryNikkei(args: StructuredIndicatorArgs) {
  const { snapshot, timeframe, candles, deadline, limit } = args;
  let raw = snapshot?.calculation.rawCandles as readonly Candle[] | undefined;
  let rawInterval = String(snapshot?.calculation.rawInterval ?? timeframe);
  if (!raw?.length) {
    if (!args.loadCandles) throw new Error('Nikkei 225 data is unavailable: no market datafeed.');
    // Use intrabars only for a replay cursor inside a larger candle.
    const partial = deadline < nextIntervalStart(candles[candles.length - 1].time, timeframe, 540);
    rawInterval = partial && intervalApproxSeconds(timeframe) > 900 ? '15m' : timeframe;
    raw = await args.loadCandles('^N225', rawInterval, 2000);
  }
  const projected = projectComparisonCandles(raw, rawInterval, timeframe, deadline);
  const aligned = alignComparisonCandles(candles, projected, timeframe).slice(-limit);
  if (!aligned.some(Boolean)) throw new Error('Nikkei 225 has no closed candles aligned to this chart range.');
  return {
    id: args.id, params: args.params, kind: 'comparison', comparisonSymbol: '^N225',
    source: snapshot?.calculation.status ?? 'market datafeed', rawInterval,
    coverage: { requested: aligned.length, available: aligned.filter(Boolean).length },
    values: aligned.map((bar, i) => ({ chartTime: candles[candles.length - aligned.length + i].time, candle: bar })),
    limitations: ['Prices are actual Nikkei index values; the chart overlay uses an independent visual scale. Missing sessions remain null.'],
  };
}

export async function queryStructuredIndicator(args: StructuredIndicatorArgs) {
  const { id, params, candles, limit, intervalSeconds, snapshot } = args;
  const boundedSnapshot = snapshotInputsBounded(args);
  const reuseSnapshot = args.reuseSnapshot && boundedSnapshot;
  if (id === 'nikkei-225') return queryNikkei(args);
  const basis = { id, params, inputCount: candles.length, calculationSource: reuseSnapshot ? 'chart-snapshot' : 'anchored-calculation' };
  if (id === 'darvas-box') {
    const boxes = reuseSnapshot && snapshot ? snapshot.result as ReturnType<typeof calculateDarvasBoxes>
      : calculateDarvasBoxes(candles, Number(params.pivotSize), intervalSeconds);
    return { ...basis, kind: 'boxes', displayEnabled: params.showBoxes === true,
      totalCount: boxes.length, boxes: withTimes(boxes, candles, limit),
      limitations: ['The left edge is a pivot origin, not the time the box first became knowable. bull/bear indicates a confirmed breakout; weak indicates an outside close without volume confirmation. forming is not a confirmed breakout.'] };
  }
  const limitations = ['Results are calculated model inventory, not a screenshot. Display filters may hide calculated events.',
    'Order blocks and FVG contain active inventory only; absence does not prove a zone never existed.'];
  if (id === 'smart-money-concepts') {
    const result = reuseSnapshot && snapshot ? snapshot.result as ReturnType<typeof calculateSmartMoneyConcepts>
      : calculateSmartMoneyConcepts(candles, Number(params.swingLength), Number(params.internalLength));
    return { ...basis, kind: 'smc', structureRule: 'Close breaks a confirmed pivot; prior bias distinguishes BOS from CHoCH.', structures: withTimes(result.structures, candles, limit),
      swingPoints: withTimes(result.swingPoints.map(p => ({ ...p, confirmedIndex: p.index + Number(params.swingLength) })), candles, limit),
      orderBlocks: withTimes(result.orderBlocks, candles, limit), fairValueGaps: withTimes(result.fairValueGaps, candles, limit), limitations };
  }
  const options = smcAnalysisOptions(params, intervalSeconds);
  const frames = new Map<string, Promise<Candle[]>>();
  const external = (frame: string, supplied?: readonly Candle[]) => {
    const tf = providerFrame(frame);
    if (!frames.has(tf)) frames.set(tf, (async () => {
      const bars = supplied?.length ? supplied : await args.loadCandles?.(null, tf, 2000) ?? [];
      return bars.filter(bar => nextIntervalStart(bar.time, tf, Number(params.periodUtcOffsetHours) * 60) <= args.deadline);
    })());
    return frames.get(tf)!;
  };
  // Current snapshots already contain exactly the external inputs used by rendering.
  if (!reuseSnapshot) {
    if (snapshot && !boundedSnapshot) limitations.push('Provider bars extending beyond this anchor were excluded; historical lookahead on the chart may differ.');
    if (options.showFairValueGaps && options.fvgTimeframe !== 'chart' && options.fvgTimeframe !== options.chartTimeframe) {
      try { options.fvgCandles = await external(options.fvgTimeframe!, snapshot?.calculation.fvgCandles as Candle[] | undefined); }
      catch { options.fvgCandles = []; }
      if (!options.fvgCandles.length) {
        options.showFairValueGaps = false;
        limitations.push('Requested FVG timeframe has no closed provider candles; FVG is unavailable, not an empty signal.');
      }
    }
    options.periodCandles = {};
    const supplied = snapshot?.calculation.periodCandles as typeof options.periodCandles;
    await Promise.all((['D', 'W', 'M'] as const).map(async frame => {
      const flag = ({ D: 'showDailyLevels', W: 'showWeeklyLevels', M: 'showMonthlyLevels' } as const)[frame];
      if (!options[flag]) return;
      try { options.periodCandles![frame] = await external(frame, supplied?.[frame]); }
      catch { options.periodCandles![frame] = []; }
      if (!options.periodCandles![frame]!.length) {
        options[flag] = false;
        limitations.push(`${frame} period levels unavailable: no closed provider candles.`);
      }
    }));
  } else if (snapshot?.calculation.fvgProviderState === 'waiting-or-unavailable') {
    limitations.push('FVG provider data is still waiting or unavailable.');
  }
  const calculate = id === 'smart-money-concepts-v3' ? calculateSmartMoneyConceptsV3 : calculateSmartMoneyConceptsV2;
  const result = reuseSnapshot && snapshot ? snapshot.result as ReturnType<typeof calculateSmartMoneyConceptsV2> : calculate(candles, options);
  const ratios = [0, 236, 382, 500, 618, 786, 1000].filter(key => params[`showFib${key}`] !== false).map(key => Number(params[`fibValue${key}`] ?? key / 1000));
  return { ...basis, kind: 'smc',
    structureRule: id === 'smart-money-concepts-v3'
      ? 'Strict wick break of a protected pivot; prior scope bias distinguishes BOS from CHoCH.'
      : 'Close crosses a confirmed pivot; prior scope bias distinguishes BOS from CHoCH.',
    counts: { structures: result.structures.length, pivots: result.pivots.length, orderBlocks: result.orderBlocks.length, fairValueGaps: result.fairValueGaps.length },
    features: { internal: params.showInternal, swing: params.showSwing,
      internalOrderBlocks: params.showInternalOrderBlocks, swingOrderBlocks: params.showSwingOrderBlocks,
      fairValueGaps: params.showFairValueGaps === true ? reuseSnapshot ? snapshot?.calculation.fvgProviderState ?? 'chart' : options.showFairValueGaps ? 'available' : 'unavailable' : 'disabled' },
    structures: withTimes(result.structures, candles, limit), pivots: withTimes(result.pivots, candles, limit),
    swingAnchors: withTimes(result.swingAnchors, candles, limit),
    structureLines: withTimes(result.structureLines, candles, limit),
    orderBlocks: withTimes(result.orderBlocks, candles, limit), fairValueGaps: withTimes(result.fairValueGaps, candles, limit),
    equalLevels: withTimes(result.equalLevels, candles, limit), periodLevels: withTimes(result.periodLevels, candles, limit),
    barStates: withTimes(result.barStates.slice(-Math.min(limit, 10)).map(state => ({ ...state,
      high: state.high ? withTimes([state.high], candles, 1)[0] : null,
      low: state.low ? withTimes([state.low], candles, 1)[0] : null,
    })), candles, Math.min(limit, 10)), alerts: withTimes(result.alerts, candles, limit),
    swingBias: result.swingBias,
    fibonacci: params.showFib ? smcV2FibLevels(result, String(params.fibDirection) as 'auto' | 'high-to-low' | 'low-to-high', candles.length - 1, ratios) : [],
    premiumDiscount: params.showPremiumDiscount ? smcV2PremiumDiscountZones(result, candles.length - 1) : [],
    limitations };
}
