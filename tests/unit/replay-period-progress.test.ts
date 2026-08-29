import { describe, expect, it } from 'vitest';

import {
  buildReplayPeriodProgress,
  supportsReplayPeriodProgress,
} from '../../examples/workstation/replay/replay-period-progress';

const utc = (value: string): number => Math.floor(Date.parse(value) / 1000);

describe('replay calendar-period progress', () => {
  it('supports weekly and monthly replay candles only', () => {
    expect(supportsReplayPeriodProgress('1w')).toBe(true);
    expect(supportsReplayPeriodProgress('1M')).toBe(true);
    expect(supportsReplayPeriodProgress('1d')).toBe(false);
  });

  it('preserves monthly progress behavior', () => {
    const candleTime = utc('2026-04-01T00:00:00Z');
    const full = buildReplayPeriodProgress('1M', candleTime, candleTime);
    const half = buildReplayPeriodProgress('1M', candleTime, utc('2026-04-16T00:00:00Z'));
    const empty = buildReplayPeriodProgress('1M', candleTime, utc('2026-05-01T00:00:00Z'));

    expect(full).toMatchObject({ remaining: 1, color: 'rgb(180, 125, 0)' });
    expect(half).toMatchObject({ remaining: 0.5, color: 'rgb(217, 178, 69)' });
    expect(empty).toMatchObject({ remaining: 0, color: 'rgb(253, 230, 138)' });
  });

  it('shrinks weekly progress from Monday to the next Monday', () => {
    const candleTime = utc('2026-04-06T00:00:00Z');
    const full = buildReplayPeriodProgress('1w', candleTime, candleTime);
    const half = buildReplayPeriodProgress('1w', candleTime, utc('2026-04-09T12:00:00Z'));
    const empty = buildReplayPeriodProgress('1w', candleTime, utc('2026-04-13T00:00:00Z'));

    expect(full).toMatchObject({ remaining: 1, color: 'rgb(180, 125, 0)' });
    expect(half).toMatchObject({ remaining: 0.5, color: 'rgb(217, 178, 69)' });
    expect(empty).toMatchObject({ remaining: 0, color: 'rgb(253, 230, 138)' });
  });

  it('uses the provider calendar offset for week and month boundaries', () => {
    const offset = 7 * 60;
    const localMonday = utc('2026-04-05T17:00:00Z');
    const localNextMonday = utc('2026-04-12T17:00:00Z');
    const localMonthStart = utc('2026-03-31T17:00:00Z');
    const localNextMonth = utc('2026-04-30T17:00:00Z');

    expect(buildReplayPeriodProgress('1w', localMonday, localMonday, offset).remaining).toBe(1);
    expect(buildReplayPeriodProgress('1w', localMonday, localNextMonday, offset).remaining).toBe(0);
    expect(buildReplayPeriodProgress('1M', localMonthStart, localMonthStart, offset).remaining).toBe(1);
    expect(buildReplayPeriodProgress('1M', localMonthStart, localNextMonth, offset).remaining).toBe(0);
  });

  it('clamps progress before the start and after the end', () => {
    const candleTime = utc('2026-04-06T00:00:00Z');

    expect(buildReplayPeriodProgress('1w', candleTime, utc('2026-04-05T00:00:00Z')).remaining).toBe(1);
    expect(buildReplayPeriodProgress('1w', candleTime, utc('2026-04-14T00:00:00Z')).remaining).toBe(0);
  });
});
