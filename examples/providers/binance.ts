import type { Candle } from '../../src/core/types';
import {
  INTERVAL_SECONDS,
  type Datafeed,
  type HistoryRange,
  type QuoteUpdate,
  type SymbolSearchResult,
} from '../../src/datafeed';
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
  private readonly realtimeConnectedListeners = new Set<() => void>();
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
    this.fetchImpl = objectOptions.fetchImpl ?? fetch;
    this.websocketFactory = objectOptions.websocketFactory ?? ((url) => new WebSocket(url));
    this.requestTimeoutMs = objectOptions.requestTimeoutMs ?? 10_000;
  }

  get cacheAvailable(): boolean {
    return this.cache.available;
  }

  async clearCache(): Promise<void> {
    await this.cache.clearMarket(this.market);
  }

  async ping(): Promise<boolean> {
    try {
      await this.fetchJson(new URL(this.endpoints.timePath, this.endpoints.restBase));
      return true;
    } catch {
      return false;
    }
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
    const step = INTERVAL_SECONDS[interval] ?? 60;

    if (!range) {
      const cached = await this.cache.readLatest(this.market, normalized, interval, requestedLimit);
      const lastCached = cached[cached.length - 1]?.time;
      const currentBar = Math.floor(Date.now() / 1000 / step) * step;
      try {
        if (lastCached !== undefined && cached.length >= requestedLimit) {
          const missingFrom = lastCached + step;
          if (missingFrom >= currentBar) return cached;
          const remote = await this.fetchRange(
            normalized,
            interval,
            { from: missingFrom, to: currentBar },
            requestedLimit,
          );
          await this.writeClosedCandles(normalized, interval, remote);
          return mergeBinanceCandles(cached, remote).slice(-requestedLimit);
        }

        const remote = await this.fetchRecent(normalized, interval, requestedLimit);
        await this.writeClosedCandles(normalized, interval, remote);
        return mergeBinanceCandles(cached, remote).slice(-requestedLimit);
      } catch (error) {
        if (cached.length > 0) return cached;
        throw error;
      }
    }

    const rangeFrom = Math.ceil(Math.min(range.from, range.to) / step) * step;
    const rangeTo = Math.floor(Math.max(range.from, range.to) / step) * step;
    if (rangeFrom > rangeTo) return [];
    const effectiveFrom = Math.max(rangeFrom, rangeTo - (requestedLimit - 1) * step);
    const requested = { from: effectiveFrom, to: rangeTo };
    const cached = await this.cache.readRange(
      this.market,
      normalized,
      interval,
      requested.from,
      requested.to,
      requestedLimit,
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
        await this.writeClosedCandles(normalized, interval, remote);
      }

      const complete = await this.cache.readRange(
        this.market,
        normalized,
        interval,
        requested.from,
        requested.to,
        requestedLimit,
      );
      return mergeBinanceCandles(cached, complete, fetched)
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
    const stream = `${normalized.toLowerCase()}@kline_${interval}`;
    return this.openReconnectableSocket(`${this.endpoints.websocketBase}/${stream}`, (payload) => {
      const kline = payload?.k as BinanceKlinePayload | undefined;
      if (!kline) return;
      const candle = klineToCandle(kline);
      if (!candle) return;
      onCandle(candle);
      if (kline.x) void this.cache.write(this.market, normalized, interval, [candle]);
    });
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
    return this.openReconnectableSocket(`${this.endpoints.combinedWebsocketBase}?streams=${streams}`, (payload) => {
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
    return this.openReconnectableSocket(`${this.endpoints.combinedWebsocketBase}?streams=${streams}`, (payload) => {
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

  private async writeClosedCandles(symbol: string, interval: string, candles: Candle[]): Promise<void> {
    const step = INTERVAL_SECONDS[interval] ?? 60;
    const now = Math.floor(Date.now() / 1000);
    const closed = candles.filter((candle) => candle.time + step <= now);
    await this.cache.write(this.market, symbol, interval, closed);
  }

  private async fetchRecent(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    let remaining = limit;
    let endTime: number | undefined;
    let result: Candle[] = [];
    while (remaining > 0) {
      const pageLimit = Math.min(MAX_PAGE_SIZE, remaining);
      const page = await this.fetchKlines(symbol, interval, pageLimit, undefined, endTime);
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
  ): Promise<Candle[]> {
    let endTime = range.to * 1000;
    let result: Candle[] = [];
    while (result.length < limit) {
      const pageLimit = Math.min(MAX_PAGE_SIZE, limit - result.length);
      const page = await this.fetchKlines(symbol, interval, pageLimit, undefined, endTime);
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
  ): Promise<Candle[]> {
    const url = new URL(this.endpoints.klinesPath, this.endpoints.restBase);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('limit', String(Math.min(MAX_PAGE_SIZE, Math.max(1, limit))));
    if (startTime !== undefined) url.searchParams.set('startTime', String(Math.floor(startTime)));
    if (endTime !== undefined) url.searchParams.set('endTime', String(Math.floor(endTime)));
    const rows = await this.fetchJson(url);
    if (!Array.isArray(rows)) throw new Error('Binance klines returned an invalid payload');
    return rows.flatMap((row) => {
      const candle = rowToCandle(row);
      return candle ? [candle] : [];
    });
  }

  private async fetchJson(url: URL): Promise<unknown> {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        const retryAfter = response.headers.get('retry-after');
        const suffix = retryAfter ? `; retry after ${retryAfter}s` : '';
        throw new Error(`Binance HTTP ${response.status}${suffix}`);
      }
      return await response.json();
    } finally {
      globalThis.clearTimeout(timeout);
    }
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
