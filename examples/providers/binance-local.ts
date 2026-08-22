import type { Candle } from '../../src/core/types';
import type { Datafeed, HistoryRange, SymbolSearchResult } from '../../src/datafeed';

export interface BinanceLocalDatafeedOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface BinanceLocalStatus {
  symbol: string;
  installed: boolean;
  interval?: string;
  firstTime?: number;
  lastTime?: number;
  lastImportAt?: number;
  lastRefreshAt?: number | null;
  rows?: number;
  downloadedRows?: number;
  attemptedArchives?: number;
}

interface ApiPayload extends Partial<BinanceLocalStatus> {
  ok?: boolean;
  code?: string;
  message?: string;
  candles?: unknown[];
  symbols?: unknown[];
}

export const BINANCE_LOCAL_INTERVALS = ['30m', '1h', '4h', '1d', '1w', '1M'] as const;
const SUPPORTED_INTERVALS = new Set<string>(BINANCE_LOCAL_INTERVALS);
const DEFAULT_BASE_URL = 'http://127.0.0.1:8750';

export function normalizeBinanceLocalSymbol(value: string): string {
  let symbol = value.trim().toUpperCase();
  for (const separator of ['/', '-', '_']) symbol = symbol.split(separator).join('');
  symbol = symbol.replace(/\s+/g, '');
  return /^[A-Z0-9]{5,20}$/.test(symbol) ? symbol : '';
}

function parseCandle(value: unknown): Candle | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const time = Number(row.time);
  const open = Number(row.open);
  const high = Number(row.high);
  const low = Number(row.low);
  const close = Number(row.close);
  const volume = Number(row.volume);
  if (![time, open, high, low, close].every(Number.isFinite)) return null;
  if (high < low || high < Math.max(open, close) || low > Math.min(open, close)) return null;
  return {
    time: Math.trunc(time),
    open,
    high,
    low,
    close,
    volume: Number.isFinite(volume) ? volume : undefined,
  };
}

function parseSymbol(value: unknown): SymbolSearchResult | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const symbol = normalizeBinanceLocalSymbol(String(row.symbol ?? ''));
  if (!symbol) return null;
  return {
    symbol,
    name: typeof row.name === 'string' ? row.name : symbol,
    exchange: 'Binance Local Archive',
  };
}

/**
 * PC-first Binance archive datafeed.
 *
 * History/search/status methods only talk to the loopback sidecar. The sidecar
 * itself reaches Binance only from explicit ensureSymbol() or refreshSymbol().
 */
export class BinanceLocalDatafeed implements Datafeed {
  readonly name = 'Binance Local Archive';

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly ensureInFlight = new Map<string, Promise<BinanceLocalStatus>>();

  constructor(options: BinanceLocalDatafeedOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async getCachedHistory(
    symbol: string,
    interval: string,
    limit = 500,
    range?: HistoryRange,
  ): Promise<Candle[]> {
    try {
      return await this.readHistory(symbol, interval, limit, range);
    } catch (error) {
      if (this.errorCode(error) === 'SYMBOL_NOT_INSTALLED') return [];
      throw error;
    }
  }

  getHistory(
    symbol: string,
    interval: string,
    limit = 500,
    range?: HistoryRange,
  ): Promise<Candle[]> {
    return this.readHistory(symbol, interval, limit, range);
  }

  subscribe(_symbol: string, _interval: string, _onCandle: (candle: Candle) => void): () => void {
    return () => undefined;
  }

  subscribeMany(
    _symbols: string[],
    _interval: string,
    _onCandle: (symbol: string, candle: Candle) => void,
  ): () => void {
    return () => undefined;
  }

  async searchSymbols(query: string, limit = 30): Promise<SymbolSearchResult[]> {
    const normalized = normalizeBinanceLocalSymbol(query);
    const params = new URLSearchParams({
      q: query,
      limit: String(Math.max(1, Math.min(limit, 200))),
    });
    const local: SymbolSearchResult[] = [];
    try {
      const { response, payload } = await this.request(`/symbols?${params}`);
      if (response.ok && Array.isArray(payload.symbols)) {
        for (const item of payload.symbols) {
          const parsed = parseSymbol(item);
          if (parsed) local.push(parsed);
        }
      }
    } catch {
      // Typing never reaches Binance and should still work if the sidecar is down.
    }

    if (normalized && !local.some((item) => item.symbol === normalized)) {
      local.push({ symbol: normalized, name: normalized, exchange: 'Binance Local Archive' });
    }
    return local.slice(0, Math.max(1, limit));
  }

  async status(symbol: string): Promise<BinanceLocalStatus> {
    const normalized = this.requireSymbol(symbol);
    const { response, payload } = await this.request(`/status?symbol=${encodeURIComponent(normalized)}`);
    if (!response.ok) throw this.apiError(response, payload);
    return this.asStatus(normalized, payload);
  }

  /** Import a chart-selected symbol only when it is not already on disk. */
  ensureSymbol(symbol: string): Promise<BinanceLocalStatus> {
    const normalized = this.requireSymbol(symbol);
    const existing = this.ensureInFlight.get(normalized);
    if (existing) return existing;

    const operation = (async () => {
      const current = await this.status(normalized);
      if (current.installed) return current;
      const { response, payload } = await this.request('/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: normalized }),
      });
      if (!response.ok) throw this.apiError(response, payload);
      return this.asStatus(normalized, payload);
    })().finally(() => {
      this.ensureInFlight.delete(normalized);
    });

    this.ensureInFlight.set(normalized, operation);
    return operation;
  }

  /** Manual forward update. Nothing calls this automatically. */
  async refreshSymbol(symbol: string): Promise<BinanceLocalStatus> {
    const normalized = this.requireSymbol(symbol);
    const { response, payload } = await this.request('/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: normalized }),
    });
    if (!response.ok) throw this.apiError(response, payload);
    return this.asStatus(normalized, payload);
  }

  private async readHistory(
    symbol: string,
    interval: string,
    limit: number,
    range?: HistoryRange,
  ): Promise<Candle[]> {
    const normalized = this.requireSymbol(symbol);
    this.requireInterval(interval);
    const params = new URLSearchParams({
      symbol: normalized,
      interval,
      limit: String(Math.max(1, Math.min(limit, 50_000))),
    });
    if (range) {
      params.set('from', String(Math.floor(range.from)));
      params.set('to', String(Math.floor(range.to)));
    }

    const { response, payload } = await this.request(`/history?${params}`);
    if (!response.ok) throw this.apiError(response, payload);
    const candles = Array.isArray(payload.candles)
      ? payload.candles.map(parseCandle).filter((item): item is Candle => item !== null)
      : [];
    return candles.sort((left, right) => left.time - right.time);
  }

  private requireSymbol(symbol: string): string {
    const normalized = normalizeBinanceLocalSymbol(symbol);
    if (!normalized) throw new Error(`INVALID_SYMBOL: Invalid Binance symbol: ${symbol}`);
    return normalized;
  }

  private requireInterval(interval: string): void {
    if (!SUPPORTED_INTERVALS.has(interval)) {
      throw new Error(`UNSUPPORTED_INTERVAL: Binance Local Archive supports 30m and above. Unsupported interval: ${interval}`);
    }
  }

  private async request(path: string, init?: RequestInit): Promise<{ response: Response; payload: ApiPayload }> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    let payload: ApiPayload = {};
    try {
      const parsed = await response.json();
      if (parsed && typeof parsed === 'object') payload = parsed as ApiPayload;
    } catch {
      // The HTTP status is still enough to produce a useful local error.
    }
    return { response, payload };
  }

  private apiError(response: Response, payload: ApiPayload): Error {
    const code = payload.code ?? `HTTP_${response.status}`;
    return new Error(`${code}: ${payload.message ?? `Binance Local Archive HTTP ${response.status}`}`);
  }

  private errorCode(error: unknown): string {
    if (!(error instanceof Error)) return '';
    return error.message.split(':', 1)[0];
  }

  private asStatus(symbol: string, payload: ApiPayload): BinanceLocalStatus {
    return {
      symbol,
      installed: payload.installed === true,
      interval: payload.interval,
      firstTime: payload.firstTime,
      lastTime: payload.lastTime,
      lastImportAt: payload.lastImportAt,
      lastRefreshAt: payload.lastRefreshAt,
      rows: payload.rows,
      downloadedRows: payload.downloadedRows,
      attemptedArchives: payload.attemptedArchives,
    };
  }
}
