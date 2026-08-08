import type { Candle } from '../../src/core/types';
import type { Datafeed, HistoryRange, SymbolSearchResult } from '../../src/datafeed';
import { intervalApproxSeconds, intervalStart, isCalendarInterval, nextIntervalStart } from '../../src/interval';
import {
  BrowserHistoryCache,
  mergeHistoryCoverage,
  missingHistoryCoverage,
  type BrowserHistoryCacheApi,
} from './browser-history-cache';

export const VNSTOCK_HISTORY_SOURCE = 'vnstock:ohlcv:v1';
const VNSTOCK_UTC_OFFSET_MINUTES = 7 * 60;
const MAX_HISTORY_REQUEST = 50_000;
const DEFAULT_POLL_MS = 5_000;
const MAX_POLL_SYMBOLS = 50;

export interface VnstockHealth {
  ok: boolean;
  configured: boolean;
  provider?: string;
  routing?: string;
  timezone?: string;
  pollIntervalSeconds?: number;
  error?: string;
}

export interface VnstockDatafeedOptions {
  cache?: BrowserHistoryCacheApi;
  fetchImpl?: typeof fetch;
  pollMs?: number;
}

interface PollSubscription {
  symbol: string;
  interval: string;
  listeners: Set<(candle: Candle) => void>;
}

function mergeCandles(...groups: Candle[][]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const group of groups) {
    for (const candle of group) byTime.set(candle.time, candle);
  }
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

function formatHistoryDate(time: number): string {
  return new Date(time * 1000).toISOString().slice(0, 10);
}

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

export class VnstockDatafeed implements Datafeed {
  readonly name = 'Vnstock';
  private readonly baseUrl: string;
  private readonly cache: BrowserHistoryCacheApi;
  private readonly fetchImpl: typeof fetch;
  private pollMs: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollInFlight = false;
  private disposed = false;
  private readonly subscriptions = new Map<string, PollSubscription>();

  constructor(baseUrl = '/vnstock-api', options: VnstockDatafeedOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.cache = options.cache ?? new BrowserHistoryCache();
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.pollMs = Math.max(2_000, options.pollMs ?? DEFAULT_POLL_MS);
  }

  get cacheAvailable(): boolean {
    return this.cache.available;
  }

  async clearCache(): Promise<void> {
    await this.cache.clearSource(VNSTOCK_HISTORY_SOURCE);
  }

  private apiUrl(path: string): URL {
    const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
    return new URL(`${this.baseUrl}${path}`, origin);
  }

  async health(): Promise<VnstockHealth> {
    const response = await this.fetchImpl(`${this.baseUrl}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    const payload = await response.json().catch(() => ({})) as VnstockHealth;
    if (!response.ok) {
      throw new Error(payload.error || `Vnstock sidecar HTTP ${response.status}`);
    }
    if (payload.pollIntervalSeconds && Number.isFinite(payload.pollIntervalSeconds)) {
      this.pollMs = Math.max(2_000, payload.pollIntervalSeconds * 1_000);
    }
    return payload;
  }

  async searchSymbols(query: string, limit = 20): Promise<SymbolSearchResult[]> {
    const url = this.apiUrl('/symbols');
    url.searchParams.set('q', query.trim().toUpperCase());
    url.searchParams.set('limit', String(Math.min(100, Math.max(1, limit))));
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(8_000) });
    const payload = await response.json().catch(() => ({})) as {
      symbols?: SymbolSearchResult[];
      message?: string;
    };
    if (!response.ok) throw new Error(payload.message ?? `Vnstock sidecar HTTP ${response.status}`);
    return (payload.symbols ?? [])
      .filter((item) => typeof item.symbol === 'string' && item.symbol.trim())
      .map((item) => ({
        symbol: item.symbol.trim().toUpperCase(),
        name: item.name?.trim(),
        exchange: item.exchange?.trim(),
      }));
  }

  async getHistory(symbol: string, interval: string, limit = 500, range?: HistoryRange): Promise<Candle[]> {
    const normalizedSymbol = symbol.trim().toUpperCase();
    if (!normalizedSymbol) return [];
    const requestedLimit = Math.min(MAX_HISTORY_REQUEST, Math.max(1, Math.floor(limit)));

    if (!range) {
      const cached = await this.cache.readLatest(
        VNSTOCK_HISTORY_SOURCE,
        normalizedSymbol,
        interval,
        requestedLimit,
      );
      try {
        const remote = await this.fetchHistory(normalizedSymbol, interval, requestedLimit);
        await this.persistHistory(normalizedSymbol, interval, remote, this.returnedCoverage(remote, interval));
        return mergeCandles(cached, remote).slice(-requestedLimit);
      } catch (error) {
        if (cached.length > 0) return cached;
        throw error;
      }
    }

    const requested = this.normalizeRange(range, interval);
    if (requested.from > requested.to) return [];
    const cached = await this.cache.readRange(
      VNSTOCK_HISTORY_SOURCE,
      normalizedSymbol,
      interval,
      requested.from,
      requested.to,
      requestedLimit,
    );
    const coverage = await this.cache.coverage(VNSTOCK_HISTORY_SOURCE, normalizedSymbol, interval);
    const missing = missingHistoryCoverage(coverage, requested);
    if (missing.length === 0) {
      return cached
        .filter((candle) => candle.time >= requested.from && candle.time <= requested.to)
        .slice(-requestedLimit);
    }

    let fetched: Candle[] = [];
    for (const gap of missing) {
      try {
        const remote = await this.fetchHistory(normalizedSymbol, interval, requestedLimit, gap);
        fetched = mergeCandles(fetched, remote);
        await this.persistHistory(normalizedSymbol, interval, remote, gap);
      } catch (error) {
        const partial = mergeCandles(cached, fetched);
        if (partial.length > 0) {
          throw this.partialHistoryError(coverage, gap, error);
        }
        throw error;
      }
    }

    const complete = await this.cache.readRange(
      VNSTOCK_HISTORY_SOURCE,
      normalizedSymbol,
      interval,
      requested.from,
      requested.to,
      requestedLimit,
    );
    return mergeCandles(cached, complete, fetched)
      .filter((candle) => candle.time >= requested.from && candle.time <= requested.to)
      .slice(-requestedLimit);
  }

  subscribe(symbol: string, interval: string, onCandle: (candle: Candle) => void): () => void {
    if (this.disposed) return () => undefined;
    const remove = this.addListener(symbol, interval, onCandle);
    this.schedulePoll(0);
    return remove;
  }

  subscribeMany(
    symbols: string[],
    interval: string,
    onCandle: (symbol: string, candle: Candle) => void,
  ): () => void {
    if (this.disposed) return () => undefined;
    const normalized = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
    const removers = normalized.map((symbol) => this.addListener(
      symbol,
      interval,
      (candle) => onCandle(symbol, candle),
    ));
    this.schedulePoll(0);
    return () => removers.forEach((remove) => remove());
  }

  dispose(): void {
    this.disposed = true;
    this.subscriptions.clear();
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private addListener(symbol: string, interval: string, listener: (candle: Candle) => void): () => void {
    const normalizedSymbol = symbol.trim().toUpperCase();
    const key = `${normalizedSymbol}\u0000${interval}`;
    let subscription = this.subscriptions.get(key);
    if (!subscription) {
      subscription = { symbol: normalizedSymbol, interval, listeners: new Set() };
      this.subscriptions.set(key, subscription);
    }
    subscription.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.subscriptions.get(key);
      current?.listeners.delete(listener);
      if (current?.listeners.size === 0) this.subscriptions.delete(key);
      if (this.subscriptions.size === 0 && this.pollTimer) {
        clearTimeout(this.pollTimer);
        this.pollTimer = null;
      }
    };
  }

  private schedulePoll(delay = this.pollMs): void {
    if (this.disposed || this.subscriptions.size === 0 || this.pollTimer) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll().finally(() => this.schedulePoll());
    }, delay);
  }

  private async poll(): Promise<void> {
    if (this.pollInFlight || this.disposed || this.subscriptions.size === 0) return;
    this.pollInFlight = true;
    try {
      const byInterval = new Map<string, PollSubscription[]>();
      for (const subscription of this.subscriptions.values()) {
        const group = byInterval.get(subscription.interval) ?? [];
        group.push(subscription);
        byInterval.set(subscription.interval, group);
      }
      for (const [interval, subscriptions] of byInterval) {
        for (const batch of chunks(subscriptions, MAX_POLL_SYMBOLS)) {
          const url = this.apiUrl('/latest');
          url.searchParams.set('symbols', batch.map((item) => item.symbol).join(','));
          url.searchParams.set('interval', interval);
          try {
            const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(Math.max(8_000, this.pollMs)) });
            const payload = await response.json().catch(() => ({})) as {
              candles?: Record<string, Candle>;
            };
            if (!response.ok) continue;
            for (const subscription of batch) {
              const candle = this.validCandle(payload.candles?.[subscription.symbol]);
              if (!candle) continue;
              await this.persistHistory(subscription.symbol, interval, [candle], this.returnedCoverage([candle], interval));
              const current = this.subscriptions.get(`${subscription.symbol}\u0000${interval}`);
              if (!current) continue;
              for (const listener of current.listeners) listener(candle);
            }
          } catch {
            // Polling is best effort. Historical requests remain the recovery path.
          }
        }
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  private async fetchHistory(
    symbol: string,
    interval: string,
    limit: number,
    range?: HistoryRange,
  ): Promise<Candle[]> {
    const url = this.apiUrl('/history');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('limit', String(limit));
    if (range) {
      url.searchParams.set('from', String(range.from));
      url.searchParams.set('to', String(range.to));
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new Error(`Cannot reach the Vnstock sidecar at ${this.baseUrl}`);
    }
    const payload = await response.json().catch(() => ({})) as {
      candles?: unknown[];
      message?: string;
    };
    if (!response.ok) throw new Error(payload.message ?? `Vnstock sidecar HTTP ${response.status}`);
    return (payload.candles ?? [])
      .map((item) => this.validCandle(item))
      .filter((item): item is Candle => item !== null)
      .filter((candle) => !range || (candle.time >= range.from && candle.time <= range.to));
  }

  private normalizeRange(range: HistoryRange, interval: string): HistoryRange {
    const from = Math.min(range.from, range.to);
    const to = Math.max(range.from, range.to);
    if (!isCalendarInterval(interval)) return { from, to };
    return {
      from: intervalStart(from, interval, VNSTOCK_UTC_OFFSET_MINUTES),
      to: Math.min(
        Math.floor(Date.now() / 1000),
        nextIntervalStart(to, interval, VNSTOCK_UTC_OFFSET_MINUTES) - 1,
      ),
    };
  }

  private returnedCoverage(candles: Candle[], interval: string): HistoryRange | null {
    if (candles.length === 0) return null;
    const first = Math.min(...candles.map((candle) => candle.time));
    const last = Math.max(...candles.map((candle) => candle.time));
    const to = isCalendarInterval(interval)
      ? nextIntervalStart(last, interval, VNSTOCK_UTC_OFFSET_MINUTES)
      : last + Math.max(1, intervalApproxSeconds(interval));
    return { from: first, to };
  }

  private async persistHistory(
    symbol: string,
    interval: string,
    candles: Candle[],
    coverage: HistoryRange | null,
  ): Promise<void> {
    if (candles.length > 0) await this.cache.write(VNSTOCK_HISTORY_SOURCE, symbol, interval, candles);
    if (coverage) await this.cache.markCoverage(VNSTOCK_HISTORY_SOURCE, symbol, interval, coverage);
  }

  private partialHistoryError(coverage: HistoryRange[], gap: HistoryRange, cause: unknown): Error {
    const known = mergeHistoryCoverage(coverage);
    const local = known.length === 0
      ? 'Local cache has no confirmed coverage.'
      : `Local cache coverage is ${formatHistoryDate(known[0].from)} to ${formatHistoryDate(known[known.length - 1].to)}.`;
    const reason = cause instanceof Error ? cause.message : String(cause);
    return new Error(`${local} Vnstock could not backfill ${formatHistoryDate(gap.from)} to ${formatHistoryDate(gap.to)}: ${reason}`);
  }

  private validCandle(value: unknown): Candle | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Partial<Candle>;
    const time = Number(raw.time);
    const open = Number(raw.open);
    const high = Number(raw.high);
    const low = Number(raw.low);
    const close = Number(raw.close);
    const volume = raw.volume === undefined || raw.volume === null ? undefined : Number(raw.volume);
    if (
      !Number.isFinite(time) || time <= 0
      || !Number.isFinite(open) || open <= 0
      || !Number.isFinite(high) || high <= 0
      || !Number.isFinite(low) || low <= 0
      || !Number.isFinite(close) || close <= 0
      || high < Math.max(open, close, low)
      || low > Math.min(open, close, high)
      || (volume !== undefined && (!Number.isFinite(volume) || volume < 0))
    ) return null;
    return { time, open, high, low, close, ...(volume === undefined ? {} : { volume }) };
  }
}
