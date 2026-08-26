import type { DividendEvent } from './dividend-model';

const DEFAULT_BASE_URL = '/dividend-events-api';
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;

export interface DividendRecord {
  symbol: string;
  source: string;
  events: DividendEvent[];
}

interface CacheEntry {
  expiresAt: number;
  value: DividendRecord;
}

interface DividendPayload {
  symbol?: unknown;
  source?: unknown;
  events?: unknown;
  error?: unknown;
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function positiveNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function normalizeRecord(value: unknown, requestedSymbol: string): DividendRecord {
  if (!value || typeof value !== 'object') throw new Error('Invalid dividend response');
  const payload = value as DividendPayload;
  const symbol = normalizeSymbol(String(payload.symbol ?? ''));
  if (symbol !== requestedSymbol || !Array.isArray(payload.events)) {
    throw new Error('Invalid dividend response');
  }

  const events: DividendEvent[] = [];
  for (const raw of payload.events) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const exDate = String(item.exDate ?? '');
    if (!DATE_RE.test(exDate)) continue;
    const event: DividendEvent = {
      exDate,
      cashVndPerShare: positiveNumber(item.cashVndPerShare),
      cashPercent: positiveNumber(item.cashPercent),
      stockPercent: positiveNumber(item.stockPercent),
      bonusPercent: positiveNumber(item.bonusPercent),
    };
    if (
      event.cashVndPerShare === null
      && event.cashPercent === null
      && event.stockPercent === null
      && event.bonusPercent === null
    ) continue;
    events.push(event);
  }
  events.sort((left, right) => left.exDate.localeCompare(right.exDate));

  return {
    symbol,
    source: String(payload.source ?? 'simplize'),
    events,
  };
}

export class DividendRepository {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<DividendRecord>>();

  constructor(
    private readonly baseUrl = DEFAULT_BASE_URL,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  ) {}

  get(symbol: string): Promise<DividendRecord> {
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

  private async fetchRecord(symbol: string): Promise<DividendRecord> {
    const response = await this.fetchImpl(
      `${this.baseUrl}?symbol=${encodeURIComponent(symbol)}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    const payload = await response.json().catch(() => ({})) as DividendPayload;
    if (!response.ok) {
      const detail = typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
      throw new Error(`Dividend data unavailable: ${detail}`);
    }
    const record = normalizeRecord(payload, symbol);
    this.cache.set(symbol, { expiresAt: Date.now() + this.cacheTtlMs, value: record });
    return record;
  }
}

export const dividendRepository = new DividendRepository();
