import type { Candle } from '../../src/core/types';
import type { Datafeed, HistoryRange, SymbolSearchResult } from '../../src/datafeed';

export interface FiinQuantHealth {
  ok: boolean;
  configured: boolean;
  loggedIn: boolean;
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

/**
 * FiinQuant reference datafeed backed by the local Python sidecar example.
 * The application supplies the sidecar URL for its local or private-network
 * deployment. Authentication and caching remain outside the browser adapter.
 */
export class FiinQuantDatafeed implements Datafeed {
  readonly name = 'FiinQuant';
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly streamSubscriptions = new Map<string, {
    symbol: string;
    interval: string;
    listeners: Set<(candle: Candle) => void>;
  }>();
  private streamSocket: WebSocket | null = null;
  private streamAuthenticated = false;
  private streamRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly realtimeConnectedListeners = new Set<() => void>();
  private disposed = false;

  constructor(baseUrl = '/fiinquant-api', token = '') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  private sidecarHeaders(extra: Record<string, string> = {}): HeadersInit {
    const headers: Record<string, string> = { ...extra };
    if (this.token) headers['X-L2Chart-Sidecar-Token'] = this.token;
    return headers;
  }

  async health(): Promise<FiinQuantHealth> {
    const res = await fetch(`${this.baseUrl}/health`, {
      headers: this.sidecarHeaders(),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`sidecar HTTP ${res.status}`);
    return res.json();
  }

  async login(username: string, password: string): Promise<{ ok: boolean; loggedIn: boolean }> {
    const url = new URL(`${this.baseUrl}/session`, window.location.origin);
    let res: Response;
    try {
      res = await fetch(url, {
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
    const url = new URL(`${this.baseUrl}/history`, window.location.origin);
    url.searchParams.set('symbol', symbol.trim().toUpperCase());
    url.searchParams.set('interval', interval);
    url.searchParams.set('limit', String(limit));
    if (range) {
      url.searchParams.set('from', String(range.from));
      url.searchParams.set('to', String(range.to));
    }
    let res: Response;
    try {
      res = await fetch(url, {
        headers: this.sidecarHeaders(),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error(`Cannot reach the FiinQuant sidecar at ${this.baseUrl}. Start the reference sidecar in examples/sidecars/fiinquant.`);
    }
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(String((payload as { message?: string }).message ?? `HTTP ${res.status}`));
    }
    return ((payload as { candles?: Candle[] }).candles ?? [])
      .map((c) => this.validCandle(c))
      .filter((c): c is Candle => c !== null)
      .filter((c) => !range || (c.time >= range.from && c.time <= range.to));
  }

  async searchSymbols(query: string, limit = 20): Promise<SymbolSearchResult[]> {
    const url = new URL(`${this.baseUrl}/symbols`, window.location.origin);
    url.searchParams.set('q', query.trim().toUpperCase());
    url.searchParams.set('limit', String(Math.min(100, Math.max(1, limit))));
    const res = await fetch(url, {
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

  private ensureStreamSocket(): void {
    if (this.disposed || this.streamSubscriptions.size === 0) return;
    if (this.streamSocket?.readyState === WebSocket.OPEN
      || this.streamSocket?.readyState === WebSocket.CONNECTING) return;

    const wsUrl = new URL(`${this.baseUrl}/stream`, window.location.origin);
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
