import type { PeQuarter } from './pe-model';

const DEFAULT_BASE_URL = '/pe-quarterly-api';
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

export interface PeQuarterlyRecord {
  symbol: string;
  source: string;
  fetchedAt: number;
  quarters: PeQuarter[];
}

interface CacheEntry {
  expiresAt: number;
  value: PeQuarterlyRecord;
}

interface PeQuarterlyPayload {
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

function normalizeRecord(value: unknown, requestedSymbol: string): PeQuarterlyRecord {
  if (!value || typeof value !== 'object') throw new Error('Invalid quarterly P/E response');
  const input = value as PeQuarterlyPayload;
  const symbol = normalizeSymbol(String(input.symbol ?? ''));
  if (!symbol || symbol !== requestedSymbol || !Array.isArray(input.quarters)) {
    throw new Error('Invalid quarterly P/E response');
  }

  const quarters: PeQuarter[] = [];
  for (const raw of input.quarters) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const period = String(item.period ?? '').trim().toUpperCase();
    const periodEnd = finiteNumber(item.periodEnd);
    const trailingEps = finiteNumber(item.trailingEps);
    const peRatio = item.peRatio === null || item.peRatio === undefined ? null : finiteNumber(item.peRatio);
    const firstObservedAt = finiteNumber(item.firstObservedAt);
    if (!/^\d{4}-Q[1-4]$/.test(period) || periodEnd === null || trailingEps === null || firstObservedAt === null) {
      continue;
    }
    quarters.push({ period, periodEnd, trailingEps, peRatio, firstObservedAt });
  }
  quarters.sort((left, right) => left.periodEnd - right.periodEnd);

  return {
    symbol,
    source: String(input.source ?? 'vnstock-unified'),
    fetchedAt: finiteNumber(input.fetchedAt) ?? 0,
    quarters,
  };
}

export class PeQuarterlyRepository {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<PeQuarterlyRecord>>();

  constructor(
    private readonly baseUrl = DEFAULT_BASE_URL,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  ) {}

  get(symbol: string): Promise<PeQuarterlyRecord> {
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

  private async fetchRecord(symbol: string): Promise<PeQuarterlyRecord> {
    const response = await this.fetchImpl(
      `${this.baseUrl}?symbol=${encodeURIComponent(symbol)}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    const payload = await response.json().catch(() => ({})) as PeQuarterlyPayload;
    if (!response.ok) {
      const detail = typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
      throw new Error(`Quarterly P/E unavailable: ${detail}`);
    }
    const record = normalizeRecord(payload, symbol);
    this.cache.set(symbol, { expiresAt: Date.now() + this.cacheTtlMs, value: record });
    return record;
  }
}

export const peQuarterlyRepository = new PeQuarterlyRepository();
