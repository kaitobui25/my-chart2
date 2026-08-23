import {
  PeFundamentalsCache,
  mergePeFundamentals,
  type PeFundamentalsRecord,
  type PeIncomingPayload,
  type PeIncomingQuarter,
} from './pe-cache';

const DEFAULT_BASE_URL = '/vnstock-api';
const REQUEST_TIMEOUT_MS = 15_000;

export interface PeCacheApi {
  get(symbol: string): Promise<PeFundamentalsRecord | null>;
  put(record: PeFundamentalsRecord): Promise<void>;
}

export interface PeRepositoryOptions {
  baseUrl?: string;
  cache?: PeCacheApi;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parsePayload(value: unknown, requestedSymbol: string): PeIncomingPayload {
  if (!value || typeof value !== 'object') throw new Error('Invalid Vnstock P/E response');
  const raw = value as Record<string, unknown>;
  const symbol = normalizeSymbol(String(raw.symbol ?? requestedSymbol));
  if (!symbol || symbol !== requestedSymbol) throw new Error('Vnstock P/E response symbol mismatch');
  if (!Array.isArray(raw.quarters)) throw new Error('Vnstock P/E response has no quarter data');

  const quarters: PeIncomingQuarter[] = [];
  for (const item of raw.quarters) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const period = String(row.period ?? '').trim().toUpperCase();
    const periodEnd = finiteNumber(row.periodEnd ?? row.period_end);
    const trailingEps = finiteNumber(row.trailingEps ?? row.trailing_eps);
    const peRatio = finiteNumber(row.peRatio ?? row.pe_ratio);
    if (!/^\d{4}-Q[1-4]$/.test(period) || periodEnd === null || trailingEps === null) continue;
    quarters.push({ period, periodEnd, trailingEps, peRatio });
  }

  return {
    symbol,
    source: String(raw.source ?? 'vnstock-unified'),
    quarters,
  };
}

export class PeFundamentalsRepository {
  private readonly baseUrl: string;
  private readonly cache: PeCacheApi;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly inFlight = new Map<string, Promise<PeFundamentalsRecord>>();

  constructor(options: PeRepositoryOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.cache = options.cache ?? new PeFundamentalsCache();
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  getCached(symbol: string): Promise<PeFundamentalsRecord | null> {
    return this.cache.get(normalizeSymbol(symbol));
  }

  fetchAndCache(symbol: string): Promise<PeFundamentalsRecord> {
    const normalized = normalizeSymbol(symbol);
    if (!normalized) return Promise.reject(new Error('Missing ticker for P/E request'));
    const existing = this.inFlight.get(normalized);
    if (existing) return existing;

    const request = this.fetchFresh(normalized).finally(() => {
      if (this.inFlight.get(normalized) === request) this.inFlight.delete(normalized);
    });
    this.inFlight.set(normalized, request);
    return request;
  }

  private async fetchFresh(symbol: string): Promise<PeFundamentalsRecord> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/fundamentals/pe?symbol=${encodeURIComponent(symbol)}`,
        { signal: controller.signal },
      );
      const payload = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        const message = payload && typeof payload === 'object'
          ? String((payload as Record<string, unknown>).message ?? `HTTP ${response.status}`)
          : `HTTP ${response.status}`;
        throw new Error(message);
      }
      const incoming = parsePayload(payload, symbol);
      const observedAt = this.now();
      const cached = await this.cache.get(symbol).catch(() => null);
      const merged = mergePeFundamentals(cached, incoming, observedAt);
      await this.cache.put(merged).catch(() => undefined);
      return merged;
    } finally {
      clearTimeout(timeout);
    }
  }
}
