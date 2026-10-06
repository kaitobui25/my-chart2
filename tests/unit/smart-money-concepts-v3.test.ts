import { describe, expect, it } from 'vitest';
import type { Candle } from '../../src/core/types';
import { defaultParams } from '../../src/indicators/registry';
import v2 from '../../src/indicators/builtin/smart-money-concepts-v2';
import v3 from '../../src/indicators/builtin/smart-money-concepts-v3';
import { calculateSmartMoneyConceptsV2, type SmcV2Options, type SmcV2Pivot } from '../../src/indicators/builtin/smart-money-concepts-v2-model';
import { calculateSmartMoneyConceptsV3, createProtectedStructurePolicy } from '../../src/indicators/builtin/smart-money-concepts-v3-model';

const pivot = (price: number, index: number, high = false): SmcV2Pivot => ({
  price, index, confirmedAt: index + 1, direction: high ? 'bearish' : 'bullish', label: high ? 'HH' : 'HL',
});
const bar = (high: number, low: number): Candle => ({ time: 0, open: (high + low) / 2, close: (high + low) / 2, high, low });

describe('SMC V3 protected structure', () => {
  it.each([['swing', false], ['swing', true], ['internal', false], ['internal', true]] as const)('ignores minor pivots until promotion, scope=%s mirrored=%s', (scope, mirrored) => {
    const policy = createProtectedStructurePolicy(scope);
    const h = pivot(100, 1, true), l = pivot(90, 0), pullback = pivot(95, 2), minor = pivot(99, 4);
    const step = (high: SmcV2Pivot, low: SmcV2Pivot, candle: Candle, index: number) => {
      const flip = (p: SmcV2Pivot, isHigh: boolean) => pivot(200 - p.price, p.index, isHigh);
      return mirrored ? policy(flip(low, true), flip(high, false), bar(200 - candle.low, 200 - candle.high), index)
        : policy(high, low, candle, index);
    };
    expect(step(h, l, bar(99, 91), 2)).toEqual([]);
    expect(step(h, pullback, bar(103, 96), 3)).toMatchObject([{ type: 'BOS', price: 100, scope }]);
    const nextHigh = pivot(103, 3, true);
    expect(step(nextHigh, minor, bar(102, 98), 5)).toEqual([]);
    expect(step(nextHigh, minor, bar(102, 94), 6)).toMatchObject([{ type: 'CHoCH', price: mirrored ? 105 : 95, originIndex: 2 }]);
    expect(step(nextHigh, minor, bar(102, 94), 7)).toEqual([]);
  });

  it('promotes the pullback only on the next BOS and uses strict wick breaks', () => {
    const policy = createProtectedStructurePolicy('swing');
    const h = pivot(100, 1, true), l = pivot(90, 0), pullback = pivot(95, 2);
    expect(policy(h, l, bar(100, 90), 2)).toEqual([]);
    expect(policy(h, pullback, bar(103, 96), 3)).toHaveLength(1);
    const next = pivot(103, 3, true), minor = pivot(99, 4);
    expect(policy(next, minor, bar(103, 99), 5)).toEqual([]);
    expect(policy(next, minor, bar(104, 100), 6)).toMatchObject([{ type: 'BOS', originIndex: 3 }]);
    expect(policy(next, minor, bar(102, 98), 7)).toMatchObject([{ type: 'CHoCH', price: 99 }]);
  });

  it('uses protected Internal structure while sharing raw pivots and auxiliary calculations', () => {
    const options = { ...defaultParams(v2), swingLength: 2, internalLength: 1, equalLength: 2,
      showSwing: true, showSwingPivots: true, showInternalPivots: true } as unknown as SmcV2Options;
    const candles = Array.from({ length: 100 }, (_, i) => ({ ...bar(100 + Math.sin(i) * 10 + 2, 100 + Math.sin(i) * 10 - 2), time: i * 60 }));
    const old = calculateSmartMoneyConceptsV2(candles, options), result = calculateSmartMoneyConceptsV3(candles, options);
    expect(result.structures.filter(e => e.scope === 'internal')).not.toEqual(old.structures.filter(e => e.scope === 'internal'));
    expect(result.structureLines.filter(e => e.scope === 'internal').length).toBeLessThan(old.structureLines.filter(e => e.scope === 'internal').length);
    expect(result.pivots).toEqual(old.pivots);
    expect(result.equalLevels).toEqual(old.equalLevels);
    for (const scope of ['internal', 'swing'] as const) {
      const active = result.structureLines.filter(line => line.scope === scope && line.supersededAt === undefined);
      for (let i = 1; i < active.length; i++) {
        expect(active[i].fromIndex).toBe(active[i - 1].toIndex);
        expect(active[i].fromPrice).toBe(active[i - 1].toPrice);
      }
      expect(active.every(line => line.fromIndex < line.toIndex)).toBe(true);
    }
    expect(result.structures.filter(e => e.index < 60)).toEqual(calculateSmartMoneyConceptsV3(candles.slice(0, 60), options).structures);
    expect(defaultParams(v3).showSwing).toBe(true);
    expect(v3.id).toBe('smart-money-concepts-v3');
  });

  it('connects only promoted anchors and resets trailing ranges only on promotion', () => {
    const options = { ...defaultParams(v2), swingLength: 2, internalLength: 1, equalLength: 2,
      showSwing: false, showStrongWeak: false, showPremiumDiscount: true,
      showSwingPivots: true } as unknown as SmcV2Options;
    const candles = Array.from({ length: 100 }, (_, i) => ({
      ...bar(100 + Math.sin(i) * 10 + 2, 100 + Math.sin(i) * 10 - 2), time: i * 60,
    }));
    const result = calculateSmartMoneyConceptsV3(candles, options);
    expect(result.swingAnchors.length).toBeGreaterThan(1);
    expect(result.swingAnchors.length).toBeLessThan(result.pivots.filter(p => p.scope === 'swing').length);
    const lines = result.structureLines.filter(line => line.scope === 'swing');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const available = result.swingAnchors.filter(p => p.confirmedAt <= line.confirmedAt);
      const highs = available.filter(p => p.direction === 'bearish');
      const lows = available.filter(p => p.direction === 'bullish');
      const high = highs[highs.length - 1];
      const low = lows[lows.length - 1];
      expect([line.fromIndex, line.toIndex]).toEqual([high.index, low.index].sort((a, b) => a - b));
    }
    for (let i = 1; i < candles.length; i++) {
      const before = result.barStates[i - 1], after = result.barStates[i];
      const promoted = result.swingAnchors.filter(p => p.confirmedAt === i);
      if (before.high && !promoted.some(p => p.direction === 'bearish')) {
        expect(after.high?.price).toBe(Math.max(before.high.price, candles[i].high));
      }
      if (before.low && !promoted.some(p => p.direction === 'bullish')) {
        expect(after.low?.price).toBe(Math.min(before.low.price, candles[i].low));
      }
      if (!promoted.length) expect(after.rangeAnchorIndex).toBe(before.rangeAnchorIndex);
    }
    const prefix = calculateSmartMoneyConceptsV3(candles.slice(0, 60), options);
    expect(result.barStates.slice(0, 60)).toEqual(prefix.barStates);
    expect(lines.filter(line => line.confirmedAt < 60)).toEqual(prefix.structureLines.filter(line => line.scope === 'swing'));
  });

  it('keeps scope state independent and records Internal bias and alerts from protected breaks', () => {
    const options = { ...defaultParams(v3), swingLength: 2, internalLength: 2, equalLength: 2,
      internalConfluence: false } as unknown as SmcV2Options;
    const candles = Array.from({ length: 100 }, (_, i) => ({
      ...bar(100 + Math.sin(i) * 10 + 2, 100 + Math.sin(i) * 10 - 2), time: i * 60,
    }));
    const result = calculateSmartMoneyConceptsV3(candles, options);
    const internal = result.structures.filter(e => e.scope === 'internal');
    expect(internal.length).toBeGreaterThan(0);
    expect(internal.map(e => ({ ...e, scope: 'swing' }))).toEqual(result.structures.filter(e => e.scope === 'swing'));
    for (const event of internal) {
      expect(result.alerts).toContainEqual({ index: event.index,
        name: `internal${event.direction === 'bullish' ? 'Bullish' : 'Bearish'}${event.type}` });
    }
    const changedSwing = calculateSmartMoneyConceptsV3(candles, { ...options, swingLength: 10 });
    expect(changedSwing.structures.filter(e => e.scope === 'internal')).toEqual(internal);
    expect(changedSwing.barStates.map(s => s.internalBias)).toEqual(result.barStates.map(s => s.internalBias));
    expect(changedSwing.orderBlocks.filter(b => b.scope === 'internal')).toEqual(result.orderBlocks.filter(b => b.scope === 'internal'));
    expect(result.barStates.map(s => s.internalBias)).toEqual(result.barStates.map(s => s.bias));
  });
});
