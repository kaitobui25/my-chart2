import type { Candle } from '../../src/core/types';

export type BinanceMarket = 'spot' | 'usdm';

export interface BinanceCacheCoverage {
  from: number;
  to: number;
}

interface StoredCandle extends Candle {
  market: BinanceMarket;
  symbol: string;
  interval: string;
}

interface StoredSeries {
  key: string;
  market: BinanceMarket;
  symbol: string;
  interval: string;
  firstTime: number;
  lastTime: number;
  updatedAt: number;
}

const DATABASE_NAME = 'l2chart.binance.history.v1';
const DATABASE_VERSION = 1;
const CANDLES_STORE = 'candles';
const SERIES_STORE = 'series';
const MIN_TIME = 0;
const MAX_TIME = Number.MAX_SAFE_INTEGER;

function seriesKey(market: BinanceMarket, symbol: string, interval: string): string {
  return `${market}:${symbol.toUpperCase()}:${interval}`;
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

function candleRange(
  market: BinanceMarket,
  symbol: string,
  interval: string,
  from: number,
  to: number,
): IDBKeyRange {
  return IDBKeyRange.bound(
    [market, symbol.toUpperCase(), interval, from],
    [market, symbol.toUpperCase(), interval, to],
  );
}

/** Browser-local historical storage. All methods degrade to no-op when IndexedDB is unavailable. */
export class BinanceHistoryCache {
  private databasePromise: Promise<IDBDatabase | null> | null = null;
  private disabled = false;

  get available(): boolean {
    return !this.disabled && typeof indexedDB !== 'undefined';
  }

  async coverage(market: BinanceMarket, symbol: string, interval: string): Promise<BinanceCacheCoverage | null> {
    const database = await this.database();
    if (!database) return null;
    try {
      const transaction = database.transaction(SERIES_STORE, 'readonly');
      const series = await requestResult(
        transaction.objectStore(SERIES_STORE).get(seriesKey(market, symbol, interval)) as IDBRequest<StoredSeries | undefined>,
      );
      return series ? { from: series.firstTime, to: series.lastTime } : null;
    } catch {
      return null;
    }
  }

  async readLatest(
    market: BinanceMarket,
    symbol: string,
    interval: string,
    limit: number,
  ): Promise<Candle[]> {
    return this.read(market, symbol, interval, MIN_TIME, MAX_TIME, limit, 'prev');
  }

  async readRange(
    market: BinanceMarket,
    symbol: string,
    interval: string,
    from: number,
    to: number,
    limit?: number,
  ): Promise<Candle[]> {
    return this.read(market, symbol, interval, from, to, limit, 'next');
  }

  async write(
    market: BinanceMarket,
    symbol: string,
    interval: string,
    candles: Candle[],
  ): Promise<void> {
    if (candles.length === 0) return;
    const database = await this.database();
    if (!database) return;
    const normalizedSymbol = symbol.toUpperCase();
    const valid = candles.filter((candle) => Number.isFinite(candle.time));
    if (valid.length === 0) return;

    try {
      const transaction = database.transaction([CANDLES_STORE, SERIES_STORE], 'readwrite');
      const candleStore = transaction.objectStore(CANDLES_STORE);
      for (const candle of valid) {
        candleStore.put({
          market,
          symbol: normalizedSymbol,
          interval,
          time: candle.time,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
        } satisfies StoredCandle);
      }

      const key = seriesKey(market, normalizedSymbol, interval);
      const seriesStore = transaction.objectStore(SERIES_STORE);
      const previous = await requestResult(
        seriesStore.get(key) as IDBRequest<StoredSeries | undefined>,
      );
      const firstTime = Math.min(...valid.map((candle) => candle.time));
      const lastTime = Math.max(...valid.map((candle) => candle.time));
      seriesStore.put({
        key,
        market,
        symbol: normalizedSymbol,
        interval,
        firstTime: Math.min(previous?.firstTime ?? firstTime, firstTime),
        lastTime: Math.max(previous?.lastTime ?? lastTime, lastTime),
        updatedAt: Date.now(),
      } satisfies StoredSeries);
      await transactionDone(transaction);
    } catch {
      // Cache failures must never make the market data feed unusable.
    }
  }

  async clearMarket(market: BinanceMarket): Promise<void> {
    const database = await this.database();
    if (!database) return;
    try {
      const transaction = database.transaction([CANDLES_STORE, SERIES_STORE], 'readwrite');
      await Promise.all([
        this.deleteMatching(transaction.objectStore(CANDLES_STORE), (value) => value.market === market),
        this.deleteMatching(transaction.objectStore(SERIES_STORE), (value) => value.market === market),
      ]);
      await transactionDone(transaction);
    } catch {
      // Clearing cache is best-effort.
    }
  }

  private async read(
    market: BinanceMarket,
    symbol: string,
    interval: string,
    from: number,
    to: number,
    limit: number | undefined,
    direction: IDBCursorDirection,
  ): Promise<Candle[]> {
    const database = await this.database();
    if (!database) return [];
    const normalizedLimit = limit === undefined ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(limit));
    try {
      const transaction = database.transaction(CANDLES_STORE, 'readonly');
      const request = transaction.objectStore(CANDLES_STORE).openCursor(
        candleRange(market, symbol, interval, from, to),
        direction,
      );
      const candles = await new Promise<Candle[]>((resolve, reject) => {
        const out: Candle[] = [];
        request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed'));
        request.onsuccess = () => {
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
      return candles;
    } catch {
      return [];
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
            keyPath: ['market', 'symbol', 'interval', 'time'],
          });
        }
        if (!database.objectStoreNames.contains(SERIES_STORE)) {
          database.createObjectStore(SERIES_STORE, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () => {
        this.disabled = true;
        resolve(null);
      };
      request.onblocked = () => resolve(null);
    });
    return this.databasePromise;
  }
}
