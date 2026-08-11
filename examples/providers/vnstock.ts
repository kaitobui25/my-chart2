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
const DEFAULT_POLL_MS = 5 * 60_000;
const WATCHLIST_ITEM_POLL_MS = 60_000;
const WATCHLIST_SWEEP_PAUSE_MS = 5 * 60_000;

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

export function isVietnamTradingSession(date: Date): boolean {
  const vietnam = new Date(date.getTime() + VNSTOCK_UTC_OFFSET_MINUTES * 60_000);
  const weekday = vietnam.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const minute = vietnam.getUTCHours() * 60 + vietnam.getUTCMinutes();
  return (minute >= 9 * 60 && minute <= 11 * 60 + 30)
    || (minute >= 13 * 60 && minute <= 15 * 60);
}

export class VnstockDatafeed implements Datafeed {
  readonly name = 'Vnstock';
  private readonly baseUrl: string;
  private readonly cache: BrowserHistoryCacheApi;
  private readonly fetchImpl: typeof fetch;
  private pollMs: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollInFlight = false;
  private watchlistTimer: ReturnType<typeof setTimeout> | null = null;
  private watchlistInFlight = false;
  private watchlistCursor = 0;
  private disposed = false;
  private readonly subscriptions = new Map<string, PollSubscription>();
  private readonly watchlistSubscriptions = new Map<string, PollSubscription>();

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
    const remove = this.addListener(this.subscriptions, symbol, interval, onCandle);
    this.schedulePoll();
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
      this.watchlistSubscriptions,
      symbol,
      interval,
      (candle) => onCandle(symbol, candle),
    ));
    this.scheduleWatchlistPoll();
    return () => removers.forEach((remove) => remove());
  }

  dispose(): void {
    this.disposed = true;
    this.subscriptions.clear();
    this.watchlistSubscriptions.clear();
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.watchlistTimer) clearTimeout(this.watchlistTimer);
    this.pollTimer = null;
    this.watchlistTimer = null;
  }

  private addListener(
    collection: Map<string, PollSubscription>,
    symbol: string,
    interval: string,
    listener: (candle: Candle) => void,
  ): () => void {
    const normalizedSymbol = symbol.trim().toUpperCase();
    const key = `${normalizedSymbol}\u0000${interval}`;
    let subscription = collection.get(key);
    if (!subscription) {
      subscription = { symbol: normalizedSymbol, interval, listeners: new Set() };
      collection.set(key, subscription);
    }
    subscription.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = collection.get(key);
      current?.listeners.delete(listener);
      if (current?.listeners.size === 0) collection.delete(key);
      if (collection === this.subscriptions && collection.size === 0 && this.pollTimer) {
        clearTimeout(this.pollTimer);
        this.pollTimer = null;
      }
      if (collection === this.watchlistSubscriptions && collection.size === 0 && this.watchlistTimer) {
        clearTimeout(this.watchlistTimer);
        this.watchlistTimer = null;
        this.watchlistCursor = 0;
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
    if (!isVietnamTradingSession(new Date())) return;
    this.pollInFlight = true;
    try {
      const byInterval = new Map<string, PollSubscription[]>();
      for (const subscription of this.subscriptions.values()) {
        const group = byInterval.get(subscription.interval) ?? [];
        group.push(subscription);
        byInterval.set(subscription.interval, group);
      }
      for (const [interval, subscriptions] of byInterval) {
        await this.fetchLatest(subscriptions, interval, this.subscriptions);
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  private scheduleWatchlistPoll(delay = WATCHLIST_ITEM_POLL_MS): void {
    if (this.disposed || this.watchlistSubscriptions.size === 0 || this.watchlistTimer) return;
    this.watchlistTimer = setTimeout(() => {
      this.watchlistTimer = null;
      void this.pollNextWatchlistSymbol().then((nextDelay) => this.scheduleWatchlistPoll(nextDelay));
    }, delay);
  }

  private async pollNextWatchlistSymbol(): Promise<number> {
    if (this.watchlistInFlight || this.disposed || this.watchlistSubscriptions.size === 0) {
      return WATCHLIST_ITEM_POLL_MS;
    }
    this.watchlistInFlight = true;
    try {
      const subscriptions = [...this.watchlistSubscriptions.values()];
      let selected: PollSubscription | undefined;
      let examined = 0;
      while (examined < subscriptions.length) {
        const candidate = subscriptions[this.watchlistCursor % subscriptions.length];
        this.watchlistCursor = (this.watchlistCursor + 1) % subscriptions.length;
        examined += 1;
        if (!this.subscriptions.has(`${candidate.symbol}\u0000${candidate.interval}`)) {
          selected = candidate;
          break;
        }
      }
      if (selected) {
        await this.fetchLatest([selected], selected.interval, this.watchlistSubscriptions);
      }
      return this.watchlistCursor === 0 ? WATCHLIST_SWEEP_PAUSE_MS : WATCHLIST_ITEM_POLL_MS;
    } finally {
      this.watchlistInFlight = false;
    }
  }

  private async fetchLatest(
    subscriptions: PollSubscription[],
    interval: string,
    collection: Map<string, PollSubscription>,
  ): Promise<void> {
    if (subscriptions.length === 0) return;
    const url = this.apiUrl('/latest');
    url.searchParams.set('symbols', subscriptions.map((item) => item.symbol).join(','));
    url.searchParams.set('interval', interval);
    try {
      const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
      const payload = await response.json().catch(() => ({})) as {
        candles?: Record<string, Candle>;
      };
      if (!response.ok) return;
      for (const subscription of subscriptions) {
        const rawCandle = this.validCandle(payload.candles?.[subscription.symbol]);
        const candle = rawCandle ? this.normalizePolledCandle(rawCandle, interval) : null;
        if (!candle) continue;
        await this.persistHistory(subscription.symbol, interval, [candle], this.returnedCoverage([candle], interval));
        const current = collection.get(`${subscription.symbol}\u0000${interval}`);
        if (!current) continue;
        for (const listener of current.listeners) listener(candle);
      }
    } catch {
      // Polling is best effort. Historical requests remain the recovery path.
    }
  }

  private normalizePolledCandle(candle: Candle, interval: string): Candle {
    if (interval !== '1d') return candle;
    // Vnstock daily OHLCV bars are stamped 07:00 Asia/Ho_Chi_Minh (00:00 UTC).
    // A realtime quote may carry the current clock time, so pin it to the same
    // trading-day key before merging it with cached/history candles.
    const shifted = new Date((candle.time + VNSTOCK_UTC_OFFSET_MINUTES * 60) * 1000);
    const time = Math.floor(Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
      0, 0, 0, 0,
    ) / 1000);
    return { ...candle, time };
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
