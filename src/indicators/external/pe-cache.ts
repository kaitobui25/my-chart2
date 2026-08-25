import type { PeQuarter } from './pe-model';

const DEFAULT_BASE_URL = '/stockdata-api';

export interface PeFundamentalsRecord {
  symbol: string;
  source: string;
  fetchedAt: number;
  quarters: PeQuarter[];
}

export interface PeIncomingQuarter {
  period: string;
  periodEnd: number;
  trailingEps: number;
  peRatio: number | null;
}

export interface PeIncomingPayload {
  symbol: string;
  source: string;
  quarters: PeIncomingQuarter[];
}

export interface PeFundamentalsCacheOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function validNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeRecord(value: unknown): PeFundamentalsRecord | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Partial<PeFundamentalsRecord>;
  const symbol = normalizeSymbol(String(input.symbol ?? ''));
  if (!symbol || !validNumber(input.fetchedAt) || !Array.isArray(input.quarters)) return null;

  const quarters: PeQuarter[] = [];
  for (const raw of input.quarters) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Partial<PeQuarter>;
    const period = String(item.period ?? '').trim().toUpperCase();
    if (!/^\d{4}-Q[1-4]$/.test(period)) continue;
    if (!validNumber(item.periodEnd) || !validNumber(item.trailingEps) || !validNumber(item.firstObservedAt)) continue;
    const peRatio = item.peRatio === null || item.peRatio === undefined
      ? null
      : validNumber(item.peRatio)
        ? item.peRatio
        : null;
    quarters.push({
      period,
      periodEnd: item.periodEnd,
      trailingEps: item.trailingEps,
      peRatio,
      firstObservedAt: item.firstObservedAt,
    });
  }
  quarters.sort((left, right) => left.periodEnd - right.periodEnd);
  return {
    symbol,
    source: String(input.source ?? 'vnstock-unified'),
    fetchedAt: input.fetchedAt,
    quarters,
  };
}

/**
 * Merge a refresh while preserving both the earliest observation timestamp and
 * historical quarters that have rolled out of Vnstock Free's recent-period window.
 */
export function mergePeFundamentals(
  existing: PeFundamentalsRecord | null,
  incoming: PeIncomingPayload,
  observedAt: number,
): PeFundamentalsRecord {
  const symbol = normalizeSymbol(incoming.symbol);
  const previousQuarters = existing?.symbol === symbol ? existing.quarters : [];
  const previous = new Map(previousQuarters.map((item) => [item.period, item]));
  const merged = new Map(previousQuarters.map((item) => [item.period, { ...item }]));

  for (const raw of incoming.quarters) {
    const period = raw.period.trim().toUpperCase();
    if (!/^\d{4}-Q[1-4]$/.test(period)) continue;
    if (!validNumber(raw.periodEnd) || !validNumber(raw.trailingEps)) continue;
    const old = previous.get(period);
    merged.set(period, {
      period,
      periodEnd: raw.periodEnd,
      trailingEps: raw.trailingEps,
      peRatio: validNumber(raw.peRatio) ? raw.peRatio : null,
      firstObservedAt: Math.min(old?.firstObservedAt ?? observedAt, observedAt),
    });
  }

  return {
    symbol,
    source: incoming.source || existing?.source || 'vnstock-unified',
    fetchedAt: observedAt,
    quarters: [...merged.values()].sort((left, right) => left.periodEnd - right.periodEnd),
  };
}

export class PeFundamentalsCache {
  readonly available = true;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PeFundamentalsCacheOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async get(symbol: string): Promise<PeFundamentalsRecord | null> {
    const normalized = normalizeSymbol(symbol);
    if (!normalized) return null;
    const response = await this.fetchImpl(
      `${this.baseUrl}/pe/quarterly?symbol=${encodeURIComponent(normalized)}`,
    );
    if (!response.ok) throw new Error(`Unable to read SQLite P/E cache: HTTP ${response.status}`);
    const record = normalizeRecord(await response.json());
    return record && record.quarters.length > 0 ? record : null;
  }

  async put(record: PeFundamentalsRecord): Promise<void> {
    const normalized = normalizeRecord(record);
    if (!normalized) return;
    const response = await this.fetchImpl(`${this.baseUrl}/pe/quarterly`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(normalized),
    });
    if (!response.ok) throw new Error(`Unable to write SQLite P/E cache: HTTP ${response.status}`);
  }
}
