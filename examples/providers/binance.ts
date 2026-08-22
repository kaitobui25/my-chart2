import type { Candle } from '../../src/core/types';
import {
  INTERVAL_SECONDS,
  type Datafeed,
  type HistoryRange,
  type QuoteUpdate,
  type SymbolSearchResult,
} from '../../src/datafeed';
import { intervalApproxSeconds, isCalendarInterval, nextIntervalStart } from '../../src/interval';
import {
  BinanceHistoryCache,
  type BinanceMarket,
} from './binance-cache';

export type { BinanceMarket } from './binance-cache';

interface BinanceEndpoints {
  restBase: string;
  websocketBase: string;
  combinedWebsocketBase: string;
  timePath: string;
  klinesPath: string;
  exchangeInfoPath: string;
}

export interface BinanceDatafeedOptions {
  market?: BinanceMarket;
  restBase?: string;
  websocketBase?: string;
  combinedWebsocketBase?: string;
  cache?: BinanceHistoryCache;
  fetchImpl?: typeof fetch;
  websocketFactory?: (url: string) => WebSocket;
  requestTimeoutMs?: number;
  cacheReadTimeoutMs?: number;
  refreshCoordinator?: BinanceIdleRefreshCoordinator;
}

interface BinanceKlinePayload {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  x?: boolean;
}

interface BinanceExchangeSymbol {
  symbol?: string;
  status?: string;
  baseAsset?: string;
  quoteAsset?: string;
  contractType?: string;
  isSpotTradingAllowed?: boolean;
}

interface RecentHistorySnapshot {
  at: number;
  limit: number;
  candles: Candle[];
  fresh: boolean;
}

interface IdleRunOptions {
  retryOnInterrupt?: boolean;
  cancelSignal?: AbortSignal;
}

const DEFAULT_ENDPOINTS: Record<BinanceMarket, BinanceEndpoints> = {
  spot: {
    restBase: 'https://data-api.binance.vision',
    websocketBase: 'wss://data-stream.binance.vision/ws',
    combinedWebsocketBase: 'wss://data-stream.binance.vision/stream',
    timePath: '/api/v3/time',
    klinesPath: '/api/v3/klines',
    exchangeInfoPath: '/api/v3/exchangeInfo',
  },
  usdm: {
    restBase: 'https://fapi.binance.com',
    websocketBase: 'wss://fstream.binance.com/ws',
    combinedWebsocketBase: 'wss://fstream.binance.com/stream',
    timePath: '/fapi/v1/time',
    klinesPath: '/fapi/v1/klines',
    exchangeInfoPath: '/fapi/v1/exchangeInfo',
  },
};

const MAX_PAGE_SIZE = 1000;
const MAX_HISTORY_REQUEST = 50_000;
const SYMBOL_CACHE_MS = 30 * 60 * 1000;
const RECONNECT_MAX_MS = 30_000;
const DEFAULT_CACHE_READ_TIMEOUT_MS = 1000;
const DEFAULT_REMOTE_IDLE_MS = 650;
const RECENT_SNAPSHOT_MS = 2_000;

function normalizedSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function klineToCandle(kline: BinanceKlinePayload): Candle | null {
  const time = finiteNumber(kline.t);
  const open = finiteNumber(kline.o);
  const high = finiteNumber(kline.h);
  const low = finiteNumber(kline.l);
  const close = finiteNumber(kline.c);
  const volume = finiteNumber(kline.v);
  if (time === null || open === null || high === null || low === null || close === null) return null;
  return {
    time: Math.floor(time / 1000),
    open,
    high,
    low,
    close,
    volume: volume ?? undefined,
  };
}

function rowToCandle(row: unknown): Candle | null {
  if (!Array.isArray(row) || row.length < 6) return null;
  return klineToCandle({
    t: Number(row[0]),
    o: String(row[1]),
    h: String(row[2]),
    l: String(row[3]),
    c: String(row[4]),
    v: String(row[5]),
  });
}

function resolveWithin<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      resolve(value);
    };
    const timeout = globalThis.setTimeout(() => finish(fallback), Math.max(0, timeoutMs));
    promise.then(finish, () => finish(fallback));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, Math.max(0, ms)));
}

export class BinanceIdleRefreshCoordinator {
  private generation = 0;
  private quietUntil = 0;
  private readonly activeControllers = new Set<AbortController>();

  constructor(private readonly idleMs = DEFAULT_REMOTE_IDLE_MS) {}

  noteActivity(): void {
    this.generation += 1;
    this.quietUntil = Date.now() + Math.max(0, this.idleMs);
    for (const controller of this.activeControllers) controller.abort();
  }

  async runWhenIdle<T>(
    task: (signal: AbortSignal) => Promise<T>,
    options: IdleRunOptions = {},
  ): Promise<T | undefined> {
    const retryOnInterrupt = options.retryOnInterrupt ?? false;
    while (!options.cancelSignal?.aborted) {
      const generation = this.generation;
      const waitMs = this.quietUntil - Date.now();
      if (waitMs > 0) await delay(waitMs);
      if (options.cancelSignal?.aborted) return undefined;
      if (generation !== this.generation || Date.now() < this.quietUntil) continue;

      const controller = new AbortController();
      const cancel = () => controller.abort();
      options.cancelSignal?.addEventListener('abort', cancel, { once: true });
      this.activeControllers.add(controller);
      try {
        return await task(controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        if (options.cancelSignal?.aborted || !retryOnInterrupt) return undefined;
      } finally {
        options.cancelSignal?.removeEventListener('abort', cancel);
        this.activeControllers.delete(controller);
      }
    }
    return undefined;
  }
}

const sharedRefreshCoordinator = new BinanceIdleRefreshCoordinator();

export function mergeBinanceCandles(...groups: Candle[][]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const group of groups) {
    for (const candle of group) byTime.set(candle.time, candle);
  }
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

/** Find gaps from actual cached timestamps so disjoint cache segments are not treated as fully covered. */
export function missingBinanceHistoryRanges(
  candles: Candle[],
  requested: HistoryRange,
  step: number,
): HistoryRange[] {
  const from = Math.ceil(requested.from / step) * step;
  const to = Math.floor(requested.to / step) * step;
  if (from > to) return [];

  const times = [...new Set(candles
    .map((candle) => candle.time)
    .filter((time) => time >= from && time <= to))]
    .sort((left, right) => left - right);

  const gaps: HistoryRange[] = [];
  let cursor = from;
  for (const time of times) {
    if (time < cursor) continue;
    if (time > cursor) gaps.push({ from: cursor, to: Math.min(to, time - step) });
    cursor = time + step;
    if (cursor > to) break;
  }
  if (cursor <= to) gaps.push({ from: cursor, to });
  return gaps.filter((gap) => gap.from <= gap.to);
}

function endpointOptions(
  options: BinanceDatafeedOptions | string,
  legacyWebsocketBase?: string,
): Required<Pick<BinanceDatafeedOptions, 'market' | 'restBase' | 'websocketBase' | 'combinedWebsocketBase'>> {
  if (typeof options === 'string') {
    const websocketBase = legacyWebsocketBase ?? DEFAULT_ENDPOINTS.spot.websocketBase;
    return {
      market: 'spot',
      restBase: options.replace(/\/$/, ''),
      websocketBase: websocketBase.replace(/\/$/, ''),
      combinedWebsocketBase: websocketBase.replace(/\/ws\/?$/, '/stream').replace(/\/$/, ''),
    };
  }
  const market = options.market ?? 'spot';
  const defaults = DEFAULT_ENDPOINTS[market];
  return {
    market,
    restBase: (options.restBase ?? defaults.restBase).replace(/\/$/, ''),
    websocketBase: (options.websocketBase ?? defaults.websocketBase).replace(/\/$/, ''),
    combinedWebsocketBase: (options.combinedWebsocketBase ?? defaults.combinedWebsocketBase).replace(/\/$/, ''),
  };
}

/** Public Binance Spot or USD-M Futures market data with browser-local IndexedDB history cache. */
export class BinanceDatafeed implements Datafeed {
  readonly name: string;
  readonly market: BinanceMarket;

  private readonly endpoints: BinanceEndpoints;
  private readonly cache: BinanceHistoryCache;
  private readonly fetchImpl: typeof fetch;
  private readonly websocketFactory: (url: string) => WebSocket;
  private readonly requestTimeoutMs: number;
  private readonly cacheReadTimeoutMs: number;
  private readonly refreshCoordinator: BinanceIdleRefreshCoordinator;
  private readonly realtimeConnectedListeners = new Set<() => void>();
  private readonly recentHistory = new Map<string, RecentHistorySnapshot>();
  private symbolCache: SymbolSearchResult[] | null = null;
  private symbolCacheAt = 0;

  constructor(options?: BinanceDatafeedOptions);
  constructor(restBase?: string, websocketBase?: string);
  constructor(options: BinanceDatafeedOptions | string = {}, legacyWebsocketBase?: string) {
    const resolved = endpointOptions(options, legacyWebsocketBase);
    const defaults = DEFAULT_ENDPOINTS[resolved.market];
    this.market = resolved.market;
    this.name = this.market === 'spot' ? 'Binance Spot' : 'Binance USD-M Futures';
    this.endpoints = {
      ...defaults,
      restBase: resolved.restBase,
      websocketBase: resolved.websocketBase,
      combinedWebsocketBase: resolved.combinedWebsocketBase,
    };
    const objectOptions = typeof options === 'string' ? {} : options;
    this.cache = objectOptions.cache ?? new BinanceHistoryCache();
    this.fetchImpl = objectOptions.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.websocketFactory = objectOptions.websocketFactory ?? ((url) => new WebSocket(url));
    this.requestTimeoutMs = objectOptions.requestTimeoutMs ?? 10_000;
    this.cacheReadTimeoutMs = Math.max(0, objectOptions.cacheReadTimeoutMs ?? DEFAULT_CACHE_READ_TIMEOUT_MS);
    this.refreshCoordinator = objectOptions.refreshCoordinator ?? sharedRefreshCoordinator;
  }

  get cacheAvailable(): boolean {
    return this.cache.available;
  }

  async clearCache(): Promise<void> {
    await this.cache.clearMarket(this.market);
    this.recentHistory.clear();
  }

  async ping(): Promise<boolean> {
    try {
      await this.fetchJson(new URL(this.endpoints.timePath, this.endpoints.restBase));
      return true;
    } catch {
      return false;
    }
  }

  async getCachedHistory(
    symbol: string,
    interval: string,
    limit = 500,
    range?: HistoryRange,
  ): Promise<Candle[]> {
    const normalized = normalizedSymbol(symbol);
    if (!normalized) return [];
    const requestedLimit = Math.min(MAX_HISTORY_REQUEST, Math.max(1, Math.floor(limit)));
    if (!range) {
      this.refreshCoordinator.noteActivity();
      const cached = await this.readCache(
        this.cache.readLatest(this.market, normalized, interval, requestedLimit),
        [],
      );
      this.rememberRecent(normalized, interval, requestedLimit, cached, false);
      return cached;
    }
    return this.readCache(
      this.cache.readRange(
        this.market,
        normalized,
        interval,
        Math.min(range.from, range.to),
        Math.max(range.from, range.to),
        requestedLimit,
      ),
      [],
    );
  }

  async getHistory(
    symbol: string,
    interval: string,
    limit = 500,
    range?: HistoryRange,
  ): Promise<Candle[]> {
    const normalized = normalizedSymbol(symbol);
    if (!normalized) return [];
    const requestedLimit = Math.min(MAX_HISTORY_REQUEST, Math.max(1, Math.floor(limit)));
    const step = INTERVAL_SECONDS[interval] ?? intervalApproxSeconds(interval);
    const calendarInterval = isCalendarInterval(interval);

    if (!range) {
      const remembered = this.recentSnapshot(normalized, interval, requestedLimit);
      const cached = remembered?.candles ?? await this.readCache(
        this.cache.readLatest(this.market, normalized, interval, requestedLimit),
        [],
      );
      if (cached.length > 0) {
        this.rememberRecent(normalized, interval, requestedLimit, cached, false);
        return cached.slice(-requestedLimit);
      }

      const remote = await this.refreshCoordinator.runWhenIdle(
        (signal) => this.fetchRecent(normalized, interval, requestedLimit, signal),
      );
      if (!remote) return [];
      this.persistClosedCandles(normalized, interval, remote);
      this.rememberRecent(normalized, interval, requestedLimit, remote, true);
      return remote.slice(-requestedLimit);
    }

    if (calendarInterval) {
      const requested = { from: Math.min(range.from, range.to), to: Math.max(range.from, range.to) };
      const cached = await this.readCache(
        this.cache.readRange(
          this.market,
          normalized,
          interval,
          requested.from,
          requested.to,
          requestedLimit,
        ),
        [],
      );
      try {
        const remote = await this.fetchRange(normalized, interval, requested, requestedLimit);
        this.persistClosedCandles(normalized, interval, remote);
        return mergeBinanceCandles(cached, remote)
          .filter((candle) => candle.time >= requested.from && candle.time <= requested.to)
          .slice(-requestedLimit);
      } catch (error) {
        if (cached.length > 0) return cached.slice(-requestedLimit);
        throw error;
      }
    }

    const rangeFrom = Math.ceil(Math.min(range.from, range.to) / step) * step;
    const rangeTo = Math.floor(Math.max(range.from, range.to) / step) * step;
    if (rangeFrom > rangeTo) return [];
    const effectiveFrom = Math.max(rangeFrom, rangeTo - (requestedLimit - 1) * step);
    const requested = { from: effectiveFrom, to: rangeTo };
    const cached = await this.readCache(
      this.cache.readRange(
        this.market,
        normalized,
        interval,
        requested.from,
        requested.to,
        requestedLimit,
      ),
      [],
    );
    const gaps = missingBinanceHistoryRanges(cached, requested, step);
    let fetched: Candle[] = [];

    try {
      for (const gap of gaps) {
        const gapBars = Math.floor((gap.to - gap.from) / step) + 1;
        const remote = await this.fetchRange(
          normalized,
          interval,
          gap,
          Math.min(requestedLimit, Math.max(1, gapBars)),
        );
        fetched = mergeBinanceCandles(fetched, remote);
      }
      this.persistClosedCandles(normalized, interval, fetched);
      return mergeBinanceCandles(cached, fetched)
        .filter((candle) => candle.time >= requested.from && candle.time <= requested.to)
        .slice(-requestedLimit);
    } catch (error) {
      const fallback = mergeBinanceCandles(cached, fetched).slice(-requestedLimit);
      if (fallback.length > 0) return fallback;
      throw error;
    }
  }

  subscribe(symbol: string, interval: string, onCandle: (candle: Candle) => void): () => void {
    const normalized = normalizedSymbol(symbol);
    if (!normalized) return () => undefined;

    const cancellation = new AbortController();
    let closeSocket: (() => void) | null = null;
    const stream = `${normalized.toLowerCase()}@kline_${interval}`;
    const openSocket = () => {
      if (cancellation.signal.aborted || closeSocket) return;
      closeSocket = this.openReconnectableSocket(`${this.endpoints.websocketBase}/${stream}`, (payload) => {
        const kline = payload?.k as BinanceKlinePayload | undefined;
        if (!kline) return;
        const candle = klineToCandle(kline);
        if (!candle) return;
        onCandle(candle);
        if (kline.x) void this.cache.write(this.market, normalized, interval, [candle]);
      });
    };

    void (async () => {
      const remembered = this.recentSnapshot(normalized, interval);
      const requestedLimit = remembered?.limit ?? 500;
      const cached = remembered?.candles ?? await this.readCache(
        this.cache.readLatest(this.market, normalized, interval, requestedLimit),
        [],
      );
      if (cancellation.signal.aborted) return;

      const recentlyFresh = remembered?.fresh === true && Date.now() - remembered.at < RECENT_SNAPSHOT_MS;
      if (!recentlyFresh) {
        const refreshed = await this.refreshCoordinator.runWhenIdle(
          (signal) => this.refreshLatest(normalized, interval, requestedLimit, cached, signal),
          { retryOnInterrupt: true, cancelSignal: cancellation.signal },
        );
        if (cancellation.signal.aborted) return;
        if (refreshed && refreshed.length > 0) {
          const baseline = cached[cached.length - 1]?.time;
          for (const candle of refreshed) {
            if (baseline === undefined || candle.time >= baseline) onCandle(candle);
          }
          this.rememberRecent(normalized, interval, requestedLimit, refreshed, true);
        }
      } else {
        await this.refreshCoordinator.runWhenIdle(
          async () => true,
          { retryOnInterrupt: true, cancelSignal: cancellation.signal },
        );
      }
      if (!cancellation.signal.aborted) openSocket();
    })().catch((error) => {
      if (cancellation.signal.aborted) return;
      console.warn(`Unable to refresh Binance ${normalized} ${interval} before realtime`, error);
      openSocket();
    });

    return () => {
      cancellation.abort();
      closeSocket?.();
      closeSocket = null;
    };
  }

  onRealtimeConnected(listener: () => void): () => void {
    this.realtimeConnectedListeners.add(listener);
    return () => this.realtimeConnectedListeners.delete(listener);
  }

  subscribeMany(
    symbols: string[],
    interval: string,
    onCandle: (symbol: string, candle: Candle) => void,
  ): () => void {
    const normalized = [...new Set(symbols.map(normalizedSymbol).filter(Boolean))];
    if (normalized.length === 0) return () => undefined;
    const streams = normalized.map((symbol) => `${symbol.toLowerCase()}@kline_${interval}`).join('/');
    return this.openSocketWhenIdle(`${this.endpoints.combinedWebsocketBase}?streams=${streams}`, (payload) => {
      const data = payload?.data ?? payload;
      const symbol = normalizedSymbol(String(data?.s ?? data?.k?.s ?? ''));
      const kline = data?.k as BinanceKlinePayload | undefined;
      if (!symbol || !kline) return;
      const candle = klineToCandle(kline);
      if (!candle) return;
      onCandle(symbol, candle);
      if (kline.x) void this.cache.write(this.market, symbol, interval, [candle]);
    });
  }

  subscribeQuotes(symbols: string[], onQuote: (quote: QuoteUpdate) => void): () => void {
    const normalized = [...new Set(symbols.map(normalizedSymbol).filter(Boolean))];
    if (normalized.length === 0) return () => undefined;
    const streams = normalized.map((symbol) => `${symbol.toLowerCase()}@bookTicker`).join('/');
    return this.openSocketWhenIdle(`${this.endpoints.combinedWebsocketBase}?streams=${streams}`, (payload) => {
      const data = payload?.data ?? payload;
      const symbol = normalizedSymbol(String(data?.s ?? ''));
      const bid = finiteNumber(data?.b);
      const bidVolume = finiteNumber(data?.B);
      const ask = finiteNumber(data?.a);
      const askVolume = finiteNumber(data?.A);
      if (!symbol || bid === null || ask === null) return;
      onQuote({
        symbol,
        bids: [{ price: bid, volume: bidVolume ?? 0 }],
        asks: [{ price: ask, volume: askVolume ?? 0 }],
        time: Math.floor((finiteNumber(data?.E) ?? Date.now()) / 1000),
      });
    });
  }

  async searchSymbols(query: string, limit = 20): Promise<SymbolSearchResult[]> {
    const needle = normalizedSymbol(query);
    const symbols = await this.getExchangeSymbols();
    const ranked = symbols
      .filter((item) => !needle || item.symbol.includes(needle) || item.name?.replace('/', '').includes(needle))
      .sort((left, right) => {
        const leftPrefix = needle && left.symbol.startsWith(needle) ? 0 : 1;
        const rightPrefix = needle && right.symbol.startsWith(needle) ? 0 : 1;
        return leftPrefix - rightPrefix || left.symbol.localeCompare(right.symbol);
      });
    return ranked.slice(0, Math.max(1, limit));
  }

  private async getExchangeSymbols(): Promise<SymbolSearchResult[]> {
    if (this.symbolCache && Date.now() - this.symbolCacheAt < SYMBOL_CACHE_MS) return this.symbolCache;
    const response = await this.fetchJson(new URL(this.endpoints.exchangeInfoPath, this.endpoints.restBase)) as {
      symbols?: BinanceExchangeSymbol[];
    };
    const exchange = this.market === 'spot' ? 'BINANCE' : 'BINANCE USD-M';
    this.symbolCache = (response.symbols ?? [])
      .filter((item) => item.status === 'TRADING')
      .filter((item) => this.market === 'spot'
        ? item.isSpotTradingAllowed !== false
        : item.contractType === 'PERPETUAL')
      .flatMap((item) => {
        const symbol = normalizedSymbol(item.symbol ?? '');
        if (!symbol) return [];
        return [{
          symbol,
          name: item.baseAsset && item.quoteAsset ? `${item.baseAsset}/${item.quoteAsset}` : symbol,
          exchange,
        } satisfies SymbolSearchResult];
      });
    this.symbolCacheAt = Date.now();
    return this.symbolCache;
  }

  private historyKey(symbol: string, interval: string): string {
    return `${this.market}:${symbol}:${interval}`;
  }

  private recentSnapshot(symbol: string, interval: string, limit?: number): RecentHistorySnapshot | null {
    const snapshot = this.recentHistory.get(this.historyKey(symbol, interval));
    if (!snapshot || Date.now() - snapshot.at > RECENT_SNAPSHOT_MS) return null;
    if (limit !== undefined && snapshot.limit < limit) return null;
    return snapshot;
  }

  private rememberRecent(
    symbol: string,
    interval: string,
    limit: number,
    candles: Candle[],
    fresh: boolean,
  ): void {
    this.recentHistory.set(this.historyKey(symbol, interval), {
      at: Date.now(),
      limit,
      candles: candles.map((candle) => ({ ...candle })),
      fresh,
    });
  }

  private readCache<T>(promise: Promise<T>, fallback: T): Promise<T> {
    return resolveWithin(promise, this.cacheReadTimeoutMs, fallback);
  }

  private persistClosedCandles(symbol: string, interval: string, candles: Candle[]): void {
    void this.writeClosedCandles(symbol, interval, candles).catch(() => undefined);
  }

  private async writeClosedCandles(symbol: string, interval: string, candles: Candle[]): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const closed = candles.filter((candle) => nextIntervalStart(candle.time, interval) <= now);
    await this.cache.write(this.market, symbol, interval, closed);
  }

  private async refreshLatest(
    symbol: string,
    interval: string,
    limit: number,
    cached: Candle[],
    signal: AbortSignal,
  ): Promise<Candle[]> {
    const lastCached = cached[cached.length - 1]?.time;
    if (isCalendarInterval(interval)) {
      if (lastCached !== undefined) {
        const now = Math.floor(Date.now() / 1000);
        const approxStep = Math.max(1, intervalApproxSeconds(interval));
        const refreshLimit = Math.min(limit, Math.max(2, Math.ceil((now - lastCached) / approxStep) + 2));
        const remote = await this.fetchRange(
          symbol,
          interval,
          { from: lastCached, to: now },
          refreshLimit,
          signal,
        );
        this.persistClosedCandles(symbol, interval, remote);
        return mergeBinanceCandles(cached, remote).slice(-limit);
      }
      const remote = await this.fetchRecent(symbol, interval, limit, signal);
      this.persistClosedCandles(symbol, interval, remote);
      return remote.slice(-limit);
    }

    const step = INTERVAL_SECONDS[interval] ?? intervalApproxSeconds(interval);
    const currentBar = Math.floor(Date.now() / 1000 / step) * step;
    if (lastCached !== undefined && cached.length >= limit) {
      const missingFrom = lastCached + step;
      if (missingFrom >= currentBar) return cached.slice(-limit);
      const remote = await this.fetchRange(
        symbol,
        interval,
        { from: missingFrom, to: currentBar },
        limit,
        signal,
      );
      this.persistClosedCandles(symbol, interval, remote);
      return mergeBinanceCandles(cached, remote).slice(-limit);
    }

    const remote = await this.fetchRecent(symbol, interval, limit, signal);
    this.persistClosedCandles(symbol, interval, remote);
    return mergeBinanceCandles(cached, remote).slice(-limit);
  }

  private async fetchRecent(
    symbol: string,
    interval: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Candle[]> {
    let remaining = limit;
    let endTime: number | undefined;
    let result: Candle[] = [];
    while (remaining > 0) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const pageLimit = Math.min(MAX_PAGE_SIZE, remaining);
      const page = await this.fetchKlines(symbol, interval, pageLimit, undefined, endTime, signal);
      if (page.length === 0) break;
      result = mergeBinanceCandles(page, result);
      remaining = limit - result.length;
      if (page.length < pageLimit) break;
      endTime = page[0].time * 1000 - 1;
    }
    return result.slice(-limit);
  }

  /** Fetch the most recent `limit` candles ending at range.to, then page backwards. */
  private async fetchRange(
    symbol: string,
    interval: string,
    range: HistoryRange,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Candle[]> {
    let endTime = range.to * 1000;
    let result: Candle[] = [];
    while (result.length < limit) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const pageLimit = Math.min(MAX_PAGE_SIZE, limit - result.length);
      const page = await this.fetchKlines(symbol, interval, pageLimit, undefined, endTime, signal);
      if (page.length === 0) break;
      const inRange = page.filter((candle) => candle.time >= range.from && candle.time <= range.to);
      result = mergeBinanceCandles(inRange, result);
      const earliest = page[0].time;
      if (earliest <= range.from || page.length < pageLimit) break;
      const nextEndTime = earliest * 1000 - 1;
      if (nextEndTime >= endTime) break;
      endTime = nextEndTime;
    }
    return result.slice(-limit);
  }

  private async fetchKlines(
    symbol: string,
    interval: string,
    limit: number,
    startTime?: number,
    endTime?: number,
    signal?: AbortSignal,
  ): Promise<Candle[]> {
    const url = new URL(this.endpoints.klinesPath, this.endpoints.restBase);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('limit', String(Math.min(MAX_PAGE_SIZE, Math.max(1, limit))));
    if (startTime !== undefined) url.searchParams.set('startTime', String(Math.floor(startTime)));
    if (endTime !== undefined) url.searchParams.set('endTime', String(Math.floor(endTime)));
    const rows = await this.fetchJson(url, signal);
    if (!Array.isArray(rows)) throw new Error('Binance klines returned an invalid payload');
    return rows.flatMap((row) => {
      const candle = rowToCandle(row);
      return candle ? [candle] : [];
    });
  }

  private async fetchJson(url: URL, externalSignal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const abortFromExternal = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
    const timeout = globalThis.setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(url.toString(), { signal: controller.signal });
      if (!response.ok) {
        const retryAfter = response.headers.get('retry-after');
        const suffix = retryAfter ? `; retry after ${retryAfter}s` : '';
        throw new Error(`Binance HTTP ${response.status}${suffix}`);
      }
      return await response.json();
    } finally {
      globalThis.clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abortFromExternal);
    }
  }

  private openSocketWhenIdle(url: string, onPayload: (payload: any) => void): () => void {
    const cancellation = new AbortController();
    let closeSocket: (() => void) | null = null;
    void this.refreshCoordinator.runWhenIdle(
      async () => true,
      { retryOnInterrupt: true, cancelSignal: cancellation.signal },
    ).then(() => {
      if (!cancellation.signal.aborted) closeSocket = this.openReconnectableSocket(url, onPayload);
    }).catch(() => undefined);
    return () => {
      cancellation.abort();
      closeSocket?.();
      closeSocket = null;
    };
  }

  private openReconnectableSocket(url: string, onPayload: (payload: any) => void): () => void {
    let socket: WebSocket | null = null;
    let closed = false;
    let connectedBefore = false;
    let retryAttempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      socket = this.websocketFactory(url);
      socket.onopen = () => {
        retryAttempt = 0;
        if (connectedBefore) {
          for (const listener of this.realtimeConnectedListeners) listener();
        }
        connectedBefore = true;
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        try {
          onPayload(JSON.parse(event.data));
        } catch {
          // Ignore malformed or provider-control frames.
        }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        socket = null;
        if (closed) return;
        const baseDelay = Math.min(RECONNECT_MAX_MS, 1000 * (2 ** retryAttempt));
        retryAttempt = Math.min(retryAttempt + 1, 6);
        retryTimer = globalThis.setTimeout(connect, baseDelay + Math.floor(Math.random() * 250));
      };
    };

    connect();
    return () => {
      closed = true;
      if (retryTimer !== null) globalThis.clearTimeout(retryTimer);
      socket?.close();
      socket = null;
    };
  }
}
