import { describe, expect, it } from 'vitest';

import type { Candle } from '../../src/core/types';
import { buildReplayDayLabels } from '../../examples/workstation/replay/replay-day-labels';

const candle = (value: string): Candle => ({
  time: Math.floor(Date.parse(value) / 1000),
  open: 10,
  high: 11,
  low: 9,
  close: 10,
});

describe('monthly replay day labels', () => {
  it('shows only even calendar days', () => {
    expect(buildReplayDayLabels([
      candle('2026-08-01T00:00:00Z'),
      candle('2026-08-02T00:00:00Z'),
      candle('2026-08-18T00:00:00Z'),
    ])).toEqual([
      { time: Math.floor(Date.parse('2026-08-02T00:00:00Z') / 1000), text: '2', color: '#64748b' },
      { time: Math.floor(Date.parse('2026-08-18T00:00:00Z') / 1000), text: '18', color: '#64748b' },
    ]);
  });

  it('respects the provider calendar offset', () => {
    const labels = buildReplayDayLabels([candle('2026-08-01T19:00:00Z')], 7 * 60);
    expect(labels[0].text).toBe('2');
  });

  it('alternates the selected colors between adjacent months', () => {
    const labels = buildReplayDayLabels([
      candle('2026-12-02T00:00:00Z'),
      candle('2027-01-02T00:00:00Z'),
    ], 0, ['#111111', '#eeeeee']);
    expect(labels.map((label) => label.color)).toEqual(['#111111', '#eeeeee']);
  });
});
