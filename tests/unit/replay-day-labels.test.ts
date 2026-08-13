import { describe, expect, it } from 'vitest';

import type { Candle } from '../../src/core/types';
import {
  buildReplayDayLabels,
  REPLAY_MONTH_UNDERLINE_COLOR,
} from '../../examples/workstation/replay/replay-day-labels';

const candle = (value: string): Candle => ({
  time: Math.floor(Date.parse(value) / 1000),
  open: 10,
  high: 11,
  low: 9,
  close: 10,
});

describe('monthly replay day labels', () => {
  it('shows only days 10, 20, and 30', () => {
    expect(buildReplayDayLabels([
      candle('2026-08-10T00:00:00Z'),
      candle('2026-08-20T00:00:00Z'),
      candle('2026-08-30T00:00:00Z'),
    ])).toEqual([
      {
        time: Math.floor(Date.parse('2026-08-10T00:00:00Z') / 1000),
        text: '10',
        color: '#64748b',
        underlineColor: REPLAY_MONTH_UNDERLINE_COLOR,
      },
      { time: Math.floor(Date.parse('2026-08-20T00:00:00Z') / 1000), text: '20', color: '#64748b' },
      { time: Math.floor(Date.parse('2026-08-30T00:00:00Z') / 1000), text: '30', color: '#64748b' },
    ]);
  });

  it('moves missing target days to the nearest candle in that month', () => {
    expect(buildReplayDayLabels([
      candle('2026-08-09T00:00:00Z'),
      candle('2026-08-11T00:00:00Z'),
      candle('2026-08-19T00:00:00Z'),
      candle('2026-08-22T00:00:00Z'),
      candle('2026-08-29T00:00:00Z'),
      candle('2026-09-01T00:00:00Z'),
    ]).slice(0, 3).map(({ time, text }) => ({ time, text }))).toEqual([
      { time: Math.floor(Date.parse('2026-08-09T00:00:00Z') / 1000), text: '10' },
      { time: Math.floor(Date.parse('2026-08-19T00:00:00Z') / 1000), text: '20' },
      { time: Math.floor(Date.parse('2026-08-29T00:00:00Z') / 1000), text: '30' },
    ]);
  });

  it('respects the provider calendar offset', () => {
    const labels = buildReplayDayLabels([candle('2026-08-09T19:00:00Z')], 7 * 60);
    expect(labels[0].text).toBe('10');
  });

  it('alternates the selected colors between adjacent months', () => {
    const labels = buildReplayDayLabels([
      candle('2026-12-10T00:00:00Z'),
      candle('2027-01-10T00:00:00Z'),
    ], 0, ['#111111', '#eeeeee']);
    expect(labels.map((label) => label.color)).toEqual(['#111111', '#eeeeee']);
  });
});
