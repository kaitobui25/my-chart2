import { describe, expect, it, vi } from 'vitest';
import { PeFundamentalsCache } from '../../src/indicators/external/pe-cache';
import { PeValuationCache } from '../../src/indicators/external/pe-valuation-cache';

describe('P/E SQLite caches', () => {
  it('reads quarterly P/E from stockdata instead of IndexedDB', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('/stockdata-api/pe/quarterly?symbol=MBB');
      return new Response(JSON.stringify({
        symbol: 'MBB',
        source: 'vnstock-unified',
        fetchedAt: 100,
        quarters: [{
          period: '2026-Q2',
          periodEnd: 200,
          trailingEps: 3200,
          peRatio: 6.8,
          firstObservedAt: 150,
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const cache = new PeFundamentalsCache({ fetchImpl: fetchImpl as typeof fetch });

    const record = await cache.get('mbb');

    expect(record?.quarters[0].firstObservedAt).toBe(150);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('writes quarterly P/E to stockdata', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/stockdata-api/pe/quarterly');
      expect(init?.method).toBe('POST');
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const cache = new PeFundamentalsCache({ fetchImpl: fetchImpl as typeof fetch });

    await cache.put({
      symbol: 'MBB',
      source: 'vnstock-unified',
      fetchedAt: 100,
      quarters: [{
        period: '2026-Q2',
        periodEnd: 200,
        trailingEps: 3200,
        peRatio: 6.8,
        firstObservedAt: 150,
      }],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reads and writes daily valuation through stockdata', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        expect(url).toBe('/stockdata-api/pe/daily');
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      expect(url).toBe('/stockdata-api/pe/daily?symbol=MBB');
      return new Response(JSON.stringify({
        symbol: 'MBB',
        source: 'fiinquant-stock-valuation',
        fetchedAt: 100,
        coverage: [{ from: 10, to: 20 }],
        points: [{ time: 15, pe: 6.4, pb: 1.2 }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const cache = new PeValuationCache({ fetchImpl: fetchImpl as typeof fetch });

    const record = await cache.get('MBB');
    expect(record?.coverage).toEqual([{ from: 10, to: 20 }]);
    await cache.put(record!);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
