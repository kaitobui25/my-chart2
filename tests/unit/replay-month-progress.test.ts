import { describe, expect, it } from 'vitest';

import { buildReplayMonthProgress } from '../../examples/workstation/replay/replay-month-progress';

const utc = (value: string): number => Math.floor(Date.parse(value) / 1000);

describe('monthly replay progress', () => {
  it('shrinks through the calendar month and reaches zero at the next month', () => {
    const candleTime = utc('2026-04-01T00:00:00Z');
    const full = buildReplayMonthProgress(candleTime, candleTime);
    const half = buildReplayMonthProgress(candleTime, utc('2026-04-16T00:00:00Z'));
    const empty = buildReplayMonthProgress(candleTime, utc('2026-05-01T00:00:00Z'));

    expect(full).toMatchObject({ remaining: 1, color: 'rgb(180, 125, 0)' });
    expect(half).toMatchObject({ remaining: 0.5, color: 'rgb(217, 178, 69)' });
    expect(empty).toMatchObject({ remaining: 0, color: 'rgb(253, 230, 138)' });
  });

  it('uses the provider calendar offset for the month boundary', () => {
    const offset = 7 * 60;
    const candleTime = utc('2026-03-31T17:00:00Z');

    expect(buildReplayMonthProgress(candleTime, candleTime, offset).remaining).toBe(1);
    expect(buildReplayMonthProgress(candleTime, utc('2026-04-30T17:00:00Z'), offset).remaining).toBe(0);
  });
});
