import type { Candle } from '../../src/core/types';
import type { Datafeed, HistoryRange, SymbolSearchResult } from '../../src/datafeed';
import { intervalApproxSeconds, intervalStart, isCalendarInterval, nextIntervalStart } from '../../src/interval';
import {
  BrowserHistoryCache,
  FIINQUANT_ADJUSTED_HISTORY_SOURCE,
  mergeHistoryCoverage,
  missingHistoryCoverage,
  type BrowserHistoryCacheApi,
} from './browser-history-cache';

export interface FiinQuantHealth {
  ok: boolean;
  configured: boolean;
  loggedIn: boolean;
  dependencies?: {
    fiinquantx: string | null;
    signalrcore: string | null;
    msgpack: string | null;
  };
  tokenConfigured?: boolean;
  authorized?: boolean;
  stream?: {
    browserClients: number;
    subscriptions: number;
    requestedSymbols: string[];
    upstreamActive: boolean;
    streamStartedAt: string | null;
    lastTickAt: string | null;
    lastMarketTickAt: string | null;
    lastTickSymbol: string | null;
    lastError: string | null;
  } | null;
}

export interface FiinQuantDatafeedOptions {
  cache?: BrowserHistoryCacheApi;
  fetchImpl?: typeof fetch;
}

const MAX_HISTORY_REQUEST = 50_000;
const MAX_LATEST_CALENDAR_HISTORY_REQUEST = 100;
const FIINQUANT_UTC_OFFSET_MINUTES = 420;
const LATEST_CACHE_REFRESH_MS = 120_000;
const CALENDAR_REFRESH_DAILY_BARS = 100;

function mergeCandles(...groups: Candle[][]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const group of groups) {
    for (const candle of group) byTime.set(candle.time, candle);
  }
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

function calendarSourceLimit(interval: string, limit: number): number {
  if (interval === '1w') return Math.min(MAX_HISTORY_REQUEST, Math.max(60, limit * 8 + 14));
  if (interval === '1M') return Math.min(MAX_HISTORY_REQUEST, Math.max(60, limit * 35 + 35));
  return limit;
}

function minimumCalendarPreview(interval: string, requestedLimit: number): number {
  const preferred = interval === '1M' ? 12 : 20;
  return Math.min(requestedLimit, preferred);
}

function aggregateCalendarCandles(candles: Candle[], interval: string): Candle[] {
  const result: Candle[] = [];
  for (const candle of candles) {
    const bucket = intervalStart(candle.time, interval, FIINQUANT_UTC_OFFSET_MINUTES);
    const previous = result[result.length - 1];
    if (!previous || previous.time !== bucket) {
      result.push({ ...candle, time: bucket });
      continue;
    }
    previous.high = Math.max(previous.high, candle.high);
    previous.low = Math.min(previous.low, candle.low);
    previous.close = candle.close;
    if (previous.volume !== undefined || candle.volume !== undefined) {
      previous.volume = Number(previous.volume ?? 0) + Number(candle.volume ?? 0);
    }
  }
  return result;
}

function completeCalendarTail(candles: Candle[], interval: string): Candle[] {
  const aggregated = aggregateCalendarCandles(candles, interval);
  // A small latest-daily refresh may start in the middle of a week/month. Never
  // overwrite a previously complete cached bucket with that leading partial bar.
  return aggregated.length > 1 ? aggregated.slice(1) : [];
}

function formatHistoryDate(time: number): string {
  return new Date(time * 1000).toISOString().slice(0, 10);
}

/**
 * FiinQuant reference datafeed backed by the local Python sidecar example.
 * Historical candles are persisted in the shared browser cache so features
 * such as Replay can reuse already downloaded history without forcing an old
 * from_date request back through the provider.
 */
export class FiinQuantDatafeed implements Datafeed {
  readonly name = 'FiinQuant';
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly cache: BrowserHistoryCacheApi;
  private readonly fetchImpl: typeof fetch;
  private readonly streamSubscriptions = new Map<string, {
    symbol: string;
    interval: string;
    listeners: Set<(candle: Candle) => void>;
  }>();
  private readonly latestRefreshes = new Set<string>();
  private readonly latestRefreshAttemptAt = new Map<string, number>();
  private readonly calendarWarmups = new Set<string>();
  private streamSocket: WebSocket | null = null;
  private streamAuthenticated = false;
  private streamRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly realtimeConnectedListeners = new Set<() => void>();
  private disposed = false;

  constructor(baseUrl = '/fiinquant-api', token = '', options: FiinQuantDatafeedOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.cache = options.cache ?? new BrowserHistoryCache();
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  get cacheAvailable(): boolean {
    return this.cache.available;
  }

  async clearCache(): Promise<void> {
    await this.cache.clearSource(FIINQUANT_ADJUSTED_HISTORY_SOURCE);
  }

  private sidecarHeaders(extra: Record<string, string> = {}): HeadersInit {
    const headers: Record<string, string> = { ...extra };
    if (this.token) headers['X-L2Chart-Sidecar-Token'] = this.token;
    return headers;
  }

  private apiUrl(path: string): URL {
    const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
    return new URL(`${this.baseUrl}${path}`, origin);
  }

  async health(): Promise<FiinQuantHealth> {
    const res = await this.fetchImpl(`${this.baseUrl}/health`, {
      headers: this.sidecarHeaders(),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`sidecar HTTP ${res.status}`);
    return res.json();
  }

  async login(username: string, password: string): Promise<{ ok: boolean; loggedIn: boolean }> {
    const url = this.apiUrl('/session');
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.sidecarHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error(`Cannot reach the FiinQuant sidecar at ${this.baseUrl}. Start the reference sidecar in examples/sidecars/fiinquant.`);
    }
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(String((payload as { message?: string }).message ?? `HTTP ${res.status}`));
    }
    const session = payload as { ok: boolean; loggedIn: boolean };
    if (session.loggedIn) this.ensureStreamSocket();
    return session;
  }

  async getHistory(symbol: string, interval: string, limit = 500, range?: HistoryRange): Promise<Candle[]> {
    const normalizedSymbol = symbol.trim().toUpperCase();
    if (!normalizedSymbol) return [];
    const requestedLimit = Math.min(MAX_HISTORY_REQUEST, Math.max(1, Math.floor(limit)));

    if (!range) {
      const cached = await this.cache.readLatest(
        FIINQUANT_ADJUSTED_HISTORY_SOURCE,
        normalizedSymbol,
        interval,
        requestedLimit,
      );

      if ((interval === '1d' || isCalendarInterval(interval)) && cached.length > 0) {
        if (isCalendarInterval(interval)) {
          const targetLimit = Math.min(requestedLimit, MAX_LATEST_CALENDAR_HISTORY_REQUEST);
          if (cached.length < targetLimit) {
            this.scheduleCalendarWarmup(normalizedSymbol, interval, targetLimit);
          } else {
            this.scheduleLatestRefresh(normalizedSymbol, interval, requestedLimit);
          }
        } else {
          this.scheduleLatestRefresh(normalizedSymbol, interval, requestedLimit);
        }
        return cached.slice(-requestedLimit);
      }

      if (isCalendarInterval(interval)) {
        const derived = await this.calendarHistoryFromDailyCache(
          normalizedSymbol,
          interval,
          requestedLimit,
        );
        if (derived.length >= minimumCalendarPreview(interval, requestedLimit)) {
          void this.cache.write(
            FIINQUANT_ADJUSTED_HISTORY_SOURCE,
            normalizedSymbol,
            interval,
            derived,
          );
          const targetLimit = Math.min(requestedLimit, MAX_LATEST_CALENDAR_HISTORY_REQUEST);
          if (derived.length < targetLimit) {
            this.scheduleCalendarWarmup(normalizedSymbol, interval, targetLimit);
          } else {
            this.scheduleLatestRefresh(normalizedSymbol, interval, requestedLimit);
          }
          return derived.slice(-requestedLimit);
        }
      }

      try {
        const remote = await this.fetchAndPersistLatest(normalizedSymbol, interval, requestedLimit);
        this.latestRefreshAttemptAt.set(this.latestRefreshKey(normalizedSymbol, interval), Date.now());
        return mergeCandles(cached, remote).slice(-requestedLimit);
      } catch (error) {
        if (cached.length > 0) return cached;
        throw error;
      }
    }

    const requested = this.normalizeRange(range, interval);
    if (requested.from > requested.to) return [];
    const cached = await this.cache.readRange(
      FIINQUANT_ADJUSTED_HISTORY_SOURCE,
      normalizedSymbol,
      interval,
      requested.from,
      requested.to,
      requestedLimit,
    );
    const coverage = await this.cache.coverage(
      FIINQUANT_ADJUSTED_HISTORY_SOURCE,
      normalizedSymbol,
      interval,
    );
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
      FIINQUANT_ADJUSTED_HISTORY_SOURCE,
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

  async searchSymbols(query: string, limit = 20): Promise<SymbolSearchResult[]> {
    const url = this.apiUrl('/symbols');
    url.searchParams.set('q', query.trim().toUpperCase());
    url.searchParams.set('limit', String(Math.min(100, Math.max(1, limit))));
    const res = await this.fetchImpl(url, {
      headers: this.sidecarHeaders(),
      signal: AbortSignal.timeout(6000),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(String((payload as { message?: string }).message ?? `HTTP ${res.status}`));
    }
    return ((payload as { symbols?: SymbolSearchResult[] }).symbols ?? [])
      .filter((item) => typeof item.symbol === 'string' && item.symbol.trim())
      .map((item) => ({
        symbol: item.symbol.trim().toUpperCase(),
        name: item.name?.trim(),
        exchange: item.exchange?.trim(),
      }));
  }

  subscribe(symbol: string, interval: string, onCandle: (c: Candle) => void): () => void {
    if (this.disposed) return () => undefined;
    const remove = this.addStreamListener(symbol, interval, onCandle);
    this.ensureStreamSocket();
    this.sendStreamSubscriptions();

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      remove();
      this.sendStreamSubscriptions();
    };
  }

  subscribeMany(
    symbols: string[],
    interval: string,
    onCandle: (symbol: string, candle: Candle) => void,
  ): () => void {
    if (this.disposed) return () => undefined;
    const normalizedSymbols = [...new Set(
      symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean),
    )];
    const removers = normalizedSymbols.map((symbol) => this.addStreamListener(
      symbol,
      interval,
      (candle) => onCandle(symbol, candle),
    ));
    this.ensureStreamSocket();
    this.sendStreamSubscriptions();

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      for (const remove of removers) remove();
      this.sendStreamSubscriptions();
    };
  }

  dispose(): void {
    this.disposed = true;
    this.streamSubscriptions.clear();
    this.realtimeConnectedListeners.clear();
    this.latestRefreshes.clear();
    this.latestRefreshAttemptAt.clear();
    this.calendarWarmups.clear();
    if (this.streamRetryTimer) clearTimeout(this.streamRetryTimer);
    this.streamRetryTimer = null;
    this.streamSocket?.close();
    this.streamSocket = null;
    this.streamAuthenticated = false;
  }

  onRealtimeConnected(listener: () => void): () => void {
    this.realtimeConnectedListeners.add(listener);
    return () => this.realtimeConnectedListeners.delete(listener);
  }

  private latestRefreshKey(symbol: string, interval: string): string {
    return interval === '1d' || isCalendarInterval(interval)
      ? `${symbol}\u0000daily-family`
      : `${symbol}\u0000${interval}`;
  }

  private scheduleLatestRefresh(symbol: string, interval: string, requestedLimit: number): void {
    const key = this.latestRefreshKey(symbol, interval);
    const now = Date.now();
    if (this.latestRefreshes.has(key)) return;
    if (now - (this.latestRefreshAttemptAt.get(key) ?? 0) < LATEST_CACHE_REFRESH_MS) return;
    this.latestRefreshAttemptAt.set(key, now);
    this.latestRefreshes.add(key);

    void this.refreshCachedLatest(symbol, interval, requestedLimit)
      .catch(() => undefined)
      .finally(() => this.latestRefreshes.delete(key));
  }

  private scheduleCalendarWarmup(symbol: string, interval: string, targetLimit: number): void {
    const key = `${symbol}\u0000warm:${interval}`;
    const now = Date.now();
    if (this.calendarWarmups.has(key)) return;
    if (now - (this.latestRefreshAttemptAt.get(key) ?? 0) < LATEST_CACHE_REFRESH_MS) return;
    this.latestRefreshAttemptAt.set(key, now);
    this.calendarWarmups.add(key);
    void this.fetchCalendarFromDailySource(symbol, interval, targetLimit)
      .catch(() => undefined)
      .finally(() => this.calendarWarmups.delete(key));
  }

  private async refreshCachedLatest(symbol: string, interval: string, requestedLimit: number): Promise<void> {
    if (interval === '1d' || isCalendarInterval(interval)) {
      const daily = await this.fetchHistory(
        symbol,
        '1d',
        Math.min(CALENDAR_REFRESH_DAILY_BARS, Math.max(1, requestedLimit)),
      );
      await this.persistHistory(symbol, '1d', daily, this.returnedCoverage(daily, '1d'));
      for (const calendarInterval of ['1w', '1M']) {
        const derived = completeCalendarTail(daily, calendarInterval);
        await this.cache.write(
          FIINQUANT_ADJUSTED_HISTORY_SOURCE,
          symbol,
          calendarInterval,
          derived,
        );
      }
      return;
    }

    const remote = await this.fetchHistory(symbol, interval, requestedLimit);
    await this.persistHistory(symbol, interval, remote, this.returnedCoverage(remote, interval));
  }

  private async fetchAndPersistLatest(
    symbol: string,
    interval: string,
    requestedLimit: number,
  ): Promise<Candle[]> {
    if (isCalendarInterval(interval)) {
      const targetLimit = Math.min(requestedLimit, MAX_LATEST_CALENDAR_HISTORY_REQUEST);
      return this.fetchCalendarFromDailySource(symbol, interval, targetLimit);
    }

    // Large single-organization daily requests regularly time out at FiinGroup's
    // gateway. Keep the first visible load small; deeper daily history is reused
    // when Replay or a calendar warm-up has already populated it.
    const remoteLimit = interval === '1d'
      ? Math.min(requestedLimit, MAX_LATEST_CALENDAR_HISTORY_REQUEST)
      : requestedLimit;
    const remote = await this.fetchHistory(symbol, interval, remoteLimit);
    await this.persistHistory(symbol, interval, remote, this.returnedCoverage(remote, interval));
    return remote;
  }

  private async fetchCalendarFromDailySource(
    symbol: string,
    interval: string,
    targetLimit: number,
  ): Promise<Candle[]> {
    const sourceLimit = calendarSourceLimit(interval, targetLimit);
    const daily = await this.fetchHistory(symbol, '1d', sourceLimit);
    await this.persistHistory(symbol, '1d', daily, this.returnedCoverage(daily, '1d'));
    const calendar = aggregateCalendarCandles(daily, interval).slice(-targetLimit);
    await this.persistHistory(symbol, interval, calendar, this.returnedCoverage(calendar, interval));
    return calendar;
  }

  private async calendarHistoryFromDailyCache(
    symbol: string,
    interval: string,
    requestedLimit: number,
  ): Promise<Candle[]> {
    const targetLimit = Math.min(requestedLimit, MAX_LATEST_CALENDAR_HISTORY_REQUEST);
    const daily = await this.cache.readLatest(
      FIINQUANT_ADJUSTED_HISTORY_SOURCE,
      symbol,
      '1d',
      calendarSourceLimit(interval, targetLimit),
    );
    return completeCalendarTail(daily, interval).slice(-targetLimit);
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
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: this.sidecarHeaders(),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new Error('FiinQuant history request timed out while waiting for the upstream provider. Try again.');
      }
      throw new Error(`Cannot reach the FiinQuant sidecar at ${this.baseUrl}. Start the reference sidecar in examples/sidecars/fiinquant.`);
    }
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(String((payload as { message?: string }).message ?? `HTTP ${res.status}`));
    }
    return ((payload as { candles?: Candle[] }).candles ?? [])
      .map((candle) => this.validCandle(candle))
      .filter((candle): candle is Candle => candle !== null)
      .filter((candle) => !range || (candle.time >= range.from && candle.time <= range.to));
  }

  private normalizeRange(range: HistoryRange, interval: string): HistoryRange {
    const from = Math.min(range.from, range.to);
    const to = Math.max(range.from, range.to);
    if (!isCalendarInterval(interval)) return { from, to };
    return {
      from: intervalStart(from, interval, FIINQUANT_UTC_OFFSET_MINUTES),
      to: Math.min(
        Math.floor(Date.now() / 1000),
        nextIntervalStart(to, interval, FIINQUANT_UTC_OFFSET_MINUTES) - 1,
      ),
    };
  }

  private returnedCoverage(candles: Candle[], interval: string): HistoryRange | null {
    if (candles.length === 0) return null;
    const first = Math.min(...candles.map((candle) => candle.time));
    const last = Math.max(...candles.map((candle) => candle.time));
    const to = isCalendarInterval(interval)
      ? nextIntervalStart(last, interval, FIINQUANT_UTC_OFFSET_MINUTES)
      : last + Math.max(1, intervalApproxSeconds(interval));
    return { from: first, to };
  }

  private async persistHistory(
    symbol: string,
    interval: string,
    candles: Candle[],
    coverage: HistoryRange | null,
  ): Promise<void> {
    await this.cache.write(FIINQUANT_ADJUSTED_HISTORY_SOURCE, symbol, interval, candles);
    if (coverage) {
      await this.cache.markCoverage(FIINQUANT_ADJUSTED_HISTORY_SOURCE, symbol, interval, coverage);
    }
  }

  private partialHistoryError(
    coverage: HistoryRange[],
    gap: HistoryRange,
    cause: unknown,
  ): Error {
    const known = mergeHistoryCoverage(coverage);
    const local = known.length === 0
      ? 'Local cache has no confirmed coverage.'
      : `Local cache coverage is ${formatHistoryDate(known[0].from)} to ${formatHistoryDate(known[known.length - 1].to)}.`;
    const reason = cause instanceof Error ? cause.message : String(cause);
    return new Error(
      `${local} FiinQuant could not backfill ${formatHistoryDate(gap.from)} to ${formatHistoryDate(gap.to)}: ${reason}`,
    );
  }

  private ensureStreamSocket(): void {
    if (this.disposed || this.streamSubscriptions.size === 0) return;
    if (this.streamSocket?.readyState === WebSocket.OPEN
      || this.streamSocket?.readyState === WebSocket.CONNECTING) return;

    const wsUrl = this.apiUrl('/stream');
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';

    const socket = new WebSocket(wsUrl.toString());
    this.streamSocket = socket;
    this.streamAuthenticated = false;
    socket.onopen = () => {
      socket.send(JSON.stringify({ action: 'authenticate', token: this.token }));
    };
    socket.onmessage = (event) => this.handleStreamMessage(socket, event);
    socket.onerror = () => socket.close();
    socket.onclose = (event) => {
      if (this.streamSocket !== socket) return;
      this.streamSocket = null;
      this.streamAuthenticated = false;
      // Authentication/configuration failures require an explicit login or
      // settings change. Retrying here would only create a browser-side loop.
      if (event.code === 4401 || event.code === 4403) return;
      if (!this.disposed && this.streamSubscriptions.size > 0) {
        this.streamRetryTimer = setTimeout(() => {
          this.streamRetryTimer = null;
          this.ensureStreamSocket();
        }, 2000);
      }
    };
  }

  private addStreamListener(
    symbol: string,
    interval: string,
    listener: (candle: Candle) => void,
  ): () => void {
    const normalizedSymbol = symbol.trim().toUpperCase();
    const key = `${normalizedSymbol}\u0000${interval}`;
    let subscription = this.streamSubscriptions.get(key);
    if (!subscription) {
      subscription = { symbol: normalizedSymbol, interval, listeners: new Set() };
      this.streamSubscriptions.set(key, subscription);
    }
    subscription.listeners.add(listener);
    return () => {
      const current = this.streamSubscriptions.get(key);
      current?.listeners.delete(listener);
      if (current?.listeners.size === 0) this.streamSubscriptions.delete(key);
    };
  }

  private sendStreamSubscriptions(): void {
    const socket = this.streamSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.streamAuthenticated) return;
    socket.send(JSON.stringify({
      action: 'subscribe',
      subscriptions: [...this.streamSubscriptions.values()].map(({ symbol, interval }) => ({
        symbol,
        interval,
      })),
    }));
  }

  private handleStreamMessage(socket: WebSocket, event: MessageEvent): void {
    try {
      const msg = JSON.parse(String(event.data));
      if (msg.type === 'authenticated') {
        if (this.streamSocket !== socket || this.streamAuthenticated) return;
        this.streamAuthenticated = true;
        this.sendStreamSubscriptions();
        for (const listener of this.realtimeConnectedListeners) listener();
        return;
      }
      if (!this.streamAuthenticated) return;
      if (msg.type !== 'bar' || !msg.candle) return;
      let subscription = this.streamSubscriptions.get(
        `${String(msg.symbol ?? '').toUpperCase()}\u0000${String(msg.interval ?? '')}`,
      );
      // Compatibility with sidecars that predate multiplex stream messages.
      if (!subscription && this.streamSubscriptions.size === 1) {
        subscription = this.streamSubscriptions.values().next().value;
      }
      if (!subscription) return;
      const candle = this.validCandle(msg.candle);
      if (!candle) return;
      void this.cache.write(
        FIINQUANT_ADJUSTED_HISTORY_SOURCE,
        subscription.symbol,
        subscription.interval,
        [candle],
      );
      if (subscription.interval === '1d' || isCalendarInterval(subscription.interval)) {
        this.latestRefreshAttemptAt.set(
          this.latestRefreshKey(subscription.symbol, subscription.interval),
          Date.now(),
        );
      }
      for (const listener of subscription.listeners) listener(candle);
    } catch {
      /* Ignore malformed sidecar frames. */
    }
  }

  private validCandle(value: unknown): Candle | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Partial<Candle>;
    const time = Number(raw.time);
    const open = Number(raw.open);
    const high = Number(raw.high);
    const low = Number(raw.low);
    const close = Number(raw.close);
    const volume = raw.volume === undefined ? undefined : Number(raw.volume);
    if (
      !Number.isFinite(time) || time <= 0 ||
      !Number.isFinite(open) || open <= 0 ||
      !Number.isFinite(high) || high <= 0 ||
      !Number.isFinite(low) || low <= 0 ||
      !Number.isFinite(close) || close <= 0 ||
      high < Math.max(open, close, low) ||
      low > Math.min(open, close, high) ||
      (volume !== undefined && (!Number.isFinite(volume) || volume < 0))
    ) return null;
    return { time, open, high, low, close, volume };
  }
}
