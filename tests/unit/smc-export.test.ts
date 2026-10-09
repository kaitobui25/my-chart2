import { describe, expect, it, vi } from 'vitest';
import type { Candle, L2Chart } from '../../src/library';
import { defaultParams } from '../../src/indicators/registry';
import originalSmc from '../../src/indicators/builtin/smart-money-concepts';
import smcV2 from '../../src/indicators/builtin/smart-money-concepts-v2';
import smcV3 from '../../src/indicators/builtin/smart-money-concepts-v3';
import type { SmcV2Result } from '../../src/indicators/builtin/smart-money-concepts-v2-model';
import { buildVisibleSmcExport, SMC_IDS } from '../../examples/excel-content-addin/smc-export';

const candles: Candle[] = [
  { time: 100, open: 8, high: 11, low: 7, close: 10, volume: 100 },
  { time: 200, open: 10, high: 13, low: 9, close: 12, volume: 200 },
  { time: 300, open: 12, high: 15, low: 11, close: 14, volume: 300 },
  { time: 400, open: 14, high: 17, low: 13, close: 16, volume: 400 },
  { time: 500, open: 16, high: 19, low: 15, close: 18, volume: 500 },
];

const baseInput = {
  symbol: '7203.T', timeframe: '1d', source: 'market' as const,
  candles, visibleRange: { from: 2, to: 3 }, exportedAt: '2026-10-09T00:00:00.000Z',
};

function fakeChart() {
  return {
    getCandles: () => candles,
    getIntervalSec: () => 86400,
    addOverlay: vi.fn(() => ({})),
    removeSeries: vi.fn(),
  } as unknown as L2Chart;
}

describe('SMC debug snapshots', () => {
  it.each([originalSmc, smcV2, smcV3])('exposes the calculation used for rendering: $id', (definition) => {
    const instance = definition.create(fakeChart(), defaultParams(definition));
    const first = instance.getDebugSnapshot?.();
    expect(first?.result).toBeDefined();
    expect(first?.calculation).toBeDefined();
    expect(instance.getDebugSnapshot?.().result).toBe(first?.result);

    instance.recompute();
    expect(instance.getDebugSnapshot?.().result).not.toBe(first?.result);
    instance.remove();
  });

  it('covers all 3 SMC implementations', () => {
    expect([...SMC_IDS].sort()).toEqual([originalSmc.id, smcV2.id, smcV3.id].sort());
  });
});

describe('visible SMC export', () => {
  it('keeps absolute OHLCV indices and clips events while preserving intersecting zones', () => {
    const exported = buildVisibleSmcExport({
      ...baseInput,
      indicators: [{
        id: originalSmc.id, name: originalSmc.name, params: defaultParams(originalSmc),
        snapshot: {
          calculation: { swingLength: 12, internalLength: 4 },
          result: {
            structures: [
              { index: 1, originIndex: 0, price: 11, direction: 'bullish', scope: 'swing', kind: 'BOS' },
              { index: 3, originIndex: 1, price: 13, direction: 'bullish', scope: 'swing', kind: 'BOS' },
              { index: 4, originIndex: 3, price: 17, direction: 'bearish', scope: 'swing', kind: 'CHoCH' },
            ],
            swingPoints: [{ index: 2, price: 15, label: 'HH', direction: 'bearish' }],
            orderBlocks: [
              { startIndex: 0, endIndex: 4, top: 11, bottom: 7, direction: 'bullish' },
              { startIndex: 0, endIndex: 1, top: 11, bottom: 7, direction: 'bullish' },
            ],
            fairValueGaps: [{ startIndex: 3, endIndex: 4, top: 17, bottom: 11, direction: 'bullish' }],
          },
        },
      }],
    });

    expect(exported.meta.visibleRange).toEqual({ fromIndex: 2, toIndex: 3, fromTime: 300, toTime: 400 });
    expect(exported.candles).toEqual([{ index: 2, ...candles[2] }, { index: 3, ...candles[3] }]);
    const output = exported.indicators[0].results;
    expect(output.structures).toHaveLength(1);
    expect(output.structures[0]).toMatchObject({ index: 3, time: 400, originTime: 200, observed: { close: 16, previousClose: 14, level: 13 } });
    expect(output.orderBlocks).toHaveLength(1);
    expect(output.orderBlocks[0]).toMatchObject({ startTime: 100, endTime: 500 });
    expect(output.fairValueGaps).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(exported)).indicators[0].rules.structure).toContain('close');
  });

  it('exports V2 bar states, HTF calculation inputs, and right-edge-derived values', () => {
    const high = { index: 2, confirmedAt: 2, price: 15, direction: 'bearish' as const, label: 'HH' as const };
    const low = { index: 1, confirmedAt: 1, price: 9, direction: 'bullish' as const, label: 'HL' as const };
    const result: SmcV2Result = {
      structures: [], structureLines: [], pivots: [], orderBlocks: [], fairValueGaps: [],
      equalLevels: [], periodLevels: [], swingAnchors: [], swingBiasHistory: [], alerts: [],
      swingBias: 1, extremes: { high, low },
      barStates: candles.map((candle, index) => ({
        index, high, low, bias: 1, internalBias: 0, rangeAnchorIndex: 1,
        atr: index === 0 ? null : candle.high - candle.low, atr14: null,
      })),
    };
    const exported = buildVisibleSmcExport({
      ...baseInput,
      indicators: [{
        id: smcV2.id, name: smcV2.name,
        params: { showFib: true, fibDirection: 'low-to-high', showPremiumDiscount: true },
        snapshot: { result, calculation: { fvgCandles: [candles[0]], fvgProviderState: 'loaded' } },
      }],
    });
    const output = exported.indicators[0];
    if (!('barStates' in output.results)) throw new Error('Expected V2 diagnostic results');
    expect(output.results.barStates!.map(state => state.index)).toEqual([2, 3]);
    expect(output.results.derivedAtVisibleRightEdge!.fibonacci).toContainEqual({ ratio: 0.5, price: 12 });
    expect(output.results.derivedAtVisibleRightEdge!.premiumDiscount).toHaveLength(3);
    expect(output.calculation.fvgCandles).toEqual([candles[0]]);
  });

  it('supports no active SMC and rejects missing or stale ranges', () => {
    expect(buildVisibleSmcExport({ ...baseInput, indicators: [] }).indicators).toEqual([]);
    expect(() => buildVisibleSmcExport({ ...baseInput, visibleRange: null, indicators: [] })).toThrow(/vùng nến/);
    expect(() => buildVisibleSmcExport({ ...baseInput, visibleRange: { from: 9, to: 15 }, indicators: [] })).toThrow(/không hợp lệ/);
  });
});
