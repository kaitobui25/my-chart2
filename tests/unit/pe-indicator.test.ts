import { describe, expect, it, vi } from 'vitest';
import type { Candle } from '../../src/core/types';
import {
  computeFiinQuantPeLine,
  computeQuarterPePresentation,
  peBarEvaluationTime,
  peQuarterEffectiveAt,
  peValuationRangeForCandles,
  type PeQuarter,
} from '../../src/indicators/external/pe-model';
import {
  mergePeFundamentals,
  type PeFundamentalsRecord,
} from '../../src/indicators/external/pe-cache';
import {
  PeFundamentalsRepository,
  type PeCacheApi,
} from '../../src/indicators/external/pe-client';
import {
  mergePeValuation,
  missingPeValuationRanges,
  type PeValuationRecord,
} from '../../src/indicators/external/pe-valuation-cache';
import {
  PeValuationRepository,
  type PeValuationCacheApi,
} from '../../src/indicators/external/pe-valuation-client';

const VN_OFFSET = 7 * 60 * 60;
const DAY = 24 * 60 * 60;

function vnTime(year: number, month: number, day: number, hour = 9): number {
  return Math.floor(Date.UTC(year, month - 1, day, hour) / 1000) - VN_OFFSET;
}

function vnMidnight(year: number, month: number, day: number): number {
  return vnTime(year, month, day, 0);
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

class MemoryQuarterCache implements PeCacheApi {
  readonly rows = new Map<string, PeFundamentalsRecord>();

  async get(symbol: string): Promise<PeFundamentalsRecord | null> {
    return this.rows.get(symbol) ?? null;
  }

  async put(record: PeFundamentalsRecord): Promise<void> {
    this.rows.set(record.symbol, record);
  }
}

class MemoryValuationCache implements PeValuationCacheApi {
  readonly rows = new Map<string, PeValuationRecord>();

  async get(symbol: string): Promise<PeValuationRecord | null> {
    return this.rows.get(symbol) ?? null;
  }

  async put(record: PeValuationRecord): Promise<void> {
    this.rows.set(record.symbol, record);
  }
}

describe('P/E FiinQuant line model', () => {
  it('maps raw daily P/E to the same trading day without Close/EPS math', () => {
    const candles = [
      candle(vnTime(2026, 8, 7)),
      candle(vnTime(2026, 8, 10)),
      candle(vnTime(2026, 8, 11)),
    ];
    const values = computeFiinQuantPeLine(candles, [
      { time: vnMidnight(2026, 8, 7), pe: 6.46742323, pb: 1.2 },
      { time: vnMidnight(2026, 8, 10), pe: 6.49420345, pb: 1.21 },
      { time: vnMidnight(2026, 8, 11), pe: 6.26873416, pb: 1.18 },
    ], DAY, vnTime(2026, 8, 12));
    expect(values).toEqual([6.46742323, 6.49420345, 6.26873416]);
  });

  it('does not forward-fill a missing daily valuation', () => {
    const candles = [candle(vnTime(2026, 8, 7)), candle(vnTime(2026, 8, 10))];
    const values = computeFiinQuantPeLine(candles, [
      { time: vnMidnight(2026, 8, 7), pe: 6.47, pb: null },
    ], DAY, vnTime(2026, 8, 12));
    expect(values).toEqual([6.47, null]);
  });

  it('uses the last valid daily P/E inside a weekly bucket', () => {
    const week = candle(vnTime(2026, 8, 3));
    const values = computeFiinQuantPeLine([week], [
      { time: vnMidnight(2026, 8, 3), pe: 6.1, pb: null },
      { time: vnMidnight(2026, 8, 5), pe: 6.2, pb: null },
      { time: vnMidnight(2026, 8, 7), pe: 6.47, pb: null },
    ], 7 * DAY, vnTime(2026, 8, 9));
    expect(values).toEqual([6.47]);
  });

  it('uses the last valid daily P/E inside a monthly bucket', () => {
    const month = candle(vnTime(2026, 7, 1));
    const values = computeFiinQuantPeLine([month], [
      { time: vnMidnight(2026, 7, 1), pe: 7.8, pb: null },
      { time: vnMidnight(2026, 7, 31), pe: 7.35, pb: null },
    ], 30 * DAY, vnTime(2026, 8, 1));
    expect(values).toEqual([7.35]);
  });

  it('renders no blue line on intraday intervals', () => {
    const values = computeFiinQuantPeLine(
      [candle(vnTime(2026, 8, 11))],
      [{ time: vnMidnight(2026, 8, 11), pe: 6.27, pb: null }],
      60 * 60,
      vnTime(2026, 8, 12),
    );
    expect(values).toEqual([null]);
  });

  it('derives the valuation request range from visible chart buckets', () => {
    const candles = [candle(vnTime(2026, 8, 7)), candle(vnTime(2026, 8, 11))];
    const range = peValuationRangeForCandles(candles, DAY, vnTime(2026, 8, 12));
    expect(range).toEqual({
      from: vnMidnight(2026, 8, 7),
      to: vnEndOfDay(2026, 8, 11),
    });
  });
});

describe('P/E quarterly Vnstock marker model', () => {
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

  it('keeps raw Vnstock peRatio as yellow-marker Y even when it differs from the blue line', () => {
    const qEnd = vnEndOfDay(2026, 6, 30);
    const q = quarter('2026-Q2', qEnd, 4050.73, 6.47, vnTime(2026, 7, 20));
    const june30 = candle(vnTime(2026, 6, 30));
    const july21 = candle(vnTime(2026, 7, 21));
    const presentation = computeQuarterPePresentation(
      [june30, july21],
      [q],
      DAY,
      vnTime(2026, 7, 21, 23),
    );
    expect(presentation.markers).toEqual([{ index: 0, value: 6.47, period: '2026-Q2' }]);
    expect(presentation.latestReportedPe).toBe(6.47);
  });

  it('hides the quarterly marker until the quarter is knowable in replay', () => {
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

describe('P/E caches', () => {
  it('preserves old Vnstock quarters while refreshing raw quarterly values', () => {
    const existing: PeFundamentalsRecord = {
      symbol: 'VNM',
      source: 'vnstock-unified',
      fetchedAt: 1000,
      quarters: [
        quarter('2025-Q4', 400, 3900, 13, 600),
        quarter('2026-Q1', 500, 4100, 14, 700),
      ],
    };
    const merged = mergePeFundamentals(existing, {
      symbol: 'VNM',
      source: 'vnstock-unified',
      quarters: [
        { period: '2026-Q1', periodEnd: 500, trailingEps: 4200, peRatio: 14.5 },
        { period: '2026-Q2', periodEnd: 600, trailingEps: 4300, peRatio: 15 },
      ],
    }, 2000);
    expect(merged.quarters.map((item) => item.period)).toEqual(['2025-Q4', '2026-Q1', '2026-Q2']);
    expect(merged.quarters[0].firstObservedAt).toBe(600);
  });

  it('merges FiinQuant ranges and daily points without duplicates', () => {
    const existing: PeValuationRecord = {
      symbol: 'MBB',
      source: 'fiinquant-stock-valuation',
      fetchedAt: 100,
      coverage: [{ from: 10, to: 20 }],
      points: [{ time: 15, pe: 6.1, pb: 1.1 }],
    };
    const merged = mergePeValuation(existing, {
      symbol: 'mbb',
      source: 'fiinquant-stock-valuation',
      points: [
        { time: 15, pe: 6.2, pb: 1.2 },
        { time: 25, pe: 6.3, pb: 1.3 },
      ],
    }, 21, 30, 999);
    expect(merged.coverage).toEqual([{ from: 10, to: 30 }]);
    expect(merged.points).toEqual([
      { time: 15, pe: 6.2, pb: 1.2 },
      { time: 25, pe: 6.3, pb: 1.3 },
    ]);
    expect(merged.fetchedAt).toBe(999);
  });

  it('returns only missing FiinQuant coverage ranges', () => {
    const record: PeValuationRecord = {
      symbol: 'MBB',
      source: 'fiinquant-stock-valuation',
      fetchedAt: 100,
      coverage: [{ from: 20, to: 30 }, { from: 40, to: 50 }],
      points: [],
    };
    expect(missingPeValuationRanges(record, 10, 60)).toEqual([
      { from: 10, to: 19 },
      { from: 31, to: 39 },
      { from: 51, to: 60 },
    ]);
  });
});

describe('P/E repositories', () => {
  it('deduplicates simultaneous Vnstock requests', async () => {
    const cache = new MemoryQuarterCache();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      symbol: 'VNM',
      source: 'vnstock-unified',
      quarters: [{ period: '2026-Q2', periodEnd: 123, trailingEps: 4159.65, peRatio: 14.42 }],
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
  });

  it('fetches only missing FiinQuant range and persists raw PE/PB', async () => {
    const cache = new MemoryValuationCache();
    await cache.put({
      symbol: 'MBB',
      source: 'fiinquant-stock-valuation',
      fetchedAt: 100,
      coverage: [{ from: 10, to: 20 }],
      points: [{ time: 15, pe: 6.1, pb: 1.1 }],
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('from=21');
      expect(String(input)).toContain('to=30');
      return new Response(JSON.stringify({
        symbol: 'MBB',
        source: 'fiinquant-stock-valuation',
        points: [{ time: 25, pe: 6.3, pb: 1.3 }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const repository = new PeValuationRepository({
      cache,
      ensureUrl: null,
      fetchImpl: fetchImpl as typeof fetch,
      now: () => 999,
    });
    const record = await repository.fetchAndCache('mbb', 10, 30);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(record.coverage).toEqual([{ from: 10, to: 30 }]);
    expect(record.points.map((item) => item.pe)).toEqual([6.1, 6.3]);
  });

  it('lazily ensures the FiinQuant runtime once before valuation requests', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url === '/provider-runtime/fiinquant/ensure') {
        expect(init?.method).toBe('POST');
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        symbol: 'MBB',
        source: 'fiinquant-stock-valuation',
        points: [{ time: 15, pe: 6.2, pb: 1.2 }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const repository = new PeValuationRepository({
      cache: new MemoryValuationCache(),
      fetchImpl: fetchImpl as typeof fetch,
      now: () => 999,
    });

    await repository.fetchAndCache('MBB', 10, 20);
    await repository.fetchAndCache('MBB', 10, 20, true);

    expect(calls.filter((url) => url === '/provider-runtime/fiinquant/ensure')).toHaveLength(1);
    expect(calls.filter((url) => url.includes('/valuation/stock?'))).toHaveLength(2);
  });

  it('keeps source errors isolated as rejected promises', async () => {
    const repository = new PeValuationRepository({
      cache: new MemoryValuationCache(),
      ensureUrl: null,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ message: 'FiinQuant unavailable' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
      now: () => 1,
    });
    await expect(repository.fetchAndCache('MBB', 10, 20)).rejects.toThrow('FiinQuant unavailable');
  });
});
