import type { Candle } from '../../src/core/types';
import {
  BINANCE_SPOT_HISTORY_SOURCE,
  BINANCE_USDM_HISTORY_SOURCE,
  BrowserHistoryCache,
  type BrowserHistoryCacheApi,
} from './browser-history-cache';

export type BinanceMarket = 'spot' | 'usdm';

export interface BinanceCacheCoverage {
  from: number;
  to: number;
}

export interface BinanceHistoryCacheOptions {
  enabled?: boolean;
  readTimeoutMs?: number;
  writeTimeoutMs?: number;
  writeChunkSize?: number;
}

const DEFAULT_READ_TIMEOUT_MS = 800;
const DEFAULT_WRITE_TIMEOUT_MS = 1500;
const DEFAULT_WRITE_CHUNK_SIZE = 32;

function sourceForMarket(market: BinanceMarket): string {
  return market === 'spot' ? BINANCE_SPOT_HISTORY_SOURCE : BINANCE_USDM_HISTORY_SOURCE;
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

/**
 * Binance-specific scheduling over the shared browser cache.
 *
 * Browser persistence is intentionally opt-in for the default Binance provider.
 * On some Chromium/Opera sessions an IndexedDB transaction can remain blocked for
 * many seconds even after abort(), which is worse than simply refetching Binance.
 * Callers that explicitly inject a cache keep persistence enabled by default.
 */
export class BinanceHistoryCache {
  private readonly cache: BrowserHistoryCacheApi;
  private readonly enabled: boolean;
  private readonly readTimeoutMs: number;
  private readonly writeTimeoutMs: number;
  private readonly writeChunkSize: number;
  private readonly activeWrites = new Set<AbortController>();
  private foregroundGeneration = 0;

  constructor(
    cache?: BrowserHistoryCacheApi,
    options: BinanceHistoryCacheOptions = {},
  ) {
    const injectedCache = cache !== undefined;
    this.cache = cache ?? new BrowserHistoryCache();
    this.enabled = options.enabled ?? injectedCache;
    this.readTimeoutMs = Math.max(0, options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS);
    this.writeTimeoutMs = Math.max(0, options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS);
    this.writeChunkSize = Math.max(1, Math.floor(options.writeChunkSize ?? DEFAULT_WRITE_CHUNK_SIZE));
  }

  get available(): boolean {
    return this.enabled && this.cache.available;
  }

  async coverage(market: BinanceMarket, symbol: string, interval: string): Promise<BinanceCacheCoverage | null> {
    if (!this.enabled) return null;
    const ranges = await this.cache.coverage(sourceForMarket(market), symbol, interval);
    if (ranges.length === 0) return null;
    return {
      from: ranges[0].from,
      to: ranges[ranges.length - 1].to,
    };
  }

  async readLatest(
    market: BinanceMarket,
    symbol: string,
    interval: string,
    limit: number,
  ): Promise<Candle[]> {
    if (!this.enabled) return [];
    this.beginForegroundRead();
    return this.readWithDeadline((signal) =>
      this.cache.readLatest(sourceForMarket(market), symbol, interval, limit, signal));
  }

  async readRange(
    market: BinanceMarket,
    symbol: string,
    interval: string,
    from: number,
    to: number,
    limit?: number,
  ): Promise<Candle[]> {
    if (!this.enabled) return [];
    this.beginForegroundRead();
    return this.readWithDeadline((signal) =>
      this.cache.readRange(sourceForMarket(market), symbol, interval, from, to, limit, signal));
  }

  async write(
    market: BinanceMarket,
    symbol: string,
    interval: string,
    candles: Candle[],
  ): Promise<void> {
    if (!this.enabled || candles.length === 0) return;

    // Newer data wins. Never build a queue of stale full-history writes.
    this.cancelActiveWrites();
    const generation = this.foregroundGeneration;
    const controller = new AbortController();
    this.activeWrites.add(controller);
    const source = sourceForMarket(market);

    try {
      for (let offset = 0; offset < candles.length; offset += this.writeChunkSize) {
        if (controller.signal.aborted || generation !== this.foregroundGeneration) return;
        const chunk = candles.slice(offset, offset + this.writeChunkSize);
        const timed = new AbortController();
        const abortTimed = () => timed.abort();
        controller.signal.addEventListener('abort', abortTimed, { once: true });
        const timeout = globalThis.setTimeout(abortTimed, this.writeTimeoutMs);
        try {
          await this.cache.write(source, symbol, interval, chunk, timed.signal);
        } finally {
          globalThis.clearTimeout(timeout);
          controller.signal.removeEventListener('abort', abortTimed);
        }
        if (timed.signal.aborted || controller.signal.aborted || generation !== this.foregroundGeneration) return;
        if (offset + this.writeChunkSize < candles.length) await nextTask();
      }
    } finally {
      this.activeWrites.delete(controller);
    }
  }

  async clearMarket(market: BinanceMarket): Promise<void> {
    this.foregroundGeneration += 1;
    this.cancelActiveWrites();
    if (!this.enabled) return;
    await this.cache.clearSource(sourceForMarket(market));
  }

  private beginForegroundRead(): void {
    this.foregroundGeneration += 1;
    this.cancelActiveWrites();
  }

  private cancelActiveWrites(): void {
    for (const controller of this.activeWrites) controller.abort();
    this.activeWrites.clear();
  }

  private readWithDeadline(read: (signal: AbortSignal) => Promise<Candle[]>): Promise<Candle[]> {
    const controller = new AbortController();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (candles: Candle[]) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeout);
        resolve(controller.signal.aborted ? [] : candles);
      };
      const timeout = globalThis.setTimeout(() => {
        controller.abort();
        finish([]);
      }, this.readTimeoutMs);
      read(controller.signal).then(finish, () => finish([]));
    });
  }
}
