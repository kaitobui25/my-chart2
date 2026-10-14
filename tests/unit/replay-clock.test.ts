import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReplayClock } from '../../examples/shared/replay/replay-clock';

afterEach(() => vi.useRealTimers());

describe('ReplayClock', () => {
  it('steps one shared timeline point at a time', () => {
    const steps: Array<[number, number]> = [];
    const clock = new ReplayClock((cursor, time) => steps.push([cursor, time]));
    clock.load([100, 200, 300], 0);

    expect(clock.step()).toBe(true);
    expect(steps).toEqual([[1, 200]]);
    expect(clock.snapshot().currentTime).toBe(200);
  });

  it('plays at the selected speed and pauses at the end', () => {
    vi.useFakeTimers();
    const steps: number[] = [];
    const clock = new ReplayClock((_cursor, time) => steps.push(time));
    clock.load([100, 200, 300], 0);
    clock.setSpeed(2);
    clock.play();

    vi.advanceTimersByTime(500);
    expect(steps).toEqual([200]);
    vi.advanceTimersByTime(500);
    expect(steps).toEqual([200, 300]);
    expect(clock.snapshot().phase).toBe('paused');
  });

  it('cycles through every integer speed from 1x to 10x', () => {
    const clock = new ReplayClock(() => undefined);
    clock.load([100, 200], 0);
    for (let speed = 2; speed <= 10; speed++) expect(clock.cycleSpeed()).toBe(speed);
    expect(clock.cycleSpeed()).toBe(1);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])('pauses with one toggle and resumes at %sx', (speed) => {
    vi.useFakeTimers();
    const clock = new ReplayClock(() => undefined);
    clock.load(Array.from({ length: 100 }, (_, index) => index * 100), 0);
    clock.setSpeed(speed);
    const tickMs = 1000 / speed;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      clock.togglePlayback();
      vi.advanceTimersByTime(tickMs);
      expect(clock.snapshot().cursor).toBe(attempt + 1);
      clock.togglePlayback();
      expect(clock.snapshot().phase).toBe('paused');
      vi.advanceTimersByTime(2000);
      expect(clock.snapshot().cursor).toBe(attempt + 1);
    }
  });
});
