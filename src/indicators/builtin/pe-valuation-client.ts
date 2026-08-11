import {
  PeValuationCache,
  mergePeValuation,
  missingPeValuationRanges,
  type PeIncomingValuationPayload,
  type PeValuationPoint,
  type PeValuationRecord,
} from './pe-valuation-cache';

const DEFAULT_BASE_URL = '/fiinquant-api';
const REQUEST_TIMEOUT_MS = 20_000;

export interface PeValuationCacheApi {
  get(symbol: string): Promise<PeValuationRecord | null>;
  put(record: PeValuationRecord): Promise<void>;
}

export interface PeValuationRepositoryOptions {
  baseUrl?: string;
  cache?: PeValuationCacheApi;
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

function parsePayload(value: unknown, requestedSymbol: string): PeIncomingValuationPayload {
  if (!value || typeof value !== 'object') throw new Error('Invalid FiinQuant valuation response');
  const raw = value as Record<string, unknown>;
  const symbol = normalizeSymbol(String(raw.symbol ?? requestedSymbol));
  if (!symbol || symbol !== requestedSymbol) throw new Error('FiinQuant valuation response symbol mismatch');
  if (!Array.isArray(raw.points)) throw new Error('FiinQuant valuation response has no points');

  const points: PeValuationPoint[] = [];
  for (const item of raw.points) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const time = finiteNumber(row.time ?? row.timestamp);
    const pe = finiteNumber(row.pe ?? row.peRatio ?? row.pe_ratio);
    const pb = finiteNumber(row.pb ?? row.pbRatio ?? row.pb_ratio);
    if (time === null || (pe === null && pb === null)) continue;
    points.push({ time: Math.floor(time), pe, pb });
  }

  return {
    symbol,
    source: String(raw.source ?? 'fiinquant-stock-valuation'),
    points,
  };
}

export class PeValuationRepository {
  private readonly baseUrl: string;
  private readonly cache: PeValuationCacheApi;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly inFlight = new Map<string, Promise<PeValuationRecord>>();

  constructor(options: PeValuationRepositoryOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.cache = options.cache ?? new PeValuationCache();
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  getCached(symbol: string): Promise<PeValuationRecord | null> {
    return this.cache.get(normalizeSymbol(symbol));
  }

  missingRanges(record: PeValuationRecord | null, from: number, to: number) {
    return missingPeValuationRanges(record, from, to);
  }

  async fetchAndCache(symbol: string, from: number, to: number, force = false): Promise<PeValuationRecord> {
    const normalized = normalizeSymbol(symbol);
    if (!normalized) throw new Error('Missing ticker for FiinQuant valuation request');
    const requestedFrom = Math.floor(Math.min(from, to));
    const requestedTo = Math.floor(Math.max(from, to));
    const cached = await this.cache.get(normalized).catch(() => null);
    const ranges = force
      ? [{ from: requestedFrom, to: requestedTo }]
      : missingPeValuationRanges(cached, requestedFrom, requestedTo);
    if (ranges.length === 0 && cached) return cached;

    let record = cached;
    for (const range of ranges) {
      record = await this.fetchRange(normalized, range.from, range.to, record);
    }
    if (!record) {
      return {
        symbol: normalized,
        source: 'fiinquant-stock-valuation',
        fetchedAt: this.now(),
        coverage: [{ from: requestedFrom, to: requestedTo }],
        points: [],
      };
    }
    return record;
  }

  private fetchRange(
    symbol: string,
    from: number,
    to: number,
    existing: PeValuationRecord | null,
  ): Promise<PeValuationRecord> {
    const key = `${symbol}:${from}:${to}`;
    const current = this.inFlight.get(key);
    if (current) return current;
    const request = this.requestRange(symbol, from, to, existing).finally(() => {
      if (this.inFlight.get(key) === request) this.inFlight.delete(key);
    });
    this.inFlight.set(key, request);
    return request;
  }

  private async requestRange(
    symbol: string,
    from: number,
    to: number,
    existing: PeValuationRecord | null,
  ): Promise<PeValuationRecord> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const query = new URLSearchParams({ symbol, from: String(from), to: String(to) });
      const response = await this.fetchImpl(`${this.baseUrl}/valuation/stock?${query}`, {
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        const message = payload && typeof payload === 'object'
          ? String((payload as Record<string, unknown>).message ?? `HTTP ${response.status}`)
          : `HTTP ${response.status}`;
        throw new Error(message);
      }
      const incoming = parsePayload(payload, symbol);
      const merged = mergePeValuation(existing, incoming, from, to, this.now());
      await this.cache.put(merged).catch(() => undefined);
      return merged;
    } finally {
      clearTimeout(timeout);
    }
  }
}
