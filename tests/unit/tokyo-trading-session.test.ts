import { describe, expect, it } from 'vitest';
import { overlapsTokyoTradingSession } from '../../examples/providers/tokyo-trading-session';

describe('Tokyo trading session coverage', () => {
  it.each([
    ['2026-09-14T15:30:01', '2026-09-15T08:59:59', false],
    ['2026-09-14T11:30:01', '2026-09-14T12:29:59', false],
    ['2026-09-18T15:30:01', '2026-09-21T08:59:59', false],
    ['2026-09-14T09:00:00', '2026-09-14T09:00:00', true],
    ['2026-09-14T11:30:00', '2026-09-14T11:30:00', true],
    ['2026-09-14T12:30:00', '2026-09-14T12:30:00', true],
    ['2026-09-14T15:30:00', '2026-09-14T15:30:00', true],
    ['2026-09-14T10:00:00', '2026-09-14T10:15:00', true],
    ['2026-09-21T10:00:00', '2026-09-21T10:15:00', true], // Unconfirmed holiday.
    ['2024-11-01T15:00:01', '2024-11-01T15:30:00', false],
    ['2024-11-05T15:00:01', '2024-11-05T15:30:00', true],
  ])('%s to %s: eligible=%s', (from, to, expected) => {
    expect(overlapsTokyoTradingSession({
      from: Date.parse(`${from}+09:00`) / 1_000,
      to: Date.parse(`${to}+09:00`) / 1_000,
    })).toBe(expected);
  });
});
