import { describe, expect, it, vi } from 'vitest';
import { L2Chart } from '../../src/core/chart';
import type { Datafeed } from '../../src/datafeed';
import { OverlaySeries, type RenderContext } from '../../src/core/series';
import { defaultParams } from '../../src/indicators/registry';
import { setIndicatorMarketContext, setIndicatorChartProvider, installIndicatorRuntimeContextTracking } from '../../src/indicators/runtime-context';
import { createComparisonOverlay, drawComparisonOverlay } from '../../src/indicators/external/comparison-overlay';
import topix, { TOPIX_17_ETFS } from '../../src/indicators/external/topix-17';

describe('TOPIX-17 sector overlay', () => {
  it('renders EMA only without candle bodies, and both modes on one scale', () => {
    const ctx = { globalAlpha: 1, save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(),
      rect: vi.fn(), clip: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), fillRect: vi.fn(),
    };
    const rc = { ctx, from: 0, to: 1, paneWidth: 100, paneHeight: 100, legendHeight: 10,
      ts: { xForIndex: (i: number) => i * 10 },
    } as unknown as RenderContext;
    const bars = [0, 1].map(time => ({ time, open: 100, high: 110, low: 90, close: 105 }));
    drawComparisonOverlay(rc, bars, '#9ca3af', 0.2, [100, 101], 'ema');
    expect(ctx.fillRect).not.toHaveBeenCalled();
    expect(ctx.lineTo).toHaveBeenCalledTimes(1);
    drawComparisonOverlay(rc, bars, '#9ca3af', 0.2, [100, 101], 'both');
    expect(ctx.fillRect).toHaveBeenCalledTimes(2);
  });
  it('ignores old sector resolution when the primary stock changes quickly', async () => {
    installIndicatorRuntimeContextTracking();
    const pending: ((value: { symbol: string; label: string }) => void)[] = [];
    const feed = { getHistory: vi.fn(async () => []) } as unknown as Datafeed;
    const chart = Object.assign(Object.create(L2Chart.prototype), {
      getCandles: () => [{ time: 100000, open: 100, high: 101, low: 99, close: 100 }],
      addOverlay: (options: ConstructorParameters<typeof OverlaySeries>[0]) => new OverlaySeries(options),
      invalidate: vi.fn(), removeSeries: vi.fn(),
    }) as L2Chart;
    setIndicatorChartProvider(chart, 'yfinance-jp');
    setIndicatorMarketContext(chart, () => ({ interval: '15m', replayTime: 101000, feed }));
    chart.setWatermark('7203.T');
    const def = createComparisonOverlay({ id: 'test-sector', name: 'sector',
      resolveSymbol: () => new Promise(resolve => pending.push(resolve)),
    });
    const instance = def.create(chart, defaultParams(def));
    chart.setWatermark('6758.T');
    pending[1]({ symbol: '1625.T', label: 'Sony sector' });
    await vi.waitFor(() => expect(instance.getDebugSnapshot?.().calculation.symbol).toBe('1625.T'));
    pending[0]({ symbol: '1622.T', label: 'Toyota sector' });
    await Promise.resolve();
    expect(instance.getDebugSnapshot?.().calculation.symbol).toBe('1625.T');
    expect(feed.getHistory).toHaveBeenCalledTimes(1);
    instance.remove();
  });
  it('maps all 17 JPX codes and exposes three display modes', () => {
    expect(Object.keys(TOPIX_17_ETFS)).toHaveLength(17);
    expect(TOPIX_17_ETFS['06']).toBe('1622.T');
    expect(TOPIX_17_ETFS['09']).toBe('1625.T');
    expect(TOPIX_17_ETFS['17']).toBe('1633.T');
    expect(TOPIX_17_ETFS['99']).toBeUndefined();
    expect(topix.params?.find(p => p.key === 'display')?.options?.map(o => o.value)).toEqual(['candles', 'ema', 'both']);
  });
  it('calculates EMA from ETF bars only after replay unlocks them, including warmup', async () => {
    const start = Date.parse('2026-10-09T09:00:00+09:00') / 1000;
    const bars = Array.from({ length: 30 }, (_, i) => ({ time: start + i * 900, open: 100, high: 101, low: 99, close: i === 29 ? 9999 : 100 }));
    const feed = { getHistory: vi.fn(async () => bars) } as unknown as Datafeed;
    const chart = { getCandles: () => bars.slice(19, 30),
      addOverlay: (options: ConstructorParameters<typeof OverlaySeries>[0]) => new OverlaySeries(options),
      invalidate: vi.fn(), removeSeries: vi.fn(),
    } as unknown as L2Chart;
    setIndicatorMarketContext(chart, () => ({ interval: '15m', replayTime: start + 29 * 900, feed }));
    setIndicatorChartProvider(chart, 'yfinance-jp');
    const def = createComparisonOverlay({ id: 'test', name: 'test', symbol: '1622.T', withEma: true });
    const instance = def.create(chart, { ...defaultParams(def), display: 'both' });
    await vi.waitFor(() => expect(instance.getDebugSnapshot?.().calculation.rawCount).toBe(30));
    const snapshot = instance.getDebugSnapshot!();
    expect((snapshot.calculation.alignedEma as (number | null)[]).slice(0, -1)).toEqual(Array(10).fill(100));
    expect((snapshot.calculation.alignedEma as (number | null)[])[10]).toBeNull();
    expect(feed.getHistory).toHaveBeenCalledWith('1622.T', '15m', 50_000, expect.objectContaining({ from: expect.any(Number) }));
    instance.remove();
  });
});
