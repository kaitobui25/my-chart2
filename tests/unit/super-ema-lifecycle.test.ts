import { afterEach, describe, expect, it, vi } from 'vitest';
import type { L2Chart } from '../../src/core/chart';
import type { Candle } from '../../src/core/types';
import { TimeScale } from '../../src/core/time-scale';
import { defaultParams } from '../../src/indicators/registry';
import { setIndicatorChartProvider } from '../../src/indicators/runtime-context';
import superEma from '../../src/indicators/builtin/super-ema';
import type { MiniChart } from '../../src/indicators/builtin/super-ema-mini-chart';

function candles(count: number): Candle[] {
  return Array.from({ length: count }, (_, i) => ({ time: 1_000_000 + i * 900, open: i + 1, high: i + 2, low: i, close: i + 1 }));
}
function fakeChart(getIndicatorCandles: (frame: string) => Promise<readonly Candle[]> | undefined) {
  const timeScale = new TimeScale(); timeScale.setWidth(1000); timeScale.setDataLen(300);
  let bars = candles(300);
  const lines: { visible: boolean; color: string; lineWidth: number; setData: ReturnType<typeof vi.fn> }[] = [];
  const fake = {
    timeScale, getCandles: () => bars, getIntervalSec: () => 300,
    getIndicatorCandles: vi.fn(getIndicatorCandles), invalidate: vi.fn(), removeSeries: vi.fn(),
    addLine: () => { const line = { visible: true, color: '#fff', lineWidth: 1, setData: vi.fn() }; lines.push(line); return line; },
    addOverlay: () => ({ legendText: '' }),
  };
  return { chart: fake as unknown as L2Chart, fake, lines, clear: () => { bars = []; } };
}
const instances: { remove(): void }[] = [];
afterEach(() => { instances.splice(0).forEach(instance => instance.remove()); });
async function settle() { for (let i = 0; i < 6; i++) await Promise.resolve(); }
function minis(instance: { getDebugSnapshot?(): { calculation: Record<string, unknown> } }): MiniChart[] {
  return instance.getDebugSnapshot!().calculation.minis as MiniChart[];
}

describe('Super EMA lifecycle', () => {
  it('uses current chart bars for a same-frame preview without another history request', () => {
    const { chart, fake } = fakeChart(() => undefined);
    fake.getIntervalSec = () => 900;
    const instance = superEma.create(chart, { ...defaultParams(superEma), mini1: false, mini2: false }); instances.push(instance);
    expect(fake.getIndicatorCandles).not.toHaveBeenCalled();
    expect(minis(instance)[0].candles).toHaveLength(300);
    expect(minis(instance)[0].status).toBe('');
  });
  it('shares requests for duplicate frames, retains warmup and cleans up all series', async () => {
    const { chart, fake } = fakeChart(() => Promise.resolve(candles(650)));
    const params = { ...defaultParams(superEma), frame1: '15', frame2: '15' };
    const instance = superEma.create(chart, params); instances.push(instance);
    await settle();
    expect(fake.getIndicatorCandles).toHaveBeenCalledTimes(1);
    expect(minis(instance).every(mini => mini.result?.lines[3][649] !== null)).toBe(true);
    expect(minis(instance)[0].candles).toHaveLength(650);
    instance.remove(); instances.pop();
    expect(fake.removeSeries).toHaveBeenCalledTimes(5);
  });
  it('discards an old provider response after a provider switch', async () => {
    let resolveOld!: (bars: Candle[]) => void;
    const old = new Promise<Candle[]>(resolve => { resolveOld = resolve; });
    let current = old;
    const { chart } = fakeChart(() => current);
    const instance = superEma.create(chart, { ...defaultParams(superEma), mini1: false, mini2: false }); instances.push(instance);
    current = Promise.resolve(candles(250));
    setIndicatorChartProvider(chart, 'other-provider');
    await settle();
    resolveOld(candles(650)); await settle();
    expect(minis(instance)[0].candles).toHaveLength(250);
  });
  it('shows missing provider data and never repaints after removal', async () => {
    const { chart } = fakeChart(() => undefined);
    const instance = superEma.create(chart, defaultParams(superEma)); instances.push(instance);
    await settle();
    expect(minis(instance).every(mini => mini.status === 'data unavailable')).toBe(true);
    let resolve!: (bars: Candle[]) => void;
    const second = fakeChart(() => new Promise<Candle[]>(r => { resolve = r; }));
    const pending = superEma.create(second.chart, { ...defaultParams(superEma), mini1: false, mini2: false });
    pending.remove(); resolve(candles(650)); await settle();
    expect(second.fake.invalidate).not.toHaveBeenCalled();
  });
  it('clears stale previews when main data is emptied', async () => {
    let resolve!: (bars: Candle[]) => void;
    const { chart, clear } = fakeChart(() => new Promise<Candle[]>(r => { resolve = r; }));
    const instance = superEma.create(chart, { ...defaultParams(superEma), mini1: false, mini2: false }); instances.push(instance);
    clear(); instance.recompute(); resolve(candles(650)); await settle();
    expect(minis(instance)[0].candles).toHaveLength(0);
  });
});
