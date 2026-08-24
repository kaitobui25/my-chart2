import { describe, expect, it, vi } from 'vitest';
import type { Candle } from '../../src/core/types';
import { PeQuarterlyRepository } from '../../src/indicators/external/pe-client';
import {
  computeQuarterPePresentation,
  peBarEvaluationTime,
  peQuarterEffectiveAt,
  type PeQuarter,
} from '../../src/indicators/external/pe-model';

const VN_OFFSET = 7 * 60 * 60;
const DAY = 24 * 60 * 60;

function vnTime(year: number, month: number, day: number, hour = 9): number {
  return Math.floor(Date.UTC(year, month - 1, day, hour) / 1000) - VN_OFFSET;
}

function vnEndOfDay(year: number, month: number, day: number): number {
  return vnTime(year, month, day, 23) + 59 * 60 + 59;
}

function candle(time: number, close = 60): Candle {
  return { time, open: close, high: close, low: close, close, volume: 1 };
}

function quarter(
  period: string,
  periodEnd: number,
  trailingEps: number,
  peRatio: number | null,
  firstObservedAt: number,
): PeQuarter {
  return { period, periodEnd, trailingEps, peRatio, firstObservedAt };
}

describe('P/E quarterly model', () => {
  it('uses end-of-day availability instead of candle open time', () => {
    const open = vnTime(2026, 8, 11, 9);
    const midday = vnTime(2026, 8, 11, 13);
    expect(peBarEvaluationTime(candle(open), DAY, midday)).toBe(midday);
  });

  it('uses the conservative fallback when first observation is much later', () => {
    const q1End = vnEndOfDay(2026, 3, 31);
    const q1 = quarter('2026-Q1', q1End, 4000, 15, vnTime(2026, 8, 11, 20));
    expect(peQuarterEffectiveAt(q1)).toBe(q1End + 30 * DAY);
  });

  it('clamps a malformed observation timestamp to period end', () => {
    const q1End = vnEndOfDay(2026, 3, 31);
    const q1 = quarter('2026-Q1', q1End, 4000, 15, q1End - DAY);
    expect(peQuarterEffectiveAt(q1)).toBe(q1End);
  });

  it('maps released quarterly P/E to the quarter-end candle', () => {
    const qEnd = vnEndOfDay(2026, 6, 30);
    const q = quarter('2026-Q2', qEnd, 4050.73, 6.47, vnTime(2026, 7, 20));
    const presentation = computeQuarterPePresentation(
      [candle(vnTime(2026, 6, 30)), candle(vnTime(2026, 7, 21))],
      [q],
      DAY,
      vnTime(2026, 7, 21, 23),
    );
    expect(presentation.markers).toEqual([{ index: 0, value: 6.47, period: '2026-Q2' }]);
    expect(presentation.latestReportedPe).toBe(6.47);
  });

  it('hides a quarterly point until it is knowable in replay', () => {
    const qEnd = vnEndOfDay(2026, 3, 31);
    const observed = vnTime(2026, 4, 20, 12);
    const q = quarter('2026-Q1', qEnd, 4000, 15, observed);
    const march = candle(vnTime(2026, 3, 31));
    const april19 = candle(vnTime(2026, 4, 19));
    expect(computeQuarterPePresentation(
      [march, april19], [q], DAY, vnTime(2026, 4, 19, 23),
    ).markers).toEqual([]);

    const april21 = candle(vnTime(2026, 4, 21));
    expect(computeQuarterPePresentation(
      [march, april19, april21], [q], DAY, vnTime(2026, 4, 21, 23),
    ).markers).toEqual([{ index: 0, value: 15, period: '2026-Q1' }]);
  });
});

describe('P/E quarterly repository', () => {
  it('reads the local SQLite route and normalizes quarterly rows', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('/pe-quarterly-api?symbol=MBB');
      return new Response(JSON.stringify({
        symbol: 'MBB',
        source: 'vnstock-unified',
        fetchedAt: 123,
        quarters: [{
          period: '2026-Q2',
          periodEnd: 200,
          trailingEps: 3200,
          peRatio: 6.8,
          firstObservedAt: 250,
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const repository = new PeQuarterlyRepository('/pe-quarterly-api', fetchImpl as typeof fetch);

    const record = await repository.get('mbb');

    expect(record.symbol).toBe('MBB');
    expect(record.quarters).toEqual([{
      period: '2026-Q2',
      periodEnd: 200,
      trailingEps: 3200,
      peRatio: 6.8,
      firstObservedAt: 250,
    }]);
  });

  it('reuses the short local cache for repeated reads', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      symbol: 'FPT',
      source: 'vnstock-unified',
      fetchedAt: 123,
      quarters: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const repository = new PeQuarterlyRepository('/pe-quarterly-api', fetchImpl as typeof fetch, 60_000);

    await repository.get('FPT');
    await repository.get('FPT');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
