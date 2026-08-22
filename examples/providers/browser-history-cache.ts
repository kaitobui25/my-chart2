import type { Candle } from '../../src/core/types';
import type { HistoryRange } from '../../src/datafeed';

export type BrowserHistorySource = string;
export type BrowserCacheCoverage = HistoryRange;

export interface BrowserHistoryCacheApi {
  readonly available: boolean;
  coverage(source: BrowserHistorySource, symbol: string, interval: string): Promise<BrowserCacheCoverage[]>;
  readLatest(
    source: BrowserHistorySource,
    symbol: string,
    interval: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Candle[]>;
  readRange(
    source: BrowserHistorySource,
    symbol: string,
    interval: string,
    from: number,
    to: number,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<Candle[]>;
  write(
    source: BrowserHistorySource,
    symbol: string,
    interval: string,
    candles: Candle[],
    signal?: AbortSignal,
  ): Promise<void>;
  markCoverage(
    source: BrowserHistorySource,
    symbol: string,
    interval: string,
    range: BrowserCacheCoverage,
  ): Promise<void>;
  clearSource(source: BrowserHistorySource): Promise<void>;
}

interface StoredCandle extends Candle {
  source: BrowserHistorySource;
  symbol: string;
  interval: string;
}

interface StoredSeries {
  key: string;
  source: BrowserHistorySource;
  symbol: string;
  interval: string;
  firstTime: number;
  lastTime: number;
  coverage: BrowserCacheCoverage[];
  updatedAt: number;
}

interface StoredMeta {
  key: string;
  updatedAt: number;
}

interface LegacyBinanceCandle extends Candle {
  market: 'spot' | 'usdm';
  symbol: string;
  interval: string;
}

interface LegacyBinanceSeries {
  key: string;
  market: 'spot' | 'usdm';
  symbol: string;
  interval: string;
  firstTime: number;
  lastTime: number;
  updatedAt: number;
}

export const BINANCE_SPOT_HISTORY_SOURCE = 'binance:spot';
export const BINANCE_USDM_HISTORY_SOURCE = 'binance:usdm';
export const FIINQUANT_ADJUSTED_HISTORY_SOURCE = 'fiinquant:adjusted';

const DATABASE_NAME = 'l2chart.market.history.v1';
const DATABASE_VERSION = 2;
const LEGACY_BINANCE_DATABASE_NAME = 'l2chart.binance.history.v1';
const CANDLES_STORE = 'candles';
const SERIES_STORE = 'series';
const META_STORE = 'meta';
const LEGACY_BINANCE_MIGRATION_KEY = 'legacy-binance-history-v1';
const MIN_TIME = 0;
const MAX_TIME = Number.MAX_SAFE_INTEGER;
let legacyBinanceMigrationPromise: Promise<void> | null = null;

function normalizedSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function seriesKey(source: BrowserHistorySource, symbol: string, interval: string): string {
  return `${source}\u0000${normalizedSymbol(symbol)}\u0000${interval}`;
}

function normalizeCoverage(range: BrowserCacheCoverage): BrowserCacheCoverage | null {
  const from = Number(range.from);
  const to = Number(range.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return { from: Math.min(from, to), to: Math.max(from, to) };
}

export function mergeHistoryCoverage(ranges: BrowserCacheCoverage[]): BrowserCacheCoverage[] {
  const ordered = ranges
    .map(normalizeCoverage)
    .filter((range): range is BrowserCacheCoverage => range !== null)
    .sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: BrowserCacheCoverage[] = [];
  for (const range of ordered) {
    const previous = merged[merged.length - 1];
    if (!previous || range.from > previous.to + 1) {
      merged.push({ ...range });
      continue;
    }
    previous.to = Math.max(previous.to, range.to);
  }
  return merged;
}

export function missingHistoryCoverage(
  coverage: BrowserCacheCoverage[],
  requested: BrowserCacheCoverage,
): BrowserCacheCoverage[] {
  const target = normalizeCoverage(requested);
  if (!target) return [];
  const merged = mergeHistoryCoverage(coverage);
  const missing: BrowserCacheCoverage[] = [];
  let cursor = target.from;

  for (const range of merged) {
    if (range.to < cursor) continue;
    if (range.from > target.to) break;
    if (range.from > cursor) {
      missing.push({ from: cursor, to: Math.min(target.to, range.from - 1) });
    }
    cursor = Math.max(cursor, range.to + 1);
    if (cursor > target.to) break;
  }
  if (cursor <= target.to) missing.push({ from: cursor, to: target.to });
  return missing.filter((range) => range.from <= range.to);
}

export function historyCoverageContains(
  coverage: BrowserCacheCoverage[],
  requested: BrowserCacheCoverage,
): boolean {
  return missingHistoryCoverage(coverage, requested).length === 0;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}

function abortTransactionOnSignal(transaction: IDBTransaction, signal?: AbortSignal): () => void {
  if (!signal) return () => undefined;
  const abort = () => {
    try {
      transaction.abort();
    } catch {
      // Transaction may already be complete/inactive.
    }
  };
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

function candleRange(
  source: BrowserHistorySource,
  symbol: string,
  interval: string,
  from: number,
  to: number,
): IDBKeyRange {
  return IDBKeyRange.bound(
    [source, normalizedSymbol(symbol), interval, from],
    [source, normalizedSymbol(symbol), interval, to],
  );
}

function sourceForLegacyMarket(market: 'spot' | 'usdm'): BrowserHistorySource {
  return market === 'spot' ? BINANCE_SPOT_HISTORY_SOURCE : BINANCE_USDM_HISTORY_SOURCE;
}

/** Browser-local historical storage shared by market-data providers. */
export class BrowserHistoryCache implements BrowserHistoryCacheApi {
  private databasePromise: Promise<IDBDatabase | null> | null = null;
  private disabled = false;

  get available(): boolean {
    return !this.disabled && typeof indexedDB !== 'undefined';
  }

  async coverage(
    source: BrowserHistorySource,
    symbol: string,
    interval: string,
  ): Promise<BrowserCacheCoverage[]> {
    const database = await this.database();
    if (!database) return [];
    try {
      const transaction = database.transaction(SERIES_STORE, 'readonly');
      const series = await requestResult(
        transaction.objectStore(SERIES_STORE).get(seriesKey(source, symbol, interval)) as IDBRequest<StoredSeries | undefined>,
      );
      if (!series) return [];
      if (Array.isArray(series.coverage) && series.coverage.length > 0) {
        return mergeHistoryCoverage(series.coverage);
      }
      return mergeHistoryCoverage([{ from: series.firstTime, to: series.lastTime }]);
    } catch {
      return [];
    }
  }

  async readLatest(
    source: BrowserHistorySource,
    symbol: string,
    interval: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Candle[]> {
    return this.read(source, symbol, interval, MIN_TIME, MAX_TIME, limit, 'prev', signal);
  }

  async readRange(
    source: BrowserHistorySource,
    symbol: string,
    interval: string,
    from: number,
    to: number,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<Candle[]> {
    return this.read(source, symbol, interval, Math.min(from, to), Math.max(from, to), limit, 'next', signal);
  }

  async write(
    source: BrowserHistorySource,
    symbol: string,
    interval: string,
    candles: Candle[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (candles.length === 0 || signal?.aborted) return;
    const database = await this.database();
    if (!database || signal?.aborted) return;
    const upperSymbol = normalizedSymbol(symbol);
    const valid = candles.filter((candle) => Number.isFinite(candle.time));
    if (valid.length === 0) return;

    let releaseAbort = () => undefined;
    try {
      const transaction = database.transaction([CANDLES_STORE, SERIES_STORE], 'readwrite');
      releaseAbort = abortTransactionOnSignal(transaction, signal);
      if (signal?.aborted) return;
      const done = transactionDone(transaction);
      const candleStore = transaction.objectStore(CANDLES_STORE);
      for (const candle of valid) {
        if (signal?.aborted) return;
        candleStore.put({
          source,
          symbol: upperSymbol,
          interval,
          time: candle.time,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
        } satisfies StoredCandle);
      }

      if (signal?.aborted) return;
      const firstTime = Math.min(...valid.map((candle) => candle.time));
      const lastTime = Math.max(...valid.map((candle) => candle.time));
      const key = seriesKey(source, upperSymbol, interval);
      const seriesStore = transaction.objectStore(SERIES_STORE);
      const previous = await requestResult(
        seriesStore.get(key) as IDBRequest<StoredSeries | undefined>,
      );
      if (signal?.aborted) return;
      seriesStore.put({
        key,
        source,
        symbol: upperSymbol,
        interval,
        firstTime: Math.min(previous?.firstTime ?? firstTime, firstTime),
        lastTime: Math.max(previous?.lastTime ?? lastTime, lastTime),
        coverage: mergeHistoryCoverage([
          ...(previous?.coverage ?? []),
          { from: firstTime, to: lastTime },
        ]),
        updatedAt: Date.now(),
      } satisfies StoredSeries);
      await done;
    } catch {
      // Cache failures and expected cancellations must never make the feed unusable.
    } finally {
      releaseAbort();
    }
  }

  async markCoverage(
    source: BrowserHistorySource,
    symbol: string,
    interval: string,
    range: BrowserCacheCoverage,
  ): Promise<void> {
    const normalized = normalizeCoverage(range);
    if (!normalized) return;
    const database = await this.database();
    if (!database) return;
    const upperSymbol = normalizedSymbol(symbol);

    try {
      const transaction = database.transaction(SERIES_STORE, 'readwrite');
      const done = transactionDone(transaction);
      const store = transaction.objectStore(SERIES_STORE);
      const key = seriesKey(source, upperSymbol, interval);
      const previous = await requestResult(store.get(key) as IDBRequest<StoredSeries | undefined>);
      store.put({
        key,
        source,
        symbol: upperSymbol,
        interval,
        firstTime: Math.min(previous?.firstTime ?? normalized.from, normalized.from),
        lastTime: Math.max(previous?.lastTime ?? normalized.to, normalized.to),
        coverage: mergeHistoryCoverage([...(previous?.coverage ?? []), normalized]),
        updatedAt: Date.now(),
      } satisfies StoredSeries);
      await done;
    } catch {
      // Coverage is an optimization hint; failures should not break the feed.
    }
  }

  async clearSource(source: BrowserHistorySource): Promise<void> {
    const database = await this.database();
    if (!database) return;
    try {
      const transaction = database.transaction([CANDLES_STORE, SERIES_STORE], 'readwrite');
      const done = transactionDone(transaction);
      await Promise.all([
        this.deleteMatching(transaction.objectStore(CANDLES_STORE), (value) => value.source === source),
        this.deleteMatching(transaction.objectStore(SERIES_STORE), (value) => value.source === source),
      ]);
      await done;
    } catch {
      // Clearing cache is best-effort.
    }
  }

  private async read(
    source: BrowserHistorySource,
    symbol: string,
    interval: string,
    from: number,
    to: number,
    limit: number | undefined,
    direction: IDBCursorDirection,
    signal?: AbortSignal,
  ): Promise<Candle[]> {
    if (signal?.aborted) return [];
    const database = await this.database();
    if (!database || signal?.aborted) return [];
    const normalizedLimit = limit === undefined ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(limit));
    let releaseAbort = () => undefined;
    try {
      const transaction = database.transaction(CANDLES_STORE, 'readonly');
      releaseAbort = abortTransactionOnSignal(transaction, signal);
      if (signal?.aborted) return [];
      const request = transaction.objectStore(CANDLES_STORE).openCursor(
        candleRange(source, symbol, interval, from, to),
        direction,
      );
      return await new Promise<Candle[]>((resolve, reject) => {
        const out: Candle[] = [];
        request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed'));
        request.onsuccess = () => {
          if (signal?.aborted) {
            resolve([]);
            return;
          }
          const cursor = request.result;
          if (!cursor || out.length >= normalizedLimit) {
            resolve(direction === 'prev' ? out.reverse() : out);
            return;
          }
          const value = cursor.value as StoredCandle;
          out.push({
            time: value.time,
            open: value.open,
            high: value.high,
            low: value.low,
            close: value.close,
            volume: value.volume,
          });
          cursor.continue();
        };
      });
    } catch {
      return [];
    } finally {
      releaseAbort();
    }
  }

  private async deleteMatching(
    store: IDBObjectStore,
    predicate: (value: StoredCandle | StoredSeries) => boolean,
  ): Promise<void> {
    const request = store.openCursor();
    await new Promise<void>((resolve, reject) => {
      request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        if (predicate(cursor.value as StoredCandle | StoredSeries)) cursor.delete();
        cursor.continue();
      };
    });
  }

  private database(): Promise<IDBDatabase | null> {
    if (this.disabled || typeof indexedDB === 'undefined') return Promise.resolve(null);
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise((resolve) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(CANDLES_STORE)) {
          database.createObjectStore(CANDLES_STORE, {
            keyPath: ['source', 'symbol', 'interval', 'time'],
          });
        }
        if (!database.objectStoreNames.contains(SERIES_STORE)) {
          database.createObjectStore(SERIES_STORE, { keyPath: 'key' });
        }
        if (!database.objectStoreNames.contains(META_STORE)) {
          database.createObjectStore(META_STORE, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        if (!legacyBinanceMigrationPromise) {
          legacyBinanceMigrationPromise = this.migrateLegacyBinance(database);
        }
        void legacyBinanceMigrationPromise.finally(() => resolve(database));
      };
      request.onerror = () => {
        this.disabled = true;
        resolve(null);
      };
      request.onblocked = () => resolve(null);
    });
    return this.databasePromise;
  }

  private async hasLegacyBinanceMigrationMarker(database: IDBDatabase): Promise<boolean> {
    try {
      const transaction = database.transaction(META_STORE, 'readonly');
      const marker = await requestResult(
        transaction.objectStore(META_STORE).get(LEGACY_BINANCE_MIGRATION_KEY) as IDBRequest<StoredMeta | undefined>,
      );
      return Boolean(marker);
    } catch {
      return false;
    }
  }

  private async markLegacyBinanceMigrated(database: IDBDatabase): Promise<void> {
    try {
      const transaction = database.transaction(META_STORE, 'readwrite');
      const done = transactionDone(transaction);
      transaction.objectStore(META_STORE).put({
        key: LEGACY_BINANCE_MIGRATION_KEY,
        updatedAt: Date.now(),
      } satisfies StoredMeta);
      await done;
    } catch {
      // A missing marker only means migration can be retried on the next page load.
    }
  }

  private async migrateLegacyBinance(database: IDBDatabase): Promise<void> {
    if (await this.hasLegacyBinanceMigrationMarker(database)) return;
    const legacy = await this.openLegacyBinanceDatabase();
    if (!legacy) {
      await this.markLegacyBinanceMigrated(database);
      return;
    }
    try {
      if (!legacy.objectStoreNames.contains(CANDLES_STORE) || !legacy.objectStoreNames.contains(SERIES_STORE)) {
        await this.markLegacyBinanceMigrated(database);
        return;
      }
      const legacyTransaction = legacy.transaction([CANDLES_STORE, SERIES_STORE], 'readonly');
      const legacyDone = transactionDone(legacyTransaction);
      const [candles, series] = await Promise.all([
        requestResult(legacyTransaction.objectStore(CANDLES_STORE).getAll() as IDBRequest<LegacyBinanceCandle[]>),
        requestResult(legacyTransaction.objectStore(SERIES_STORE).getAll() as IDBRequest<LegacyBinanceSeries[]>),
      ]);
      await legacyDone;

      const transaction = database.transaction([CANDLES_STORE, SERIES_STORE, META_STORE], 'readwrite');
      const done = transactionDone(transaction);
      const candleStore = transaction.objectStore(CANDLES_STORE);
      for (const candle of candles) {
        candleStore.put({
          source: sourceForLegacyMarket(candle.market),
          symbol: normalizedSymbol(candle.symbol),
          interval: candle.interval,
          time: candle.time,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
        } satisfies StoredCandle);
      }

      const seriesStore = transaction.objectStore(SERIES_STORE);
      for (const legacySeries of series) {
        const source = sourceForLegacyMarket(legacySeries.market);
        const key = seriesKey(source, legacySeries.symbol, legacySeries.interval);
        const previous = await requestResult(seriesStore.get(key) as IDBRequest<StoredSeries | undefined>);
        const migratedCoverage = { from: legacySeries.firstTime, to: legacySeries.lastTime };
        seriesStore.put({
          key,
          source,
          symbol: normalizedSymbol(legacySeries.symbol),
          interval: legacySeries.interval,
          firstTime: Math.min(previous?.firstTime ?? legacySeries.firstTime, legacySeries.firstTime),
          lastTime: Math.max(previous?.lastTime ?? legacySeries.lastTime, legacySeries.lastTime),
          coverage: mergeHistoryCoverage([...(previous?.coverage ?? []), migratedCoverage]),
          updatedAt: Math.max(previous?.updatedAt ?? 0, legacySeries.updatedAt ?? 0, Date.now()),
        } satisfies StoredSeries);
      }
      transaction.objectStore(META_STORE).put({
        key: LEGACY_BINANCE_MIGRATION_KEY,
        updatedAt: Date.now(),
      } satisfies StoredMeta);
      await done;
    } catch {
      // Migration is idempotent and best-effort. The old DB is intentionally retained for rollback.
    } finally {
      legacy.close();
    }
  }

  private openLegacyBinanceDatabase(): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
      const request = indexedDB.open(LEGACY_BINANCE_DATABASE_NAME);
      request.onupgradeneeded = (event) => {
        if ((event as IDBVersionChangeEvent).oldVersion === 0) request.transaction?.abort();
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
  }
}
