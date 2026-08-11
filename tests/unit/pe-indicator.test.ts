import { describe, expect, it, vi } from 'vitest';
import type { Candle } from '../../src/core/types';
import {
  computePeSeries,
  inferPePriceScale,
  peBarEvaluationTime,
  peQuarterEffectiveAt,
  type PeQuarter,
} from '../../src/indicators/builtin/pe-model';
import {
  mergePeFundamentals,
  type PeFundamentalsRecord,
} from '../../src/indicators/builtin/pe-cache';
import {
  PeFundamentalsRepository,
  type PeCacheApi,
} from '../../src/indicators/builtin/pe-client';

const VN_OFFSET = 7 * 60 * 60;
const DAY = 24 * 60 * 60;

function vnTime(year: number, month: number, day: number, hour = 9): number {
  return Math.floor(Date.UTC(year, month - 1, day, hour) / 1000) - VN_OFFSET;
}

function candle(time: number, close: number): Candle {
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

class MemoryCache implements PeCacheApi {
  readonly rows = new Map<string, PeFundamentalsRecord>();

  async get(symbol: string): Promise<PeFundamentalsRecord | null> {
    return this.rows.get(symbol) ?? null;
  }

  async put(record: PeFundamentalsRecord): Promise<void> {
    this.rows.set(record.symbol, record);
  }
}

describe('P/E time model', () => {
  it('uses end-of-day availability instead of candle open time', () => {
    const open = vnTime(2026, 8, 11, 9);
    const midday = vnTime(2026, 8, 11, 13);
    const evaluation = peBarEvaluationTime(candle(open, 60), DAY, midday);
    expect(evaluation).toBe(midday);
  });

  it('never uses a quarter before its replay-safe effective time', () => {
    const q1End = vnTime(2026, 3, 31, 0);
    const observed = q1End + 20 * DAY;
    const q1 = quarter('2026-Q1', q1End, 4000, 15, observed);
    expect(peQuarterEffectiveAt(q1)).toBe(observed);

    const before = candle(vnTime(2026, 4, 19), 60);
    const after = candle(vnTime(2026, 4, 21), 60);
    const result = computePeSeries([before, after], [q1], DAY, vnTime(2026, 4, 22));
    expect(result.values[0]).toBeNull();
    expect(result.values[1]).toBeCloseTo(15, 6);
  });

  it('uses conservative fallback when a historical quarter was first observed much later', () => {
    const q1End = vnTime(2026, 3, 31, 0);
    const firstObservedMuchLater = vnTime(2026, 8, 11, 20);
    const q1 = quarter('2026-Q1', q1End, 4000, 15, firstObservedMuchLater);
    expect(peQuarterEffectiveAt(q1)).toBe(q1End + 30 * DAY);
  });

  it('infers thousand-VND chart prices from Vnstock EPS and reported P/E', () => {
    const candles = [candle(vnTime(2026, 8, 11), 62)];
    const q2 = quarter('2026-Q2', vnTime(2026, 6, 30, 0), 4159.65, 14.42, vnTime(2026, 8, 11));
    expect(inferPePriceScale(candles, [q2])).toBe(1000);
  });

  it('keeps VND-denominated chart prices unscaled', () => {
    const candles = [candle(vnTime(2026, 8, 11), 62_000)];
    const q2 = quarter('2026-Q2', vnTime(2026, 6, 30, 0), 4159.65, 14.42, vnTime(2026, 8, 11));
    expect(inferPePriceScale(candles, [q2])).toBe(1);
  });

  it('does not invent a P/E when trailing EPS is zero or negative', () => {
    const day = candle(vnTime(2026, 8, 11), 62);
    const q2 = quarter('2026-Q2', vnTime(2026, 6, 30, 0), -500, null, vnTime(2026, 7, 20));
    const result = computePeSeries([day], [q2], DAY, vnTime(2026, 8, 12));
    expect(result.values).toEqual([null]);
  });

  it('does not render P/E on intraday intervals', () => {
    const day = candle(vnTime(2026, 8, 11), 62);
    const q2 = quarter('2026-Q2', vnTime(2026, 6, 30, 0), 4159.65, 14.42, vnTime(2026, 7, 20));
    const result = computePeSeries([day], [q2], 60 * 60, vnTime(2026, 8, 12));
    expect(result.values).toEqual([null]);
    expect(result.markers).toEqual([]);
  });

  it('evaluates weekly and monthly closing P/E at the bucket end', () => {
    const qEnd = vnTime(2026, 6, 30, 0);
    const q = quarter('2026-Q2', qEnd, 4000, 15, vnTime(2026, 7, 15, 12));
    const julyMonth = candle(vnTime(2026, 7, 1), 64);
    const result = computePeSeries([julyMonth], [q], 30 * DAY, vnTime(2026, 8, 1));
    expect(result.values[0]).toBeCloseTo(16, 6);
  });

  it('hides a quarterly marker until the quarter is knowable in replay', () => {
    const qEnd = vnTime(2026, 3, 31, 0);
    const observed = vnTime(2026, 4, 20, 12);
    const q = quarter('2026-Q1', qEnd, 4000, 15, observed);
    const march = candle(vnTime(2026, 3, 31), 60);
    const april19 = candle(vnTime(2026, 4, 19), 60);
    const before = computePeSeries([march, april19], [q], DAY, vnTime(2026, 4, 19, 23));
    expect(before.markers).toEqual([]);

    const april21 = candle(vnTime(2026, 4, 21), 60);
    const after = computePeSeries([march, april19, april21], [q], DAY, vnTime(2026, 4, 21, 23));
    expect(after.markers).toEqual([{ index: 0, value: 15, period: '2026-Q1' }]);
    expect(after.latestReportedPe).toBe(15);
  });
});

describe('P/E cache merge', () => {
  it('preserves the first observation while refreshing corrected values', () => {
    const existing: PeFundamentalsRecord = {
      symbol: 'VNM',
      source: 'vnstock-unified',
      fetchedAt: 1000,
      quarters: [quarter('2026-Q2', 500, 4100, 14, 900)],
    };
    const merged = mergePeFundamentals(existing, {
      symbol: 'vnm',
      source: 'vnstock-unified',
      quarters: [{ period: '2026-Q2', periodEnd: 500, trailingEps: 4159.65, peRatio: 14.42 }],
    }, 2000);
    expect(merged.quarters[0]).toEqual({
      period: '2026-Q2',
      periodEnd: 500,
      trailingEps: 4159.65,
      peRatio: 14.42,
      firstObservedAt: 900,
    });
    expect(merged.fetchedAt).toBe(2000);
  });
});

describe('P/E repository', () => {
  it('deduplicates simultaneous Vnstock requests and stores normalized payload', async () => {
    const cache = new MemoryCache();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      symbol: 'VNM',
      source: 'vnstock-unified',
      quarters: [
        { period: '2026-Q2', periodEnd: 123, trailingEps: 4159.65, peRatio: 14.42 },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const repository = new PeFundamentalsRepository({
      cache,
      fetchImpl: fetchImpl as typeof fetch,
      now: () => 777,
    });

    const [first, second] = await Promise.all([
      repository.fetchAndCache('VNM'),
      repository.fetchAndCache('vnm'),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.quarters[0].firstObservedAt).toBe(777);
    expect(await repository.getCached('VNM')).toEqual(first);
  });

  it('keeps API errors isolated as regular rejected promises', async () => {
    const repository = new PeFundamentalsRepository({
      cache: new MemoryCache(),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ message: 'quota reached' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
      now: () => 1,
    });
    await expect(repository.fetchAndCache('VNM')).rejects.toThrow('quota reached');
  });
});
