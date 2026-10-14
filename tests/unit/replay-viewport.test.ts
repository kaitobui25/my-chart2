import { describe, expect, it } from 'vitest';
import { TimeScale } from '../../src/core/time-scale';
import { captureReplayViewport, restoreReplayViewport } from '../../examples/shared/replay/replay-viewport';

const bars = (count: number, first = 0) => Array.from({ length: count }, (_, i) => ({
  time: (first + i) * 900, open: 100, high: 101, low: 99, close: 100,
}));
describe('Replay timestamp viewport', () => {
  it('keeps zoom and a visible timestamp at the same pixel after truncating future bars', () => {
    const scale = new TimeScale(); scale.setWidth(800); scale.setDataLen(500);
    scale.barSpacing = 10; scale.rightIndex = 300;
    const saved = captureReplayViewport(scale, bars(500))!;
    const x = scale.xForIndex(240);
    scale.setDataLen(261); scale.barSpacing = 8;
    restoreReplayViewport(scale, bars(261), saved);
    expect(scale.barSpacing).toBe(10);
    expect(scale.xForIndex(240)).toBe(x);
  });
  it('restores timestamps after older candles are prepended or reloaded', () => {
    const scale = new TimeScale(); scale.setWidth(800); scale.setDataLen(500);
    scale.barSpacing = 10; scale.rightIndex = 300;
    const saved = captureReplayViewport(scale, bars(500))!;
    scale.setDataLen(600);
    restoreReplayViewport(scale, bars(600, -100), saved);
    expect(scale.rightIndex).toBe(400);
    expect(scale.barSpacing).toBe(10);
  });
  it('clamps a view whose right edge lies too far beyond truncated history', () => {
    const scale = new TimeScale(); scale.setWidth(800); scale.setDataLen(500);
    scale.barSpacing = 10; scale.rightIndex = 490;
    const saved = captureReplayViewport(scale, bars(500))!;
    scale.setDataLen(100); restoreReplayViewport(scale, bars(100), saved);
    expect(scale.rightIndex).toBeLessThanOrEqual(139);
    expect(captureReplayViewport(scale, [])).toBeNull();
  });
});
