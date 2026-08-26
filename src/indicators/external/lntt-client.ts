import type { LnttQuarter } from './lntt-model';

const DEFAULT_BASE_URL = '/lntt-quarterly-api';
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

export interface LnttQuarterlyRecord {
  symbol: string;
  source: string;
  fetchedAt: number;
  quarters: LnttQuarter[];
}

interface CacheEntry {
  expiresAt: number;
  value: LnttQuarterlyRecord;
}

interface LnttPayload {
  symbol?: unknown;
  source?: unknown;
  fetchedAt?: unknown;
  quarters?: unknown;
  error?: unknown;
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function finiteNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function integer(value: unknown): number | null {
  const numeric = finiteNumber(value);
  return numeric !== null && Number.isInteger(numeric) ? numeric : null;
}

function normalizeRecord(value: unknown, requestedSymbol: string): LnttQuarterlyRecord {
  if (!value || typeof value !== 'object') throw new Error('Invalid LNTT response');
  const input = value as LnttPayload;
  const symbol = normalizeSymbol(String(input.symbol ?? ''));
  if (!symbol || symbol !== requestedSymbol || !Array.isArray(input.quarters)) {
    throw new Error('Invalid LNTT response');
  }

  const quarters: LnttQuarter[] = [];
  for (const raw of input.quarters) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const year = integer(item.year);
    const quarter = integer(item.quarter);
    const profitBeforeTaxVnd = finiteNumber(item.profitBeforeTaxVnd);
    if (year === null || quarter === null || quarter < 1 || quarter > 4 || profitBeforeTaxVnd === null) {
      continue;
    }
    quarters.push({
      period: `${year}Q${quarter}`,
      year,
      quarter,
      profitBeforeTaxVnd,
    });
  }
  quarters.sort((left, right) => left.year - right.year || left.quarter - right.quarter);

  return {
    symbol,
    source: String(input.source ?? 'stockdata'),
    fetchedAt: finiteNumber(input.fetchedAt) ?? 0,
    quarters,
  };
}

export class LnttQuarterlyRepository {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<LnttQuarterlyRecord>>();

  constructor(
    private readonly baseUrl = DEFAULT_BASE_URL,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  ) {}

  get(symbol: string): Promise<LnttQuarterlyRecord> {
    const normalized = normalizeSymbol(symbol);
    const cached = this.cache.get(normalized);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);

    const existing = this.inFlight.get(normalized);
    if (existing) return existing;

    const request = this.fetchRecord(normalized).finally(() => {
      if (this.inFlight.get(normalized) === request) this.inFlight.delete(normalized);
    });
    this.inFlight.set(normalized, request);
    return request;
  }

  clear(): void {
    this.cache.clear();
  }

  private async fetchRecord(symbol: string): Promise<LnttQuarterlyRecord> {
    const response = await this.fetchImpl(
      `${this.baseUrl}?symbol=${encodeURIComponent(symbol)}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    const payload = await response.json().catch(() => ({})) as LnttPayload;
    if (!response.ok) {
      const detail = typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
      throw new Error(`LNTT unavailable: ${detail}`);
    }
    const record = normalizeRecord(payload, symbol);
    this.cache.set(symbol, { expiresAt: Date.now() + this.cacheTtlMs, value: record });
    return record;
  }
}

export const lnttQuarterlyRepository = new LnttQuarterlyRepository();
