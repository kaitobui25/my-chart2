import { describe, expect, it, vi } from 'vitest';
import type { L2Chart } from '../../src/core/chart';
import { OverlaySeries } from '../../src/core/series';
import { TimeScale } from '../../src/core/time-scale';
import { PriceScale } from '../../src/core/price-scale';
import { darkTheme } from '../../src/core/types';
import smcV2 from '../../src/indicators/builtin/smart-money-concepts-v2';
import { defaultParams } from '../../src/indicators/registry';
import type { Candle } from '../../src/core/types';
import {
  calculateSmartMoneyConceptsV2 as calculate, smcV2FibLevels, smcV2SwingContext, smcV2PremiumDiscountZones,
  type SmcV2Options,
} from '../../src/indicators/builtin/smart-money-concepts-v2-model';
import { buildSmcTimeframe } from '../../src/indicators/builtin/smart-money-concepts-v2-timeframes';
import * as smcModel from '../../src/indicators/builtin/smart-money-concepts-v2-model';

function renderFixture(result: smcModel.SmcV2Result, params: Record<string, string | boolean | number>, to = result.barStates.length - 1) {
  const texts: Array<{ text: string; x: number; y: number; color: string }> = [];
  const fills: Array<{ color: string; alpha: number; x: number; y: number; width: number; height: number }> = [];
  const ctx = {
    globalAlpha: 1, fillStyle: '', strokeStyle: '',
    save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
    stroke: vi.fn(), strokeRect: vi.fn(), setLineDash: vi.fn(),
    fillText(text: string, x: number, y: number) { texts.push({ text, x, y, color: this.fillStyle }); },
    fillRect(x: number, y: number, width: number, height: number) { fills.push({ x, y, width, height, color: this.fillStyle, alpha: this.globalAlpha }); },
  };
  let overlay: OverlaySeries;
  const chart = {
    getCandles: () => candles(Array.from({ length: result.barStates.length }, () => [10, 11, 9, 10])), getIntervalSec: () => 60,
    addOverlay: (settings: ConstructorParameters<typeof OverlaySeries>[0]) => (overlay = new OverlaySeries(settings)),
    removeSeries: vi.fn(),
  };
  const mock = vi.spyOn(smcModel, 'calculateSmartMoneyConceptsV2').mockReturnValue(result);
  try {
    smcV2.create(chart as unknown as L2Chart, { ...defaultParams(smcV2), showInternal: false, showSwing: false,
      internalLine: false, swingLine: false, showStrongWeak: false, showInternalOrderBlocks: false,
      showSwingOrderBlocks: false, showEqualLevels: false, ...params });
    const ts = new TimeScale(); ts.setWidth(800);
    const ps = new PriceScale(); ps.setHeight(400); ps.setRange(5, 20);
    overlay!.draw({ ctx: ctx as unknown as CanvasRenderingContext2D, ts, ps, from: 0, to,
      paneWidth: 800, paneHeight: 400, legendWidth: 0, legendHeight: 0, theme: darkTheme });
    return { texts, fills, ctx, ts, ps };
  } finally { mock.mockRestore(); }
}

const epoch = Date.UTC(2026, 0, 1) / 1000;
function candles(rows: number[][], interval = 60): Candle[] {
  return rows.map(([open, high, low, close], i) => ({ time: epoch + i * interval, open, high, low, close }));
}
const options: SmcV2Options = {
  swingLength: 2, internalLength: 2, equalLength: 2, equalThreshold: 0.1,
  showInternalPivots: true, showSwingPivots: true, internalConfluence: false, showEqualLevels: true,
  showDailyLevels: false, showWeeklyLevels: false, showMonthlyLevels: false,
  showInternalOrderBlocks: true, showSwingOrderBlocks: true, internalOrderBlockCount: 5, swingOrderBlockCount: 5,
  mitigation: 'wick', orderBlockFilter: 'atr', showFairValueGaps: false, filterFairValueGaps: false,
  periodUtcOffsetHours: 0, chartIntervalSeconds: 60,
};
// Hand-traced against DucTri leg(2), getCurrentStructure(), displayStructure(), storeOrdeBlock().
const swingRows = [
  [10, 11, 9, 10], [11, 12, 10, 11], [12, 15, 11, 14], [13, 14, 12, 13], [12, 13, 10, 11],
  [10, 12, 8, 9], [10, 12, 9, 11], [12, 13, 10, 11], [14, 17, 12, 16],
];

describe('SMC V2 — DucTri Pine backend parity', () => {
  it('keeps the last displayed BOS in Present when a newer CHoCH is filtered out', () => {
    const result = calculate(candles(swingRows), options);
    result.structures.push({ ...result.structures[0], index: 9, type: 'CHoCH' });
    const { texts } = renderFixture(result, { mode: 'present', showSwing: true, swingBullType: 'BOS' }, 9);
    expect(texts.map(t => t.text)).toEqual(['BOS']);
  });

  it('renders neutral trailing sides independently and marks both Weak', () => {
    const result = calculate(candles(swingRows.slice(0, 8)), options);
    const both = renderFixture(result, { showStrongWeak: true });
    expect(both.texts.map(t => t.text)).toEqual(['Weak High', 'Weak Low']);
    const single = calculate(candles(swingRows.slice(0, 3)), options);
    expect(renderFixture(single, { showStrongWeak: true }).texts.map(t => t.text)).toEqual(['Weak Low']);
  });

  it('does not change trailing labels, Fib or Premium/Discount when the viewport ends earlier', () => {
    const result = calculate(candles(swingRows), options);
    const params = { showStrongWeak: true, showFib: true, showPremiumDiscount: true };
    const latest = renderFixture(result, params);
    const scrolled = renderFixture(result, params, 5);
    expect(scrolled.texts).toEqual(latest.texts);
    expect(scrolled.fills).toEqual(latest.fills);
  });

  it('retains one pivot per scope and side in Present and uses Internal colors', () => {
    const result = calculate(candles(swingRows), options);
    const { texts } = renderFixture(result, { mode: 'present', showInternalPivots: true,
      internalBullColor: '#123456', internalBearColor: '#abcdef', style: 'monochrome' });
    expect(texts.map(t => [t.text, t.color])).toEqual([['LH', '#abcdef'], ['LL', '#123456']]);
  });

  it('uses enabled custom Fib ratios and fills across a disabled intermediate level', () => {
    const result = calculate(candles([...swingRows, ...Array.from({ length: 5 }, () => [10, 11, 9, 10])]), options);
    const { texts, fills, ps } = renderFixture(result, { showFib: true, showFib0: true, fibValue0: -0.5,
      showFib236: false, showFib382: true, fibValue382: 0.75, showFib500: false,
      showFib618: false, showFib786: false, showFib1000: false, fibColor382: '#123456' });
    const prices = smcV2FibLevels(result, 'auto', Infinity, [-0.5, 0.75]);
    expect(texts.map(t => t.text)).toEqual(prices.map(p => `${p.ratio} (${p.price.toFixed(ps.decimals())})`));
    expect(fills).toHaveLength(1);
    expect(fills[0].color).toBe('#123456');
    expect(fills[0].height).toBeCloseTo(Math.abs(ps.yFor(prices[0].price) - ps.yFor(prices[1].price)));
  });

  it('colors the breakout candle with the previous bias, then changes color on the next candle', () => {
    const result = calculate(candles([...swingRows, [16, 18, 13, 17]]), options);
    const { fills } = renderFixture(result, { swingTrend: 'candles', swingTrendBull: '#00ff00', swingTrendBear: '#ff0000' });
    expect(fills[8].color).toBe('#ff0000');
    expect(fills[9].color).toBe('#00ff00');
  });

  it('seeds ATR14 for Fib labels and hides labels before its warmup', () => {
    const result = calculate(candles(Array.from({ length: 15 }, () => [10, 12, 8, 10])), options);
    expect(result.barStates[12].atr14).toBeNull();
    expect(result.barStates[13].atr14).toBe(4);
    expect(result.barStates[14].atr14).toBeCloseTo(4);
    expect(renderFixture(calculate(candles(swingRows), options), { showFib: true }).texts).toEqual([]);
  });

  it('loads real lower-timeframe FVG candles and ignores responses after removal', async () => {
    let resolve!: (bars: readonly Candle[]) => void;
    const request = new Promise<readonly Candle[]>(done => { resolve = done; });
    const chart = {
      getCandles: () => candles(swingRows, 300), getIntervalSec: () => 300,
      getIndicatorCandles: vi.fn(() => request), invalidate: vi.fn(), removeSeries: vi.fn(),
      addOverlay: (settings: ConstructorParameters<typeof OverlaySeries>[0]) => new OverlaySeries(settings),
    };
    const spy = vi.spyOn(smcModel, 'calculateSmartMoneyConceptsV2');
    try {
      const instance = smcV2.create(chart as unknown as L2Chart, { ...defaultParams(smcV2),
        showFairValueGaps: true, fvgTimeframe: '1' });
      expect(chart.getIndicatorCandles).toHaveBeenCalledWith('1');
      const bars = candles(Array.from({ length: 45 }, () => [10, 11, 9, 10]));
      resolve(bars);
      await Promise.resolve(); await Promise.resolve();
      expect(spy.mock.calls[spy.mock.calls.length - 1]?.[1].fvgCandles).toBe(bars);
      expect(chart.invalidate).toHaveBeenCalledOnce();
      instance.remove();
      expect(chart.removeSeries).toHaveBeenCalledOnce();
    } finally { spy.mockRestore(); }

    let lateResolve!: (bars: readonly Candle[]) => void;
    chart.getIndicatorCandles.mockImplementation(() => new Promise(done => { lateResolve = done; }));
    chart.invalidate.mockClear();
    const removed = smcV2.create(chart as unknown as L2Chart, { ...defaultParams(smcV2), showFairValueGaps: true, fvgTimeframe: '1' });
    removed.remove();
    lateResolve(candles(swingRows));
    await Promise.resolve(); await Promise.resolve();
    expect(chart.invalidate).not.toHaveBeenCalled();
  });

  it('rejects a stale timeframe response after the symbol dataset is replaced', async () => {
    let current = candles(swingRows, 300);
    const pending: Array<(bars: readonly Candle[]) => void> = [];
    const chart = {
      getCandles: () => current, getIntervalSec: () => 300,
      getIndicatorCandles: vi.fn(() => new Promise<readonly Candle[]>(resolve => pending.push(resolve))),
      invalidate: vi.fn(), removeSeries: vi.fn(),
      addOverlay: (settings: ConstructorParameters<typeof OverlaySeries>[0]) => new OverlaySeries(settings),
    };
    const instance = smcV2.create(chart as unknown as L2Chart, { ...defaultParams(smcV2), showFairValueGaps: true, fvgTimeframe: '1' });
    current = current.map(c => ({ ...c, open: c.open + 100, high: c.high + 100, low: c.low + 100, close: c.close + 100 }));
    instance.recompute();
    expect(pending).toHaveLength(2);
    pending[0](candles(swingRows));
    await Promise.resolve(); await Promise.resolve();
    expect(chart.invalidate).not.toHaveBeenCalled();
    pending[1](candles(Array.from({ length: 45 }, () => [110, 111, 109, 110])));
    await Promise.resolve(); await Promise.resolve();
    expect(chart.invalidate).toHaveBeenCalledOnce();
    instance.remove();
  });
  it('returns empty state for no candles and rejects invalid pivot lengths', () => {
    expect(calculate([], options).barStates).toEqual([]);
    expect(smcV2FibLevels(calculate([], options), 'auto')).toEqual([]);
    expect(() => calculate([], { ...options, swingLength: 0 })).toThrow(RangeError);
  });

  it('confirms a right-window pivot before a symmetric pivot would have enough left history', () => {
    const result = calculate(candles([[10, 20, 1, 10], [10, 15, 5, 10], [10, 14, 6, 10]]), options);
    expect(result.swingAnchors).toEqual([{ index: 0, confirmedAt: 2, price: 1, direction: 'bullish', label: 'HL', scope: 'swing' }]);
  });

  it('alternates on flat candles where both inclusive leg conditions hold', () => {
    const result = calculate(candles(Array.from({ length: 6 }, () => [10, 11, 9, 10])), options);
    expect(result.swingAnchors.map(p => [p.index, p.confirmedAt, p.label])).toEqual([
      [0, 2, 'HL'], [1, 3, 'LH'], [2, 4, 'HL'], [3, 5, 'LH'],
    ]);
  });

  it('does not emit another low while the leg remains bullish', () => {
    const result = calculate(candles(Array.from({ length: 20 }, (_, i) => [10 + i, 11 + i, 9 + i, 10 + i])), options);
    expect(result.swingAnchors.map(p => p.index)).toEqual([0]);
  });

  it('matches hand-traced alternating pivots, labels and bullish BOS, excluding coincident Internal', () => {
    const result = calculate(candles(swingRows), options);
    expect(result.swingAnchors.map(p => [p.index, p.confirmedAt, p.price, p.label])).toEqual([
      [0, 2, 9, 'HL'], [2, 4, 15, 'LH'], [5, 7, 8, 'LL'],
    ]);
    expect(result.structures).toEqual([{ originIndex: 2, index: 8, price: 15, direction: 'bullish', type: 'BOS', scope: 'swing' }]);
    expect(result.alerts).toEqual([{ index: 8, name: 'swingBullishBOS' }]);
    expect(result.pivots.filter(p => p.scope === 'internal').map(p => p.label)).toEqual(['HL', 'LH', 'LL']);
  });

  it('records high-low structure connectors independently of BOS visibility and pivot labels', () => {
    const result = calculate(candles(swingRows), { ...options,
      showInternal: false, showSwing: false, showStrongWeak: false,
      showInternalOrderBlocks: false, showSwingOrderBlocks: false,
      showInternalPivots: false, showSwingPivots: false,
    });
    expect(result.structures).toEqual([]);
    expect(result.pivots).toEqual([]);
    expect(result.structureLines).toContainEqual({
      fromIndex: 0, fromPrice: 9, toIndex: 2, toPrice: 15, confirmedAt: 4, scope: 'internal',
    });
    expect(result.structureLines).toContainEqual({
      fromIndex: 2, fromPrice: 15, toIndex: 5, toPrice: 8, confirmedAt: 7, scope: 'swing',
    });
    expect(result.structureLines.every(line => line.confirmedAt >= line.toIndex)).toBe(true);
  });

  it('renders pivot connectors with BOS hidden, while BOS lines remain visible when connectors are off', () => {
    const ctx = {
      save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn<(x: number, y: number) => void>(),
      lineTo: vi.fn<(x: number, y: number) => void>(), stroke: vi.fn(), setLineDash: vi.fn(),
      fillText: vi.fn<(text: string, x: number, y: number) => void>(),
    };
    const chart = {
      getCandles: () => candles(swingRows), getIntervalSec: () => 60,
      addOverlay: (settings: ConstructorParameters<typeof OverlaySeries>[0]) => new OverlaySeries(settings),
      removeSeries: vi.fn(),
    };
    const draw = (internalLine: boolean, showSwing: boolean) => {
      const captured = vi.spyOn(chart, 'addOverlay');
      smcV2.create(chart as unknown as L2Chart, {
        ...defaultParams(smcV2), swingLength: 2, internalLength: 2,
        showInternal: false, showSwing, internalLine, swingLine: false, showStrongWeak: false,
        showInternalOrderBlocks: false, showSwingOrderBlocks: false, showEqualLevels: false,
      });
      const overlay = captured.mock.results[captured.mock.results.length - 1].value as OverlaySeries;
      const ts = new TimeScale();
      ts.setWidth(800);
      const ps = new PriceScale();
      ps.setHeight(400);
      ps.setRange(5, 20);
      overlay.draw({ ctx: ctx as unknown as CanvasRenderingContext2D, ts, ps,
        from: 0, to: 8, paneWidth: 800, paneHeight: 400, legendWidth: 0, legendHeight: 0, theme: darkTheme });
      captured.mockRestore();
    };
    draw(true, false);
    expect(ctx.stroke).toHaveBeenCalled();
    expect(ctx.lineTo.mock.calls.some(([x, y], i) => {
      const [x1, y1] = ctx.moveTo.mock.calls[i];
      return x !== x1 && y !== y1;
    })).toBe(true);
    expect(ctx.fillText).not.toHaveBeenCalledWith('BOS', expect.anything(), expect.anything());
    vi.clearAllMocks();
    draw(false, true);
    expect(ctx.stroke).toHaveBeenCalledTimes(1);
    expect(ctx.fillText).toHaveBeenCalledWith('BOS', expect.anything(), expect.anything());
  });

  it('classifies a subsequent opposite break as CHoCH and only crosses a level once', () => {
    const series = candles([...swingRows, [16, 18, 13, 17], [10, 12, 7, 7.5], [8, 10, 6, 7]]);
    const result = calculate(series, { ...options, showSwingOrderBlocks: false });
    expect(result.structures.map(e => [e.index, e.type, e.direction])).toEqual([[8, 'BOS', 'bullish'], [10, 'CHoCH', 'bearish']]);
    expect(result.swingBias).toBe(-1);
  });

  it('respects Pine execution gates rather than changing trend when all structure triggers are disabled', () => {
    const result = calculate(candles(swingRows), { ...options,
      showInternal: false, showSwing: false, showStrongWeak: false, showFib: true,
      showInternalOrderBlocks: false, showSwingOrderBlocks: false,
    });
    expect(result.swingAnchors.length).toBeGreaterThan(0);
    expect(result.structures).toEqual([]);
    expect(result.swingBias).toBe(0);
    expect(smcV2FibLevels(result, 'auto')).toEqual([]);
  });

  it('uses DucTri confluence rather than candle color/body ratio, and never fires a delayed crossover', () => {
    const rows = [...swingRows.slice(0, 8), [12, 14, 10, 12], [12, 13, 9, 10], [10, 12, 9, 11]];
    const filter = { ...options, swingLength: 4, internalConfluence: true };
    const event = { originIndex: 8, index: 11, price: 14, scope: 'internal', direction: 'bullish', type: 'BOS' };
    // upper wick 5.5 > min(14.5, 12-11)=1; body is only 2.5 / 9.
    expect(calculate(candles([...rows, [12, 20, 11, 14.5]]), filter).structures).toContainEqual(event);
    // A large bullish body alone does not pass: upper wick 0.5 < 1.
    const rejected = [...rows, [12, 15, 11, 14.5]];
    expect(calculate(candles(rejected), filter).structures).not.toContainEqual(event);
    expect(calculate(candles(rejected), { ...filter, internalConfluence: false }).structures).toContainEqual(event);
    // Confluence passes on the next candle, but close was already above 14: no new cross.
    expect(calculate(candles([...rejected, [14.5, 20, 13, 15]]), filter).structures.filter(e => e.scope === 'internal')).toEqual([]);
  });

  it('selects the parsed extreme, not the latest opposite-color candle', () => {
    const result = calculate(candles(swingRows), options);
    expect(result.orderBlocks).toEqual([{ startIndex: 5, endIndex: 8, top: 12, bottom: 8, direction: 'bullish', scope: 'swing' }]);
    const bullishOrigin = swingRows.map(row => [...row]);
    bullishOrigin[5] = [9, 12, 8, 10];
    expect(calculate(candles(bullishOrigin), options).orderBlocks[0].startIndex).toBe(5);
  });

  it('uses the first parsed extreme when several origin candles tie', () => {
    const rows = swingRows.map(row => [...row]);
    rows[6] = [10, 12, 8, 11];
    expect(calculate(candles(rows), options).orderBlocks[0].startIndex).toBe(5);
  });

  it('stores up to 100 OBs per scope independently of the display count and reveals older survivors', () => {
    const rows = Array.from({ length: 120 }, (_, cycle) => swingRows.map(row => row.map(price => price + cycle * 12))).flat();
    const result = calculate(candles(rows), { ...options, swingOrderBlockCount: 1 });
    expect(result.orderBlocks).toHaveLength(100);
    expect(result.orderBlocks[0].startIndex).toBe(119 * 9 + 5);
    expect(result.orderBlocks[99].startIndex).toBe(20 * 9 + 5);
    const newestBottom = result.orderBlocks[0].bottom;
    const mitigated = calculate(candles([...rows, [newestBottom + 2, newestBottom + 4, newestBottom - 1, newestBottom + 1]]),
      { ...options, swingOrderBlockCount: 1 });
    expect(mitigated.orderBlocks[0].startIndex).toBe(118 * 9 + 5);
  });

  it('parses high-volatility bars by swapping their high and low, including the range filter', () => {
    const rows = swingRows.map(row => [...row]);
    rows[5] = [10, 12, 1, 9];
    const unseeded = calculate(candles(rows), options);
    expect(unseeded.orderBlocks[0].startIndex).toBe(5);
    expect(unseeded.orderBlocks[0].bottom).toBe(1);
    const warmup = Array.from({ length: 200 }, () => [10, 11, 9, 10]);
    const seeded = calculate(candles([...warmup, ...rows]), options);
    expect(seeded.orderBlocks[0]).toMatchObject({ startIndex: 206, bottom: 9 });
    expect(calculate(candles(rows), { ...options, orderBlockFilter: 'range' }).orderBlocks[0])
      .toMatchObject({ startIndex: 6, bottom: 9 });
  });

  it('invalidates a just-created OB on the breakout bar and reports the mitigation alert', () => {
    const rows = swingRows.map(row => [...row]);
    rows[8] = [14, 17, 7, 16];
    const result = calculate(candles(rows), options);
    expect(result.orderBlocks).toEqual([]);
    expect(result.alerts).toContainEqual({ index: 8, name: 'swingBullishOrderBlock' });
  });

  it('distinguishes wick and close mitigation and preserves a boundary touch', () => {
    const touched = candles([...swingRows, [12, 14, 8, 11]]);
    expect(calculate(touched, options).orderBlocks).toHaveLength(1);
    const crossed = candles([...swingRows, [12, 14, 7, 11]]);
    expect(calculate(crossed, options).orderBlocks).toHaveLength(0);
    expect(calculate(crossed, { ...options, mitigation: 'close' }).orderBlocks).toHaveLength(1);
  });

  it('does not restrict the OB origin search to the last 100 bars', () => {
    const rows = [...swingRows.slice(0, 8),
      ...Array.from({ length: 110 }, (_, i) => [10 + i * 0.01, 13 + i * 0.01, 9 + i * 0.01, 10 + i * 0.01]), swingRows[8]];
    const result = calculate(candles(rows), options);
    const original = result.orderBlocks.find(b => b.bottom === 8);
    expect(original?.startIndex).toBe(5);
  });

  it('uses ATR200 warmup and Wilder RMA, not a rolling mean', () => {
    const series = candles([...Array.from({ length: 200 }, () => [10, 11, 9, 10]), [10, 13, 9, 10], [10, 11, 9, 10]]);
    const result = calculate(series, options);
    expect(result.barStates[198].atr).toBeNull();
    expect(result.barStates[199].atr).toBe(2);
    expect(result.barStates[200].atr).toBeCloseTo(2.01, 12);
    expect(result.barStates[201].atr).toBeCloseTo(2.00995, 12);
  });

  it('detects Equal only after ATR200 is available and uses the new pivot price', () => {
    const prefix = candles(Array.from({ length: 200 }, (_, i) => [i - 190, i - 189, i - 191, i - 190]));
    const suffix = candles([[9, 10, 8, 9], [11, 13, 9, 12], [11, 12, 8, 11], [12, 13.05, 9, 12], [11, 12, 8, 11]])
      .map((c, i) => ({ ...c, time: epoch + (200 + i) * 60 }));
    const result = calculate([...prefix, ...suffix], { ...options, equalLength: 1, equalThreshold: 0.5 });
    expect(result.equalLevels.filter(e => e.label === 'EQH')).toEqual([
      { firstIndex: 201, index: 203, confirmedAt: 204, firstPrice: 13, price: 13.05, label: 'EQH' },
    ]);
    expect(calculate(suffix, { ...options, equalLength: 1, equalThreshold: 0.5 }).equalLevels).toEqual([]);
  });

  it('uses a strict Equal threshold, including when the threshold is zero', () => {
    const result = calculate(candles(Array.from({ length: 220 }, () => [10, 11, 9, 10])), { ...options, equalThreshold: 0 });
    expect(result.equalLevels).toEqual([]);
  });

  it('updates Fibonacci with unconfirmed new highs and preserves historical trailing state', () => {
    const series = candles([...swingRows, [16, 18, 13, 17]]);
    const result = calculate(series, options);
    expect(smcV2FibLevels(result, 'auto').map(l => l.price)).toEqual([8, 10.36, 11.82, 13, 14.18, 15.86, 18]);
    expect(smcV2FibLevels(result, 'auto', 8)[6].price).toBe(17);
    expect(smcV2SwingContext(result, 7).high?.price).toBe(15);
    expect(smcV2FibLevels(result, 'high-to-low')[0].price).toBe(18);
    expect(smcV2FibLevels(result, 'low-to-high', Infinity, [-0.5, 1.5])).toEqual([{ ratio: -0.5, price: 3 }, { ratio: 1.5, price: 23 }]);
  });

  it('moves trailing timestamps on equal extremes and requires distinct Fib endpoint times', () => {
    const result = calculate(candles([...swingRows, [12, 17, 8, 12]]), options);
    expect(result.extremes.high?.index).toBe(9);
    expect(result.extremes.low?.index).toBe(9);
    expect(smcV2FibLevels(result, 'low-to-high')).toEqual([]);
  });

  it('returns the exact Premium/Equilibrium/Discount bands and the most recent swing origin', () => {
    const result = calculate(candles([...swingRows, [16, 18, 13, 17]]), options);
    const zones = smcV2PremiumDiscountZones(result);
    expect(zones.map(z => [z.label, z.startIndex])).toEqual([['Premium', 5], ['Equilibrium', 5], ['Discount', 5]]);
    expect(zones[0].top).toBe(18);
    expect(zones[0].bottom).toBeCloseTo(17.5);
    expect(zones[1].top).toBeCloseTo(13.25);
    expect(zones[1].bottom).toBeCloseTo(12.75);
    expect(zones[2].top).toBeCloseTo(8.5);
    expect(zones[2].bottom).toBe(8);
  });

  it('matches every prefix for chart-timeframe state, events and active zones', () => {
    const series = candles([...swingRows, [16, 18, 13, 17], [10, 12, 7, 7.5]]);
    const full = calculate(series, options);
    for (let i = 0; i < series.length; i++) {
      const prefix = calculate(series.slice(0, i + 1), options);
      expect(prefix.barStates[i]).toEqual(full.barStates[i]);
      expect(prefix.structures).toEqual(full.structures.filter(event => event.index <= i));
      expect(smcV2FibLevels(prefix, 'auto')).toEqual(smcV2FibLevels(full, 'auto', i));
    }
  });

  it('keeps bullish FVG on a boundary touch, deletes on penetration, and anchors at the middle bar', () => {
    const rows = [[9, 10, 8, 9], [10, 12, 9, 11], [13, 15, 12, 14]];
    const fvgOptions = { ...options, showFairValueGaps: true };
    expect(calculate(candles(rows), fvgOptions).fairValueGaps).toEqual([
      { startIndex: 1, endIndex: 2, top: 12, bottom: 10, direction: 'bullish' },
    ]);
    expect(calculate(candles([...rows, [11, 12, 10, 11]]), fvgOptions).fairValueGaps).toHaveLength(1);
    expect(calculate(candles([...rows, [11, 12, 9, 10]]), fvgOptions).fairValueGaps).toHaveLength(0);
  });

  it.each([
    [10, 11, 9, 9.5], // close is below the first high and the middle bar is bearish
    [11, 12, 9, 10], // close equals the first high
    [11, 12, 9, 11], // doji: delta must be strictly positive even with filtering off
  ])('rejects bullish FVG when its middle candle fails the source conditions: %j', (...middle) => {
    const result = calculate(candles([[9, 10, 8, 9], middle, [13, 15, 12, 14]]), { ...options, showFairValueGaps: true });
    expect(result.fairValueGaps).toEqual([]);
  });

  it('uses the cumulative body-percent FVG threshold even on a large price gap', () => {
    const series = candles([[9, 10, 8, 9], [10, 12, 9, 11], [13, 15, 12, 14]]);
    expect(calculate(series, { ...options, showFairValueGaps: true, filterFairValueGaps: true }).fairValueGaps).toEqual([]);
    const padded = candles([...Array.from({ length: 10 }, () => [9, 10, 8, 9]), [10, 12, 9, 11], [13, 15, 12, 14]]);
    expect(calculate(padded, { ...options, showFairValueGaps: true, filterFairValueGaps: true }).fairValueGaps).toHaveLength(1);
  });

  it('preserves DucTri bearish FVG field ordering and its literal deletion condition', () => {
    const rows = [[15, 16, 14, 15], [14, 15, 11, 12], [10, 12, 9, 10]];
    const fvgOptions = { ...options, showFairValueGaps: true };
    expect(calculate(candles(rows), fvgOptions).fairValueGaps).toEqual([
      { startIndex: 1, endIndex: 2, top: 12, bottom: 14, direction: 'bearish' },
    ]);
    expect(calculate(candles([...rows, [10, 12, 9, 10]]), fvgOptions).fairValueGaps).toHaveLength(1);
    expect(calculate(candles([...rows, [10, 13, 9, 10]]), fvgOptions).fairValueGaps).toHaveLength(0);
  });

  it('preserves forward-removal behaviour when neighbouring gaps are invalidated together', () => {
    const series = candles([[9, 10, 8, 9], [10, 12, 9, 11], [13, 15, 12, 14], [16, 18, 15, 17], [10, 11, 7, 9]]);
    const result = calculate(series, { ...options, showFairValueGaps: true });
    expect(result.fairValueGaps).toEqual([{ startIndex: 1, endIndex: 2, top: 12, bottom: 10, direction: 'bullish' }]);
  });

  it('does not evict active FVGs at the old arbitrary limit of 40', () => {
    const series = candles(Array.from({ length: 50 }, (_, i) => [10 + i * 4, 13 + i * 4, 9 + i * 4, 12 + i * 4]));
    expect(calculate(series, { ...options, showFairValueGaps: true }).fairValueGaps).toHaveLength(48);
  });

  it('maps HTF high/low with historical lookahead_on, and only creates FVG on the new HTF bar', () => {
    const series = candles([
      [9, 10, 8, 9], [9, 10, 8, 9], [10, 12, 9, 11], [11, 12, 10, 11],
      [13, 15, 13, 14], [14, 16, 12, 15],
    ]);
    const result = calculate(series, { ...options, showFairValueGaps: true, fvgTimeframe: '2' });
    expect(result.alerts.filter(a => a.name === 'bullishFairValueGap')).toEqual([{ index: 4, name: 'bullishFairValueGap' }]);
    expect(result.fairValueGaps).toEqual([{ startIndex: 2, endIndex: 4, top: 12, bottom: 10, direction: 'bullish' }]);
  });

  it('uses supplied exchange bars and requires provider data for lower timeframes', () => {
    const chart = candles([[10, 13, 9, 11], [11, 15, 10, 12]], 120);
    const supplied = candles([[10, 11, 9, 10], [10, 13, 10, 11], [11, 12, 10, 11], [11, 15, 11, 12]]);
    const lowerOptions = { ...options, chartIntervalSeconds: 120 };
    expect(() => buildSmcTimeframe(chart, '1', lowerOptions)).toThrow(/require fvgCandles/);
    expect(buildSmcTimeframe(chart, '1', lowerOptions, supplied).at).toEqual([0, 2]);
  });

  it('uses the current daily high/low when the chart itself is daily', () => {
    const series = candles([[10, 12, 8, 11], [11, 15, 10, 14], [14, 16, 13, 15]], 86400);
    expect(calculate(series, { ...options, showDailyLevels: true, chartIntervalSeconds: 86400 }).periodLevels).toEqual([
      { startIndex: 2, endIndex: 2, high: 16, low: 13, highIndex: 2, lowIndex: 2, label: 'D' },
    ]);
  });

  it('uses explicit calendar identity for monthly charts whose layout interval is approximated', () => {
    const series = candles([[10, 12, 8, 11], [11, 15, 10, 14]], 30 * 86400);
    const result = calculate(series, { ...options, showMonthlyLevels: true,
      chartIntervalSeconds: 30 * 86400, chartTimeframe: 'M' });
    expect(result.periodLevels).toEqual([
      { startIndex: 1, endIndex: 1, high: 15, low: 10, highIndex: 1, lowIndex: 1, label: 'M' },
    ]);
  });

  it('groups previous daily levels by market UTC offset and anchors to actual extreme bars', () => {
    const series = candles([[10, 12, 8, 11], [11, 15, 10, 14], [14, 16, 13, 15]]);
    series[0].time = epoch + 20 * 3600;
    series[1].time = epoch + 26 * 3600;
    series[2].time = epoch + 44 * 3600;
    expect(calculate(series, { ...options, showDailyLevels: true, periodUtcOffsetHours: 7 }).periodLevels).toEqual([
      { startIndex: 0, endIndex: 2, high: 15, low: 8, highIndex: 1, lowIndex: 0, label: 'D' },
    ]);
  });

  it('hides levels below the chart timeframe and accepts prior exchange bars outside loaded history', () => {
    const series = candles([[10, 12, 8, 11], [11, 15, 10, 14]], 604800);
    expect(calculate(series, { ...options, showDailyLevels: true, chartIntervalSeconds: 604800 }).periodLevels).toEqual([]);
    const chart = candles([[10, 12, 8, 11]]);
    const daily = [{ time: epoch - 86400, open: 9, high: 20, low: 5, close: 10 }, { ...chart[0] }];
    expect(calculate(chart, { ...options, showDailyLevels: true, periodCandles: { D: daily } }).periodLevels[0]).toMatchObject({ high: 20, low: 5 });
  });

  it('handles Monday week boundaries and calendar months, keeping only the latest pair for each', () => {
    const series = candles([[10, 12, 8, 11], [11, 15, 9, 14], [14, 16, 13, 15]]);
    series[0].time = Date.UTC(2026, 0, 30) / 1000;
    series[1].time = Date.UTC(2026, 1, 1) / 1000; // Sunday, same week
    series[2].time = Date.UTC(2026, 1, 2) / 1000; // Monday
    const result = calculate(series, { ...options, showWeeklyLevels: true, showMonthlyLevels: true });
    expect(result.periodLevels).toEqual([
      { startIndex: 0, endIndex: 2, high: 15, low: 8, highIndex: 1, lowIndex: 0, label: 'W' },
      { startIndex: 0, endIndex: 2, high: 12, low: 8, highIndex: 0, lowIndex: 0, label: 'M' },
    ]);
  });
});
