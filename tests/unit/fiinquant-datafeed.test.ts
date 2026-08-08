import { describe, expect, it, vi } from 'vitest';
import type { Candle } from '../../src/core/types';
import type { HistoryRange } from '../../src/datafeed';
import {
  FiinQuantDatafeed,
} from '../../examples/providers/fiinquant';
import {
  mergeHistoryCoverage,
  type BrowserHistoryCacheApi,
} from '../../examples/providers/browser-history-cache';

function memoryCache(): BrowserHistoryCacheApi {
  let candles: Candle[] = [];
  let coverage: HistoryRange[] = [];
  return {
    available: true,
    async coverage() {
      return coverage.map((range) => ({ ...range }));
    },
    async readLatest(_source, _symbol, _interval, limit) {
      return candles.slice(-limit).map((candle) => ({ ...candle }));
    },
    async readRange(_source, _symbol, _interval, from, to, limit) {
      const selected = candles.filter((candle) => candle.time >= from && candle.time <= to);
      return selected.slice(0, limit ?? selected.length).map((candle) => ({ ...candle }));
    },
    async write(_source, _symbol, _interval, incoming) {
      const byTime = new Map(candles.map((candle) => [candle.time, candle]));
      for (const candle of incoming) byTime.set(candle.time, { ...candle });
      candles = [...byTime.values()].sort((left, right) => left.time - right.time);
    },
    async markCoverage(_source, _symbol, _interval, range) {
      coverage = mergeHistoryCoverage([...coverage, range]);
    },
    async clearSource() {
      candles = [];
      coverage = [];
    },
  };
}

describe('FiinQuantDatafeed browser history cache', () => {
  it('reuses a previous recent download for Replay without an old range request', async () => {
    const day = 86_400;
    const candles: Candle[] = [
      { time: 1_741_296_400, open: 100, high: 103, low: 99, close: 102, volume: 1_000 },
      { time: 1_741_382_800, open: 102, high: 105, low: 101, close: 104, volume: 1_200 },
      { time: 1_741_469_200, open: 104, high: 106, low: 103, close: 105, volume: 900 },
    ];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.searchParams.has('from')) {
        return new Response(JSON.stringify({ message: 'TimeFrameLimitFailed: from_date exceeds 365 days' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ candles }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const cache = memoryCache();
    const feed = new FiinQuantDatafeed('/fiinquant-api', '', { cache, fetchImpl });

    await expect(feed.getHistory('VIC', '1d', 500)).resolves.toEqual(candles);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const replayRange = {
      from: candles[0].time,
      // ReplaySession treats the shared history end as the next interval boundary.
      to: candles[candles.length - 1].time + day,
    };
    await expect(feed.getHistory('VIC', '1d', 500, replayRange)).resolves.toEqual(candles);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not silently return partial local history when backfill fails', async () => {
    const cached: Candle[] = [
      { time: 300, open: 10, high: 11, low: 9, close: 10.5 },
    ];
    const cache: BrowserHistoryCacheApi = {
      available: true,
      coverage: vi.fn(async () => [{ from: 300, to: 400 }]),
      readLatest: vi.fn(async () => cached),
      readRange: vi.fn(async () => cached),
      write: vi.fn(async () => undefined),
      markCoverage: vi.fn(async () => undefined),
      clearSource: vi.fn(async () => undefined),
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      message: 'TimeFrameLimitFailed: from_date exceeds 365 days',
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
    const feed = new FiinQuantDatafeed('/fiinquant-api', '', { cache, fetchImpl });

    await expect(feed.getHistory('VIC', '1d', 500, { from: 100, to: 400 }))
      .rejects.toThrow(/Local cache coverage.*could not backfill.*TimeFrameLimitFailed/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
