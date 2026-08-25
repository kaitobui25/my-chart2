import type { InstitutionalFlowMonth } from './institutional-flow-model';

interface ChartFlowPayload {
  symbol?: unknown;
  from?: unknown;
  to?: unknown;
  unit?: unknown;
  months?: unknown;
  error?: unknown;
}

interface ChartFlowMonthPayload {
  period?: unknown;
  foreign_net_value_vnd?: unknown;
  proprietary_net_value_vnd?: unknown;
}

interface CacheEntry {
  expiresAt: number;
  value: InstitutionalFlowMonth[];
}

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

function nullableFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeMonths(payload: ChartFlowPayload): InstitutionalFlowMonth[] {
  if (!Array.isArray(payload.months)) throw new Error('Invalid stock-flow response: months must be an array');
  return payload.months.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const month = raw as ChartFlowMonthPayload;
    if (typeof month.period !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month.period)) return [];
    return [{
      period: month.period,
      foreignNetValueVnd: nullableFiniteNumber(month.foreign_net_value_vnd),
      proprietaryNetValueVnd: nullableFiniteNumber(month.proprietary_net_value_vnd),
    }];
  });
}

export class InstitutionalFlowRepository {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly baseUrl = '/stock-flow-api',
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  ) {}

  async get(symbol: string, from: string, to: string): Promise<InstitutionalFlowMonth[]> {
    const normalizedSymbol = symbol.trim().toUpperCase();
    const key = `${normalizedSymbol}:${from}:${to}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const query = new URLSearchParams({ symbol: normalizedSymbol, from, to });
    const response = await this.fetchImpl(`${this.baseUrl}?${query.toString()}`, {
      signal: AbortSignal.timeout(8_000),
    });
    const payload = await response.json().catch(() => ({})) as ChartFlowPayload;
    if (!response.ok) {
      const detail = typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
      throw new Error(`Stock flow unavailable: ${detail}`);
    }
    const months = normalizeMonths(payload);
    this.cache.set(key, { expiresAt: Date.now() + this.cacheTtlMs, value: months });
    return months;
  }

  clear(): void {
    this.cache.clear();
  }
}

export const institutionalFlowRepository = new InstitutionalFlowRepository();
