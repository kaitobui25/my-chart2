import { describe, expect, it, vi } from 'vitest';
import type { Candle } from '../../src/core/types';
import type { L2Chart } from '../../src/core/chart';
import type { Datafeed } from '../../src/datafeed';
import { OverlaySeries } from '../../src/core/series';
import { defaultParams } from '../../src/indicators/registry';
import { setIndicatorChartProvider, setIndicatorMarketContext } from '../../src/indicators/runtime-context';
import def from '../../src/indicators/external/nikkei-225';
import { alignNikkeiCandles, projectNikkeiCandles } from '../../src/indicators/external/nikkei-225-model';

const start = Date.parse('2026-10-09T09:00:00+09:00') / 1000;
const bar = (time: number, close = 101): Candle => ({ time, open: 100, high: close + 1, low: 99, close });

describe('Nikkei 225 overlay', () => {
  it('only projects closed raw bars into a partial hourly replay candle', () => {
    const raw = [bar(start), bar(start + 900, 110), bar(start + 1800, 900)];
    const projected = projectNikkeiCandles(raw, '15m', '1h', start + 1800);
    expect(projected).toEqual([{ time: start, open: 100, high: 111, low: 99, close: 110 }]);
    expect(projectNikkeiCandles(raw, '15m', '1h', start + 899)).toEqual([]);
    expect(raw[2].close).toBe(900);
  });

  it('aligns by timestamps with gaps rather than shifting index candles', () => {
    expect(alignNikkeiCandles([bar(start), bar(start + 900), bar(start + 1800)],
      [bar(start), bar(start + 1800)], '15m')).toEqual([bar(start), null, bar(start + 1800)]);
  });

  it('aligns native daily session opens with replay calendar buckets', () => {
    const midnight = start - 9 * 3600;
    expect(alignNikkeiCandles([bar(start)], [bar(midnight)], '1d')).toEqual([bar(midnight)]);
  });

  it('ignores stale requests after timeframe changes and removes its series', async () => {
    const resolvers: ((bars: Candle[]) => void)[] = [];
    const feed = { getHistory: vi.fn((_symbol, _interval, limit) => limit === 2
      ? Promise.resolve([]) : new Promise<Candle[]>(resolve => resolvers.push(resolve))) } as unknown as Datafeed;
    let interval = '15m';
    const chart = {
      getCandles: () => [bar(start)],
      addOverlay: (options: ConstructorParameters<typeof OverlaySeries>[0]) => new OverlaySeries(options),
      invalidate: vi.fn(), removeSeries: vi.fn(),
    } as unknown as L2Chart;
    setIndicatorChartProvider(chart, 'yfinance-jp');
    setIndicatorMarketContext(chart, () => ({ interval, feed, replayTime: null }));
    const instance = def.create(chart, defaultParams(def));
    interval = '1h'; instance.recompute();
    resolvers[1]([bar(start, 200)]);
    await vi.waitFor(() => expect(instance.getDebugSnapshot?.().result).toEqual([bar(start, 200)]));
    resolvers[0]([bar(start, 900)]);
    await Promise.resolve();
    expect(instance.getDebugSnapshot?.().result).toEqual([bar(start, 200)]);
    expect(instance.getDebugSnapshot?.().calculation.opacity).toBe(0.2);
    instance.remove();
    expect(chart.removeSeries).toHaveBeenCalledTimes(1);
  });
});
