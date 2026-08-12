export interface PeValuationPoint {
  time: number;
  pe: number | null;
  pb: number | null;
}

export interface PeValuationCoverage {
  from: number;
  to: number;
}

export interface PeValuationRecord {
  symbol: string;
  source: string;
  fetchedAt: number;
  coverage: PeValuationCoverage[];
  points: PeValuationPoint[];
}

export interface PeIncomingValuationPayload {
  symbol: string;
  source: string;
  points: PeValuationPoint[];
}

const DB_NAME = 'l2chart.valuations.v1';
const STORE_NAME = 'stock-daily';
const DB_VERSION = 1;

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeCoverage(items: readonly PeValuationCoverage[]): PeValuationCoverage[] {
  const ordered = items
    .filter((item) => finiteNumber(item.from) && finiteNumber(item.to) && item.from <= item.to)
    .map((item) => ({ from: Math.floor(item.from), to: Math.floor(item.to) }))
    .sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: PeValuationCoverage[] = [];
  for (const item of ordered) {
    const previous = merged[merged.length - 1];
    if (!previous || item.from > previous.to + 1) {
      merged.push({ ...item });
      continue;
    }
    previous.to = Math.max(previous.to, item.to);
  }
  return merged;
}

function normalizePoints(items: readonly PeValuationPoint[]): PeValuationPoint[] {
  const byTime = new Map<number, PeValuationPoint>();
  for (const item of items) {
    if (!finiteNumber(item.time)) continue;
    const time = Math.floor(item.time);
    const pe = item.pe === null ? null : finiteNumber(item.pe) ? item.pe : null;
    const pb = item.pb === null ? null : finiteNumber(item.pb) ? item.pb : null;
    if (pe === null && pb === null) continue;
    byTime.set(time, { time, pe, pb });
  }
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

function normalizeRecord(value: unknown): PeValuationRecord | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Partial<PeValuationRecord>;
  const symbol = normalizeSymbol(String(input.symbol ?? ''));
  if (!symbol || !finiteNumber(input.fetchedAt) || !Array.isArray(input.coverage) || !Array.isArray(input.points)) {
    return null;
  }
  return {
    symbol,
    source: String(input.source ?? 'fiinquant-stock-valuation'),
    fetchedAt: Math.floor(input.fetchedAt),
    coverage: normalizeCoverage(input.coverage),
    points: normalizePoints(input.points),
  };
}

export function mergePeValuation(
  existing: PeValuationRecord | null,
  incoming: PeIncomingValuationPayload,
  requestedFrom: number,
  requestedTo: number,
  observedAt: number,
): PeValuationRecord {
  const symbol = normalizeSymbol(incoming.symbol);
  const previous = existing?.symbol === symbol ? existing : null;
  return {
    symbol,
    source: incoming.source || previous?.source || 'fiinquant-stock-valuation',
    fetchedAt: observedAt,
    coverage: normalizeCoverage([
      ...(previous?.coverage ?? []),
      { from: Math.min(requestedFrom, requestedTo), to: Math.max(requestedFrom, requestedTo) },
    ]),
    points: normalizePoints([...(previous?.points ?? []), ...incoming.points]),
  };
}

export function missingPeValuationRanges(
  record: PeValuationRecord | null,
  requestedFrom: number,
  requestedTo: number,
): PeValuationCoverage[] {
  const from = Math.min(requestedFrom, requestedTo);
  const to = Math.max(requestedFrom, requestedTo);
  if (!record) return [{ from, to }];
  const coverage = normalizeCoverage(record.coverage);
  const missing: PeValuationCoverage[] = [];
  let cursor = from;
  for (const item of coverage) {
    if (item.to < cursor) continue;
    if (item.from > to) break;
    if (item.from > cursor) missing.push({ from: cursor, to: Math.min(to, item.from - 1) });
    cursor = Math.max(cursor, item.to + 1);
    if (cursor > to) break;
  }
  if (cursor <= to) missing.push({ from: cursor, to });
  return missing;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'symbol' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open P/E valuation IndexedDB cache'));
  });
}

export class PeValuationCache {
  readonly available = typeof indexedDB !== 'undefined';
  private databasePromise: Promise<IDBDatabase> | null = null;

  private database(): Promise<IDBDatabase> {
    if (!this.available) return Promise.reject(new Error('IndexedDB is unavailable'));
    this.databasePromise ??= openDatabase();
    return this.databasePromise;
  }

  async get(symbol: string): Promise<PeValuationRecord | null> {
    if (!this.available) return null;
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(normalizeSymbol(symbol));
      request.onsuccess = () => resolve(normalizeRecord(request.result));
      request.onerror = () => reject(request.error ?? new Error('Unable to read P/E valuation cache'));
    });
  }

  async put(record: PeValuationRecord): Promise<void> {
    if (!this.available) return;
    const normalized = normalizeRecord(record);
    if (!normalized) return;
    const db = await this.database();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(normalized);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Unable to write P/E valuation cache'));
      tx.onabort = () => reject(tx.error ?? new Error('P/E valuation cache write aborted'));
    });
  }
}
