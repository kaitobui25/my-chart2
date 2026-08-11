import type { PeQuarter } from './pe-model';

const DB_NAME = 'l2chart.fundamentals.v1';
const STORE_NAME = 'pe';
const DB_VERSION = 1;

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

/** Merge a refresh while preserving the earliest time each period was observed. */
export function mergePeFundamentals(
  existing: PeFundamentalsRecord | null,
  incoming: PeIncomingPayload,
  observedAt: number,
): PeFundamentalsRecord {
  const symbol = normalizeSymbol(incoming.symbol);
  const previous = new Map(
    (existing?.symbol === symbol ? existing.quarters : []).map((item) => [item.period, item]),
  );
  const merged = new Map<string, PeQuarter>();

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

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'symbol' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open P/E IndexedDB cache'));
  });
}

export class PeFundamentalsCache {
  readonly available = typeof indexedDB !== 'undefined';
  private databasePromise: Promise<IDBDatabase> | null = null;

  private database(): Promise<IDBDatabase> {
    if (!this.available) return Promise.reject(new Error('IndexedDB is unavailable'));
    this.databasePromise ??= openDatabase();
    return this.databasePromise;
  }

  async get(symbol: string): Promise<PeFundamentalsRecord | null> {
    if (!this.available) return null;
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(normalizeSymbol(symbol));
      request.onsuccess = () => resolve(normalizeRecord(request.result));
      request.onerror = () => reject(request.error ?? new Error('Unable to read P/E cache'));
    });
  }

  async put(record: PeFundamentalsRecord): Promise<void> {
    if (!this.available) return;
    const normalized = normalizeRecord(record);
    if (!normalized) return;
    const db = await this.database();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(normalized);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Unable to write P/E cache'));
      tx.onabort = () => reject(tx.error ?? new Error('P/E cache write aborted'));
    });
  }
}
