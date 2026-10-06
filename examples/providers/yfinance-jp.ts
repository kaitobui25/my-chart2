import type { Candle } from '../../src/core/types';
import type { Datafeed, HistoryRange, SymbolSearchResult } from '../../src/datafeed';
import {
  estimateIntervalBars,
  intervalApproxSeconds,
  isCalendarInterval,
  nextIntervalStart,
} from '../../src/interval';
import {
  BrowserHistoryCache,
  mergeHistoryCoverage,
  missingHistoryCoverage,
  type BrowserHistoryCacheApi,
} from './browser-history-cache';

export const YFINANCE_JP_SUPPORTED_INTERVALS = [
  '1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M',
] as const;

export const YFINANCE_JP_DEFAULT_SYMBOLS: string[] = ['7203.T', '6758.T', '9984.T', '8306.T'];
export const YFINANCE_JP_HISTORY_SOURCE = 'yfinance-jp:ohlcv:v1';

const SUPPORTED_INTERVALS = new Set<string>(YFINANCE_JP_SUPPORTED_INTERVALS);
const TOKYO_UTC_OFFSET_MINUTES = 9 * 60;
const MAX_HISTORY_REQUEST = 50_000;
const DEFAULT_POLL_MS = 60_000;
const JP_CODE_PATTERN = /^(?:\d{4}|\d{3}[ACDFGHJKLMNPRSTUWXY]|\d[ACDFGHJKLMNPRSTUWXY]\d{2})$/;
const LIVE_RECOVERY_LOOKBACK_SECONDS: Record<string, number> = {
  '1m': 5 * 86_400,
  '5m': 30 * 86_400,
  '15m': 30 * 86_400,
  '30m': 30 * 86_400,
  '1h': 30 * 86_400,
  '4h': 30 * 86_400,
};

export interface YFinanceJapanHealth {
  ok: boolean;
  configured?: boolean;
  provider?: string;
  source?: string;
  exchange?: string;
  timezone?: string;
  pollIntervalSeconds?: number;
  supportedIntervals?: string[];
  adjustedDefault?: boolean;
  session?: Record<string, unknown>;
  warning?: string;
  error?: string;
}

export interface YFinanceJapanDatafeedOptions {
  cache?: BrowserHistoryCacheApi;
  fetchImpl?: typeof fetch;
  pollMs?: number;
}

interface PollSubscription {
  symbol: string;
  interval: string;
  listeners: Set<(candle: Candle) => void>;
  lastTime?: number;
}

interface HistoryPayload {
  candles?: unknown[];
  message?: string;
  error?: string;
}

interface MultiHistoryPayload {
  candles?: Record<string, unknown>;
  message?: string;
  error?: string;
}

export function normalizeYFinanceJapanSymbol(value: string): string {
  const upper = value.trim().toUpperCase();
  const base = upper.endsWith('.T') ? upper.slice(0, -2) : upper;
  return JP_CODE_PATTERN.test(base) ? `${base}.T` : '';
}

function parseCandle(value: unknown): Candle | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<Candle>;
  const time = Number(row.time);
  const open = Number(row.open);
  const high = Number(row.high);
  const low = Number(row.low);
  const close = Number(row.close);
  const volume = row.volume === undefined || row.volume === null ? undefined : Number(row.volume);
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
  return { time: Math.trunc(time), open, high, low, close, ...(volume === undefined ? {} : { volume }) };
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

/** Yahoo Finance Japan equities via the local yfinance sidecar. */
export class YFinanceJapanDatafeed implements Datafeed {
  readonly name = 'Yahoo Japan';

  private readonly baseUrl: string;
  private readonly cache: BrowserHistoryCacheApi;
  private readonly fetchImpl: typeof fetch;
  private readonly pollMs: number;
  private readonly subscriptions = new Map<string, PollSubscription>();
  private readonly latestTimes = new Map<string, number>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollInFlight = false;
  private disposed = false;

  constructor(baseUrl = '/yfinance-jp-api', options: YFinanceJapanDatafeedOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.cache = options.cache ?? new BrowserHistoryCache();
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.pollMs = Math.max(1_000, options.pollMs ?? DEFAULT_POLL_MS);
  }

  get cacheAvailable(): boolean {
    return this.cache.available;
  }

  async clearCache(): Promise<void> {
    await this.cache.clearSource(YFINANCE_JP_HISTORY_SOURCE);
    this.latestTimes.clear();
  }

  async health(): Promise<YFinanceJapanHealth> {
    const response = await this.fetchImpl(`${this.baseUrl}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    const payload = await response.json().catch(() => ({})) as YFinanceJapanHealth;
    if (!response.ok) {
      throw new Error(payload.error || `Yahoo Japan sidecar HTTP ${response.status}`);
    }
    return payload;
  }

  async searchSymbols(query: string, limit = 20): Promise<SymbolSearchResult[]> {
    const url = this.apiUrl('/symbols');
    url.searchParams.set('q', query.trim());
    url.searchParams.set('limit', String(Math.min(100, Math.max(1, Math.floor(limit)))));
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(8_000) });
    const payload = await response.json().catch(() => ({})) as {
      symbols?: unknown[];
      message?: string;
    };
    if (!response.ok) throw new Error(payload.message ?? `Yahoo Japan sidecar HTTP ${response.status}`);
    return (payload.symbols ?? []).flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const row = value as Record<string, unknown>;
      const symbol = normalizeYFinanceJapanSymbol(String(row.symbol ?? ''));
      if (!symbol) return [];
      return [{
        symbol,
        name: typeof row.name === 'string' ? row.name.trim() : undefined,
        exchange: typeof row.exchange === 'string' ? row.exchange.trim() : 'JPX',
      } satisfies SymbolSearchResult];
    });
  }

  /**
   * Fetch a small daily history window for multiple Tokyo symbols in one sidecar
   * request. This is intentionally provider-specific and is used by compact
   * background surfaces such as the Excel watch list.
   */
  async getDailyHistoryMany(symbols: readonly string[], limit = 2): Promise<Record<string, Candle[]>> {
    const normalized = [...new Set(symbols
      .map((symbol) => normalizeYFinanceJapanSymbol(symbol))
      .filter((symbol): symbol is string => Boolean(symbol)))];
    if (normalized.length === 0) return {};

    const response = await this.fetchImpl(`${this.baseUrl}/scanner/history`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        symbols: normalized,
        limit: Math.min(10, Math.max(1, Math.floor(limit))),
      }),
      signal: AbortSignal.timeout(25_000),
    });
    const payload = await response.json().catch(() => ({})) as MultiHistoryPayload;
    if (!response.ok) {
      throw new Error(payload.message ?? payload.error ?? `Yahoo Japan sidecar HTTP ${response.status}`);
    }

    const output: Record<string, Candle[]> = {};
    for (const symbol of normalized) {
      const rows = payload.candles?.[symbol];
      if (!Array.isArray(rows)) continue;
      output[symbol] = rows
        .map(parseCandle)
        .filter((candle): candle is Candle => candle !== null)
        .sort((left, right) => left.time - right.time);
    }
    return output;
  }

  async getCachedHistory(
    symbol: string,
    interval: string,
    limit = 500,
    range?: HistoryRange,
  ): Promise<Candle[]> {
    const normalizedSymbol = normalizeYFinanceJapanSymbol(symbol);
    if (!normalizedSymbol) return [];
    this.requireInterval(interval);
    const requestedLimit = this.normalizeLimit(limit);
    if (!range) {
      return this.cache.readLatest(
        YFINANCE_JP_HISTORY_SOURCE,
        normalizedSymbol,
        interval,
        requestedLimit,
      );
    }
    const requested = this.normalizeRange(range);
    return this.cache.readRange(
      YFINANCE_JP_HISTORY_SOURCE,
      normalizedSymbol,
      interval,
      requested.from,
      requested.to,
      requestedLimit,
    );
  }

  async getHistory(
    symbol: string,
    interval: string,
    limit = 500,
    range?: HistoryRange,
  ): Promise<Candle[]> {
    const normalizedSymbol = normalizeYFinanceJapanSymbol(symbol);
    if (!normalizedSymbol) return [];
    this.requireInterval(interval);
    const requestedLimit = this.normalizeLimit(limit);

    if (!range) {
      const cached = await this.cache.readLatest(
        YFINANCE_JP_HISTORY_SOURCE,
        normalizedSymbol,
        interval,
        requestedLimit,
      );
      try {
        const remote = await this.fetchHistory(normalizedSymbol, interval, requestedLimit);
        await this.persistHistory(normalizedSymbol, interval, remote);
        return mergeCandles(cached, remote).slice(-requestedLimit);
      } catch (error) {
        if (cached.length > 0) return cached;
        throw error;
      }
    }

    const requested = this.normalizeRange(range);
    const cached = await this.cache.readRange(
      YFINANCE_JP_HISTORY_SOURCE,
      normalizedSymbol,
      interval,
      requested.from,
      requested.to,
      requestedLimit,
    );
    const coverage = await this.cache.coverage(YFINANCE_JP_HISTORY_SOURCE, normalizedSymbol, interval);
    const missing = missingHistoryCoverage(coverage, requested);
    if (missing.length === 0) return cached.slice(-requestedLimit);

    let fetched: Candle[] = [];
    for (const gap of missing) {
      try {
        const remote = await this.fetchHistory(normalizedSymbol, interval, requestedLimit, gap);
        fetched = mergeCandles(fetched, remote);
        await this.persistHistory(normalizedSymbol, interval, remote);
      } catch (error) {
        if (cached.length > 0 || fetched.length > 0) {
          throw this.partialHistoryError(coverage, gap, error);
        }
        throw error;
      }
    }

    const complete = await this.cache.readRange(
      YFINANCE_JP_HISTORY_SOURCE,
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
    const normalizedSymbol = normalizeYFinanceJapanSymbol(symbol);
    if (!normalizedSymbol) return () => undefined;
    this.requireInterval(interval);
    const key = `${normalizedSymbol}\u0000${interval}`;
    let subscription = this.subscriptions.get(key);
    if (!subscription) {
      subscription = { symbol: normalizedSymbol, interval, listeners: new Set() };
      const lastTime = this.latestTimes.get(key);
      if (lastTime !== undefined) subscription.lastTime = lastTime;
      this.subscriptions.set(key, subscription);
    }
    subscription.listeners.add(onCandle);
    this.schedulePoll();

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.subscriptions.get(key);
      current?.listeners.delete(onCandle);
      if (current?.listeners.size === 0) this.subscriptions.delete(key);
      if (this.subscriptions.size === 0 && this.pollTimer) {
        clearTimeout(this.pollTimer);
        this.pollTimer = null;
      }
    };
  }

  dispose(): void {
    this.disposed = true;
    this.subscriptions.clear();
    this.latestTimes.clear();
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
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
        await this.pollSubscriptions(interval, subscriptions);
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  private async pollSubscriptions(interval: string, subscriptions: PollSubscription[]): Promise<void> {
    if (subscriptions.length === 0) return;
    try {
      const url = this.apiUrl('/latest');
      url.searchParams.set('symbols', subscriptions.map((item) => item.symbol).join(','));
      url.searchParams.set('interval', interval);
      const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) return;
      const payload = await response.json().catch(() => ({})) as {
        candles?: Record<string, unknown>;
      };
      for (const subscription of subscriptions) {
        const candle = parseCandle(payload.candles?.[subscription.symbol]);
        if (!candle) continue;
        try {
          const candles = await this.liveCandles(subscription, candle);
          if (candles.length === 0) continue;
          await this.persistHistory(subscription.symbol, interval, candles);
          const current = this.subscriptions.get(`${subscription.symbol}\u0000${interval}`);
          if (!current) continue;
          for (const next of candles) {
            for (const listener of current.listeners) listener(next);
            current.lastTime = Math.max(current.lastTime ?? next.time, next.time);
          }
        } catch {
          // Keep the previous live cursor so a later poll can retry the gap.
        }
      }
    } catch {
      // Realtime polling is best effort; the next history load remains the recovery path.
    }
  }

  private async liveCandles(subscription: PollSubscription, latest: Candle): Promise<Candle[]> {
    let lastTime = subscription.lastTime;
    if (lastTime === undefined) {
      lastTime = this.latestTimes.get(`${subscription.symbol}\u0000${subscription.interval}`);
    }
    if (lastTime === undefined) {
      const cached = await this.cache.readLatest(
        YFINANCE_JP_HISTORY_SOURCE,
        subscription.symbol,
        subscription.interval,
        1,
      );
      lastTime = cached[cached.length - 1]?.time;
      subscription.lastTime = lastTime;
    }

    if (lastTime === undefined) return [latest];
    if (latest.time < lastTime) return [];
    if (latest.time === lastTime) return [latest];

    const expectedNext = nextIntervalStart(lastTime, subscription.interval, TOKYO_UTC_OFFSET_MINUTES);
    if (latest.time <= expectedNext) return [latest];

    const recoveryWindow = LIVE_RECOVERY_LOOKBACK_SECONDS[subscription.interval];
    const recoveryFrom = recoveryWindow === undefined
      ? lastTime
      : Math.max(lastTime, latest.time - recoveryWindow);
    const limit = this.normalizeLimit(estimateIntervalBars(recoveryFrom, latest.time, subscription.interval));
    const recovered = await this.fetchHistory(
      subscription.symbol,
      subscription.interval,
      limit,
      { from: recoveryFrom, to: latest.time },
    );
    return mergeCandles(recovered, [latest]).filter((candle) => candle.time > lastTime);
  }

  private async fetchHistory(
    symbol: string,
    interval: string,
    limit: number,
    range?: HistoryRange,
  ): Promise<Candle[]> {
    const url = this.apiUrl('/history');
    url.searchParams.set('symbol', symbol);
    // Keep chart interval codes intact. The sidecar maps 1w -> 1wk and 1M -> 1mo for yfinance.
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
      throw new Error(`Cannot reach the Yahoo Japan sidecar at ${this.baseUrl}`);
    }
    const payload = await response.json().catch(() => ({})) as HistoryPayload;
    if (!response.ok) {
      throw new Error(payload.message ?? payload.error ?? `Yahoo Japan sidecar HTTP ${response.status}`);
    }
    return (payload.candles ?? [])
      .map(parseCandle)
      .filter((candle): candle is Candle => candle !== null)
      .filter((candle) => !range || (candle.time >= range.from && candle.time <= range.to))
      .sort((left, right) => left.time - right.time);
  }

  private async persistHistory(symbol: string, interval: string, candles: Candle[]): Promise<void> {
    if (candles.length === 0) return;
    const first = candles[0].time;
    const last = candles[candles.length - 1].time;
    await this.cache.write(YFINANCE_JP_HISTORY_SOURCE, symbol, interval, candles);
    const to = isCalendarInterval(interval)
      ? nextIntervalStart(last, interval, TOKYO_UTC_OFFSET_MINUTES)
      : last + Math.max(1, intervalApproxSeconds(interval));
    await this.cache.markCoverage(YFINANCE_JP_HISTORY_SOURCE, symbol, interval, { from: first, to });
    const key = `${symbol}\u0000${interval}`;
    this.latestTimes.set(key, Math.max(this.latestTimes.get(key) ?? last, last));
  }

  private normalizeRange(range: HistoryRange): HistoryRange {
    const from = Math.floor(Math.min(range.from, range.to));
    const to = Math.floor(Math.max(range.from, range.to));
    return { from, to };
  }

  private normalizeLimit(limit: number): number {
    return Math.min(MAX_HISTORY_REQUEST, Math.max(1, Math.floor(limit)));
  }

  private requireInterval(interval: string): void {
    if (!SUPPORTED_INTERVALS.has(interval)) {
      throw new Error(`UNSUPPORTED_INTERVAL: Yahoo Japan does not support chart interval ${interval}`);
    }
  }

  private apiUrl(path: string): URL {
    const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
    return new URL(`${this.baseUrl}${path}`, origin);
  }

  private partialHistoryError(coverage: HistoryRange[], gap: HistoryRange, cause: unknown): Error {
    const known = mergeHistoryCoverage(coverage);
    const local = known.length === 0
      ? 'Local cache has no confirmed coverage.'
      : `Local cache coverage is ${formatHistoryDate(known[0].from)} to ${formatHistoryDate(known[known.length - 1].to)}.`;
    const reason = cause instanceof Error ? cause.message : String(cause);
    return new Error(`${local} Yahoo Japan could not backfill ${formatHistoryDate(gap.from)} to ${formatHistoryDate(gap.to)}: ${reason}`);
  }
}
