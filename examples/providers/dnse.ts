import type { Candle } from '../../src/core/types';
import {
  INTERVAL_SECONDS,
  type Datafeed,
  type HistoryRange,
  type QuoteLevel,
  type QuoteUpdate,
} from '../../src/datafeed';
import { aggregateCalendarCandles } from '../../src/calendar-candles';
import { intervalStart, nextIntervalStart } from '../../src/interval';

export interface DnseCredentials {
  apiKey?: string;
  apiSecret?: string;
  restBase?: string;
  wsBase?: string;
  marketType?: DnseMarketType | string;
  useProxyCredentials?: boolean;
}

interface RawRecord {
  [key: string]: unknown;
}

export type DnseMarketType = 'STOCK' | 'DERIVATIVE' | 'INDEX';
export type DnseRealtimeState =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'reconnecting'
  | 'error';

interface DnseChannel {
  name: string;
  symbols: string[];
}

interface DnseSubscription {
  channels: DnseChannel[];
  onMessage: (data: RawRecord) => void;
}

const DEFAULT_REST_BASE = 'https://openapi.dnse.com.vn';
const DEFAULT_WS_BASE = 'wss://ws-openapi.dnse.com.vn';
const DEFAULT_MARKET_TYPE: DnseMarketType = 'STOCK';
const VN_OFFSET_MINUTES = 7 * 60;
// DNSE exposes top-price quotes on the seven G boards. The T boards belong to
// trade subscriptions and cause the gateway to reject a top_price channel.
const TOP_PRICE_BOARDS = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'];

const RESOLUTION_BY_INTERVAL: Record<string, string> = {
  '1m': '1',
  '3m': '3',
  '5m': '5',
  '15m': '15',
  '30m': '30',
  '1h': '1H',
  '1d': '1D',
  '1w': '1W',
};

const INDEX_SYMBOL_ALIASES: Record<string, string> = {
  HNX: 'HNX',
  HNX30: 'HNX30',
  UPCOM: 'UPCOM',
  UPCOMINDEX: 'UPCOM',
  VNI: 'VNINDEX',
  VN30: 'VN30',
  VNDINEX: 'VNINDEX',
  VNDINDEX: 'VNINDEX',
  VNINDEX: 'VNINDEX',
};
const INDEX_SYMBOLS = new Set(Object.values(INDEX_SYMBOL_ALIASES));
const DERIVATIVE_SYMBOL_RE = /^(VN30|V100)F\d[MQ]$/;

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatDateHeader(date: Date): string {
  return `${DAY_NAMES[date.getUTCDay()]}, ${pad2(date.getUTCDate())} ${
    MONTH_NAMES[date.getUTCMonth()]
  } ${date.getUTCFullYear()} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(
    date.getUTCSeconds(),
  )} +0000`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  if (!crypto.subtle) throw new Error('Web Crypto API không khả dụng để ký DNSE HMAC');
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

function nonceHex(): string {
  if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function absoluteBaseUrl(base: string, path: string): string {
  if (/^(https?|wss?):\/\//i.test(base)) return `${base}${path}`;
  const origin =
    typeof window !== 'undefined' && window.location
      ? window.location.origin
      : 'http://127.0.0.1:53173';
  return new URL(`${base}${path}`, origin).toString();
}

function absoluteWebSocketUrl(base: string, path: string): string {
  const url = new URL(absoluteBaseUrl(base, path));
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  return url.toString();
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function unixSeconds(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') {
    const rec = value as RawRecord;
    const seconds = numeric(rec.Seconds ?? rec.seconds);
    const nanos = numeric(rec.Nanos ?? rec.nanos) ?? 0;
    return seconds === null ? null : Math.floor(seconds + nanos / 1e9);
  }
  const n = numeric(value);
  if (n !== null) return Math.floor(n > 1e12 ? n / 1000 : n);
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }
  return null;
}

function readArrayPayload(payload: RawRecord): RawRecord[] | null {
  const t = payload.t ?? payload.time;
  const o = payload.o ?? payload.open;
  const h = payload.h ?? payload.high;
  const l = payload.l ?? payload.low;
  const c = payload.c ?? payload.close;
  if (!Array.isArray(t) || !Array.isArray(o) || !Array.isArray(h) || !Array.isArray(l) || !Array.isArray(c)) {
    return null;
  }
  const v = payload.v ?? payload.volume;
  const volumes = Array.isArray(v) ? v : [];
  return t.map((time, i) => ({
    time,
    open: o[i],
    high: h[i],
    low: l[i],
    close: c[i],
    volume: volumes[i],
  }));
}

function unwrapRows(payload: unknown): RawRecord[] {
  if (Array.isArray(payload)) return payload as RawRecord[];
  if (!payload || typeof payload !== 'object') return [];
  const rec = payload as RawRecord;
  const arrayPayload = readArrayPayload(rec);
  if (arrayPayload) return arrayPayload;
  for (const key of ['data', 'items', 'rows', 'result', 'ohlc']) {
    const value = rec[key];
    if (Array.isArray(value)) return value as RawRecord[];
    if (value && typeof value === 'object') {
      const nested = readArrayPayload(value as RawRecord);
      if (nested) return nested;
    }
  }
  return [];
}

function parseCandle(row: RawRecord): Candle | null {
  const time = unixSeconds(row.time ?? row.t ?? row.tradingDate ?? row.date);
  const open = numeric(row.open ?? row.o);
  const high = numeric(row.high ?? row.h);
  const low = numeric(row.low ?? row.l);
  const close = numeric(row.close ?? row.c);
  if (
    time === null || time <= 0 ||
    open === null || open <= 0 ||
    high === null || high <= 0 ||
    low === null || low <= 0 ||
    close === null || close <= 0 ||
    high < Math.max(open, close, low) ||
    low > Math.min(open, close, high)
  ) return null;
  const volume = numeric(row.volume ?? row.v ?? row.totalVolumeTraded);
  return {
    time,
    open,
    high,
    low,
    close,
    volume: volume ?? undefined,
  };
}

function parseQuoteLevels(value: unknown): QuoteLevel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const level = item as RawRecord;
    const price = numeric(level.price);
    const volume = numeric(level.qtty ?? level.quantity ?? level.volume);
    return price !== null && price > 0 && volume !== null
      ? [{ price, volume: Math.max(0, volume) }]
      : [];
  });
}

function parseQuote(data: RawRecord): QuoteUpdate | null {
  const nested = data.quote ?? data.data;
  const payload = nested && typeof nested === 'object' ? nested as RawRecord : data;
  const symbol = String(payload.symbol ?? data.symbol ?? '').trim().toUpperCase();
  const bids = parseQuoteLevels(payload.bid ?? payload.bids);
  const asks = parseQuoteLevels(payload.offer ?? payload.ask ?? payload.asks);
  if (!symbol || (bids.length === 0 && asks.length === 0)) return null;
  return {
    symbol,
    bids,
    asks,
    time: unixSeconds(payload.time ?? data.time) ?? Math.floor(Date.now() / 1000),
  };
}

async function readWsJson(data: string | Blob | ArrayBuffer): Promise<RawRecord | null> {
  try {
    const text =
      typeof data === 'string'
        ? data
        : data instanceof Blob
          ? await data.text()
          : new TextDecoder().decode(data);
    return JSON.parse(text) as RawRecord;
  } catch {
    return null;
  }
}

export function normalizeDnseSymbol(symbol: string): string {
  const cleaned = symbol.trim().toUpperCase().replace(/[\s._-]/g, '');
  return INDEX_SYMBOL_ALIASES[cleaned] ?? cleaned;
}

function marketTypeForSymbol(symbol: string, fallback: string): DnseMarketType | string {
  if (INDEX_SYMBOLS.has(symbol)) return 'INDEX';
  if (DERIVATIVE_SYMBOL_RE.test(symbol)) return 'DERIVATIVE';
  return fallback;
}

/** DNSE LightSpeed OpenAPI datafeed: signed REST history + JSON WebSocket OHLC updates. */
export class DNSEDatafeed implements Datafeed {
  readonly name = 'DNSE';

  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly restBase: string;
  private readonly wsBase: string;
  private readonly marketType: DnseMarketType | string;
  private readonly useProxyCredentials: boolean;
  private ws: WebSocket | null = null;
  private wsAuthenticated = false;
  private wsAuthStarted = false;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wsHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private wsConnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wsWelcomeTimer: ReturnType<typeof setTimeout> | null = null;
  private wsAuthTimer: ReturnType<typeof setTimeout> | null = null;
  private realtimeState: DnseRealtimeState = 'idle';
  private readonly realtimeListeners = new Set<(state: DnseRealtimeState, detail?: string) => void>();
  private readonly subscriptions = new Map<number, DnseSubscription>();
  private readonly channelRefs = new Map<string, number>();
  private nextSubscriptionId = 1;

  constructor(credentials: DnseCredentials) {
    this.apiKey = credentials.apiKey?.trim() ?? '';
    this.apiSecret = credentials.apiSecret?.trim() ?? '';
    this.restBase = (credentials.restBase || DEFAULT_REST_BASE).replace(/\/$/, '');
    this.wsBase = (credentials.wsBase || DEFAULT_WS_BASE).replace(/\/$/, '');
    this.marketType = credentials.marketType || DEFAULT_MARKET_TYPE;
    this.useProxyCredentials = Boolean(credentials.useProxyCredentials);
  }

  static hasCredentials(credentials: DnseCredentials | null): credentials is DnseCredentials {
    if (credentials?.useProxyCredentials) return true;
    const fields = [credentials?.apiKey, credentials?.apiSecret];
    return fields.every((value) => typeof value === 'string' && Boolean(value.trim()));
  }

  getRealtimeState(): DnseRealtimeState {
    return this.realtimeState;
  }

  onRealtimeStatus(listener: (state: DnseRealtimeState, detail?: string) => void): () => void {
    this.realtimeListeners.add(listener);
    listener(this.realtimeState);
    return () => this.realtimeListeners.delete(listener);
  }

  onRealtimeConnected(listener: () => void): () => void {
    const wrapped = (state: DnseRealtimeState) => {
      if (state === 'connected') listener();
    };
    this.realtimeListeners.add(wrapped);
    return () => this.realtimeListeners.delete(wrapped);
  }

  dispose(): void {
    this.subscriptions.clear();
    this.channelRefs.clear();
    this.closeRealtimeSocket();
  }

  async getHistory(symbol: string, interval: string, limit = 500, range?: HistoryRange): Promise<Candle[]> {
    this.assertReady();
    if (interval === '1M') return this.getMonthlyHistory(symbol, limit, range);
    const normalizedSymbol = normalizeDnseSymbol(symbol);
    const marketType = marketTypeForSymbol(normalizedSymbol, this.marketType);
    const resolution = this.resolutionFor(interval);
    const step = INTERVAL_SECONDS[interval] ?? 60;
    const to = range?.to ?? Math.floor(Date.now() / 1000);
    const lookbackSec =
      step < 86400
        ? Math.max(Math.max(limit, 1) * step * 4, 10 * 86400)
        : Math.max(Math.max(limit, 1) * step * 2, 365 * 86400);
    const from = range?.from ?? to - lookbackSec;
    const path = '/price/ohlc';
    const url = new URL(absoluteBaseUrl(this.restBase, path));
    url.searchParams.set('symbol', normalizedSymbol);
    url.searchParams.set('resolution', resolution);
    url.searchParams.set('from', String(from));
    url.searchParams.set('to', String(to));
    url.searchParams.set('type', marketType);

    const res = await fetch(url, {
      method: 'GET',
      headers: await this.restHeaders('GET', path),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`DNSE OHLC HTTP ${res.status}: ${text.slice(0, 160)}`);
    const payload = text ? JSON.parse(text) : [];
    return unwrapRows(payload)
      .map(parseCandle)
      .filter((c): c is Candle => c !== null)
      .sort((a, b) => a.time - b.time)
      .slice(-limit);
  }

  subscribe(symbol: string, interval: string, onCandle: (c: Candle) => void): () => void {
    if (interval === '1M') return this.subscribeMonthly(symbol, onCandle);
    const resolution = this.resolutionFor(interval);
    const normalizedSymbol = normalizeDnseSymbol(symbol);
    const channel = `ohlc.${resolution}.json`;
    return this.subscribeChannels([{ name: channel, symbols: [normalizedSymbol] }], (data) => {
      const type = data.T;
      if (type !== 'b' && type !== 'bc') return;
      const candle = parseCandle((data.ohlc ?? data.data ?? data) as RawRecord);
      if (!candle) return;
      const payloadSymbol = String(data.symbol ?? (data.data as RawRecord | undefined)?.symbol ?? normalizedSymbol);
      if (payloadSymbol.toUpperCase() === normalizedSymbol) onCandle(candle);
    });
  }

  subscribeMany(
    symbols: string[],
    interval: string,
    onCandle: (symbol: string, candle: Candle) => void,
  ): () => void {
    if (interval === '1M') {
      const stops = [...new Set(symbols.map(normalizeDnseSymbol).filter(Boolean))]
        .map((symbol) => this.subscribeMonthly(symbol, (candle) => onCandle(symbol, candle)));
      return () => stops.forEach((stop) => stop());
    }
    const resolution = this.resolutionFor(interval);
    const normalizedSymbols = [...new Set(symbols.map(normalizeDnseSymbol).filter(Boolean))];
    const symbolSet = new Set(normalizedSymbols);
    const channel = `ohlc.${resolution}.json`;
    return this.subscribeChannels([{ name: channel, symbols: normalizedSymbols }], (data) => {
      const type = data.T;
      if (type !== 'b' && type !== 'bc') return;
      const candle = parseCandle((data.ohlc ?? data.data ?? data) as RawRecord);
      if (!candle) return;
      const payloadSymbol = String(
        data.symbol ?? (data.data as RawRecord | undefined)?.symbol ?? '',
      ).trim().toUpperCase();
      if (symbolSet.has(payloadSymbol)) onCandle(payloadSymbol, candle);
    });
  }

  subscribeQuotes(symbols: string[], onQuote: (quote: QuoteUpdate) => void): () => void {
    const normalizedSymbols = [...new Set(symbols.map(normalizeDnseSymbol).filter(Boolean))];
    const symbolSet = new Set(normalizedSymbols);
    const channels = TOP_PRICE_BOARDS.map((board) => ({
      name: `top_price.${board}.json`,
      symbols: normalizedSymbols,
    }));
    return this.subscribeChannels(channels, (data) => {
      if (data.T !== 'q') return;
      const quote = parseQuote(data);
      if (quote && symbolSet.has(quote.symbol)) onQuote(quote);
    });
  }

  private subscribeChannels(
    channels: DnseChannel[],
    onMessage: (data: RawRecord) => void,
  ): () => void {
    this.assertReady();
    const normalizedChannels = channels.flatMap((channel) => {
      const symbols = [...new Set(channel.symbols.map(normalizeDnseSymbol).filter(Boolean))];
      return channel.name && symbols.length > 0 ? [{ name: channel.name, symbols }] : [];
    });
    const id = this.nextSubscriptionId++;
    this.subscriptions.set(id, { channels: normalizedChannels, onMessage });
    const addedChannels = this.retainChannels(normalizedChannels);
    if (this.wsAuthenticated) this.sendChannelAction('subscribe', addedChannels);
    this.ensureRealtimeSocket();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const subscription = this.subscriptions.get(id);
      if (!subscription) return;
      this.subscriptions.delete(id);
      const removedChannels = this.releaseChannels(subscription.channels);
      if (this.wsAuthenticated) this.sendChannelAction('unsubscribe', removedChannels);
      if (this.subscriptions.size === 0) this.closeRealtimeSocket();
    };
  }

  private channelKey(name: string, symbol: string): string {
    return `${name}\u0000${symbol}`;
  }

  private retainChannels(channels: DnseChannel[]): DnseChannel[] {
    const added = new Map<string, Set<string>>();
    for (const channel of channels) {
      for (const symbol of channel.symbols) {
        const key = this.channelKey(channel.name, symbol);
        const count = this.channelRefs.get(key) ?? 0;
        this.channelRefs.set(key, count + 1);
        if (count === 0) {
          const symbols = added.get(channel.name) ?? new Set<string>();
          symbols.add(symbol);
          added.set(channel.name, symbols);
        }
      }
    }
    return [...added].map(([name, symbols]) => ({ name, symbols: [...symbols] }));
  }

  private releaseChannels(channels: DnseChannel[]): DnseChannel[] {
    const removed = new Map<string, Set<string>>();
    for (const channel of channels) {
      for (const symbol of channel.symbols) {
        const key = this.channelKey(channel.name, symbol);
        const count = this.channelRefs.get(key) ?? 0;
        if (count <= 1) {
          this.channelRefs.delete(key);
          const symbols = removed.get(channel.name) ?? new Set<string>();
          symbols.add(symbol);
          removed.set(channel.name, symbols);
        } else {
          this.channelRefs.set(key, count - 1);
        }
      }
    }
    return [...removed].map(([name, symbols]) => ({ name, symbols: [...symbols] }));
  }

  private activeChannels(): DnseChannel[] {
    const active = new Map<string, string[]>();
    for (const key of this.channelRefs.keys()) {
      const [name, symbol] = key.split('\u0000');
      const symbols = active.get(name) ?? [];
      symbols.push(symbol);
      active.set(name, symbols);
    }
    return [...active].map(([name, symbols]) => ({ name, symbols }));
  }

  private emitRealtimeState(state: DnseRealtimeState, detail?: string): void {
    this.realtimeState = state;
    for (const listener of this.realtimeListeners) listener(state, detail);
  }

  private clearRealtimeTimers(): void {
    if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
    if (this.wsHeartbeatTimer) clearInterval(this.wsHeartbeatTimer);
    if (this.wsConnectTimer) clearTimeout(this.wsConnectTimer);
    if (this.wsWelcomeTimer) clearTimeout(this.wsWelcomeTimer);
    if (this.wsAuthTimer) clearTimeout(this.wsAuthTimer);
    this.wsReconnectTimer = null;
    this.wsHeartbeatTimer = null;
    this.wsConnectTimer = null;
    this.wsWelcomeTimer = null;
    this.wsAuthTimer = null;
  }

  private sendRealtime(payload: RawRecord, socket = this.ws): void {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }

  private sendChannelAction(action: 'subscribe' | 'unsubscribe', channels: DnseChannel[]): void {
    if (channels.length === 0) return;
    this.sendRealtime({ action, channels });
  }

  private ensureRealtimeSocket(): void {
    if (this.subscriptions.size === 0) return;
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) return;
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }

    const url = absoluteWebSocketUrl(this.wsBase, '/v1/stream?encoding=json');
    const socket = new WebSocket(url);
    this.ws = socket;
    this.wsAuthenticated = false;
    this.wsAuthStarted = false;
    this.emitRealtimeState('connecting');

    let terminalError: string | null = null;
    const failConnection = (detail: string) => {
      if (this.ws !== socket || terminalError) return;
      terminalError = detail;
      this.emitRealtimeState('error', detail);
      if (socket.readyState < WebSocket.CLOSING) socket.close(4000, 'DNSE realtime connection failed');
    };

    this.wsConnectTimer = setTimeout(() => {
      failConnection('Timed out while opening the DNSE realtime WebSocket');
    }, 10000);

    const sendAuth = async () => {
      if (this.ws !== socket || this.wsAuthStarted || socket.readyState !== WebSocket.OPEN) return;
      this.wsAuthStarted = true;
      if (this.wsWelcomeTimer) clearTimeout(this.wsWelcomeTimer);
      this.wsWelcomeTimer = null;
      this.emitRealtimeState('authenticating');
      try {
        const auth = await this.wsAuthMessage();
        if (this.ws === socket) {
          this.sendRealtime(auth, socket);
          this.wsAuthTimer = setTimeout(() => {
            failConnection('DNSE realtime authentication timed out');
          }, 10000);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn('[DNSE realtime] Cannot sign WebSocket authentication:', detail);
        failConnection(detail);
      }
    };

    socket.onopen = () => {
      if (this.ws !== socket) return;
      if (this.wsConnectTimer) clearTimeout(this.wsConnectTimer);
      this.wsConnectTimer = null;
      this.wsWelcomeTimer = setTimeout(() => void sendAuth(), 1500);
      this.wsHeartbeatTimer = setInterval(() => this.sendRealtime({ action: 'ping' }, socket), 25000);
    };

    socket.onmessage = (event) => {
      void (async () => {
        const data = await readWsJson(event.data as string | Blob | ArrayBuffer);
        if (!data || this.ws !== socket) return;
        const action = String(data.action ?? data.a ?? '').toLowerCase();
        if (!this.wsAuthStarted && (data.session_id || data.sid || action === 'welcome')) {
          await sendAuth();
          return;
        }
        if (action === 'ping') {
          this.sendRealtime({ action: 'pong' }, socket);
          return;
        }
        if (action === 'auth_success') {
          this.wsAuthenticated = true;
          if (this.wsWelcomeTimer) clearTimeout(this.wsWelcomeTimer);
          if (this.wsAuthTimer) clearTimeout(this.wsAuthTimer);
          this.wsWelcomeTimer = null;
          this.wsAuthTimer = null;
          this.sendChannelAction('subscribe', this.activeChannels());
          this.emitRealtimeState('connected');
          return;
        }
        if (action === 'auth_error' || action === 'auth_failure') {
          const detail = String(data.message ?? data.error ?? data.code ?? action);
          console.warn('[DNSE realtime] Authentication error:', detail);
          failConnection(detail);
          return;
        }
        if (action === 'error') {
          const detail = String(data.message ?? data.error ?? data.code ?? action);
          if (!this.wsAuthenticated) {
            failConnection(detail);
            return;
          }
          // A rejected subscription is channel-scoped. The authenticated
          // transport and other valid channels remain usable.
          console.warn('[DNSE realtime] Subscription error:', detail, data);
          return;
        }
        for (const subscription of this.subscriptions.values()) subscription.onMessage(data);
      })();
    };

    socket.onerror = () => {
      if (this.ws !== socket) return;
      console.warn('[DNSE realtime] WebSocket transport error.');
      failConnection('Không mở được DNSE realtime WebSocket. Kiểm tra WS URL, firewall/VPN hoặc trạng thái websocket DNSE.');
    };

    socket.onclose = (event) => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.wsAuthenticated = false;
      this.wsAuthStarted = false;
      if (this.wsConnectTimer) clearTimeout(this.wsConnectTimer);
      if (this.wsHeartbeatTimer) clearInterval(this.wsHeartbeatTimer);
      if (this.wsWelcomeTimer) clearTimeout(this.wsWelcomeTimer);
      if (this.wsAuthTimer) clearTimeout(this.wsAuthTimer);
      this.wsConnectTimer = null;
      this.wsHeartbeatTimer = null;
      this.wsWelcomeTimer = null;
      this.wsAuthTimer = null;
      if (this.subscriptions.size === 0) {
        this.emitRealtimeState('idle');
        return;
      }
      const detail = event.reason || `WebSocket closed (${event.code})`;
      if (!terminalError) this.emitRealtimeState('reconnecting', detail);
      this.wsReconnectTimer = setTimeout(() => {
        this.wsReconnectTimer = null;
        this.ensureRealtimeSocket();
      }, 2000);
    };
  }

  private closeRealtimeSocket(): void {
    this.clearRealtimeTimers();
    const socket = this.ws;
    this.ws = null;
    this.wsAuthenticated = false;
    this.wsAuthStarted = false;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'No active subscriptions');
    this.emitRealtimeState('idle');
  }

  async testConnection(symbol = 'HPG'): Promise<void> {
    await this.getHistory(symbol, '1m', 1);
  }

  private async getMonthlyHistory(symbol: string, limit: number, range?: HistoryRange): Promise<Candle[]> {
    const now = Math.floor(Date.now() / 1000);
    const sourceRange = range
      ? {
          from: intervalStart(Math.min(range.from, range.to), '1M', VN_OFFSET_MINUTES),
          to: Math.min(now, nextIntervalStart(Math.max(range.from, range.to), '1M', VN_OFFSET_MINUTES) - 1),
        }
      : undefined;
    const dailyLimit = Math.min(20000, Math.max(60, limit * 24 + 31));
    const daily = await this.getHistory(symbol, '1d', dailyLimit, sourceRange);
    return aggregateCalendarCandles(daily, '1M', VN_OFFSET_MINUTES).slice(-limit);
  }

  private subscribeMonthly(symbol: string, onCandle: (candle: Candle) => void): () => void {
    const dailyByTime = new Map<number, Candle>();
    let active = true;
    const emit = () => {
      if (!active) return;
      const monthly = aggregateCalendarCandles([...dailyByTime.values()], '1M', VN_OFFSET_MINUTES);
      const candle = monthly[monthly.length - 1];
      if (candle) onCandle(candle);
    };

    void this.getHistory(symbol, '1d', 45)
      .then((candles) => {
        if (!active) return;
        // Khong de history tre ghi de candle realtime moi hon.
        for (const candle of candles) {
          if (!dailyByTime.has(candle.time)) dailyByTime.set(candle.time, candle);
        }
        emit();
      })
      .catch(() => undefined);

    const stop = this.subscribe(symbol, '1d', (candle) => {
      dailyByTime.set(candle.time, candle);
      const cutoff = intervalStart(candle.time, '1M', VN_OFFSET_MINUTES) - 40 * 86400;
      for (const time of dailyByTime.keys()) if (time < cutoff) dailyByTime.delete(time);
      emit();
    });
    return () => {
      active = false;
      stop();
    };
  }

  private assertReady(): void {
    if (this.useProxyCredentials && this.usesLocalRestProxy() && this.usesLocalWsProxy()) return;
    if (!this.apiKey || !this.apiSecret) throw new Error('Chưa cấu hình API Key/Secret DNSE');
  }

  private resolutionFor(interval: string): string {
    const resolution = RESOLUTION_BY_INTERVAL[interval];
    if (!resolution) throw new Error(`DNSE chưa hỗ trợ khung ${interval}`);
    return resolution;
  }

  private async signedHeaders(method: string, path: string): Promise<HeadersInit> {
    const dateValue = formatDateHeader(new Date());
    const nonce = nonceHex();
    const signingString = `(request-target): ${method.toLowerCase()} ${path}\ndate: ${dateValue}\nnonce: ${nonce}`;
    const signature = encodeURIComponent(bytesToBase64(await hmacSha256(this.apiSecret, signingString)));
    return {
      Date: dateValue,
      'X-Signature': `Signature keyId="${this.apiKey}",algorithm="hmac-sha256",headers="(request-target) date",signature="${signature}",nonce="${nonce}"`,
      'x-api-key': this.apiKey,
    };
  }

  private usesLocalRestProxy(): boolean {
    return this.restBase === '/dnse-api' || this.restBase.endsWith('/dnse-api');
  }

  private usesLocalWsProxy(): boolean {
    try {
      return new URL(absoluteWebSocketUrl(this.wsBase, '')).pathname.replace(/\/$/, '').endsWith('/dnse-ws');
    } catch {
      return this.wsBase === '/dnse-ws' || this.wsBase.endsWith('/dnse-ws');
    }
  }

  private async restHeaders(method: string, path: string): Promise<HeadersInit> {
    if (!this.usesLocalRestProxy()) return this.signedHeaders(method, path);
    if (this.useProxyCredentials) return {};
    return {
      'x-dnse-api-key': this.apiKey,
      'x-dnse-api-secret': this.apiSecret,
    };
  }

  private async wsAuthMessage(): Promise<RawRecord> {
    if (this.usesLocalWsProxy()) {
      const response = await fetch('/dnse-auth', {
        method: 'POST',
        headers: this.useProxyCredentials
          ? {}
          : {
            'x-dnse-api-key': this.apiKey,
            'x-dnse-api-secret': this.apiSecret,
          },
      });
      const payload = await response.json().catch(() => null) as RawRecord | null;
      if (!response.ok) {
        throw new Error(String(payload?.message ?? `DNSE auth proxy HTTP ${response.status}`));
      }
      if (!payload || payload.action !== 'auth' || !payload.signature) {
        throw new Error('DNSE auth proxy returned an invalid response');
      }
      return payload;
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = String(Date.now() * 1000);
    const message = `${this.apiKey}:${timestamp}:${nonce}`;
    return {
      action: 'auth',
      api_key: this.apiKey,
      signature: bytesToHex(await hmacSha256(this.apiSecret, message)),
      timestamp,
      nonce,
    };
  }
}
