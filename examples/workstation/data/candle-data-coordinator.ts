import type { Candle } from '../../../src/index';

export interface CandleDataCoordinatorOptions {
  maxEntries?: number;
  idleMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CandleLatestLoadOptions {
  /** Ignore a RAM hit and fetch a fresh latest page after the workstation is quiet. */
  refresh?: boolean;
}

interface CandleMemoryEntry {
  candles: Candle[];
  limit: number;
  updatedAt: number;
  lastUsedAt: number;
  sequence: number;
}

interface InFlightLatestLoad {
  generation: number;
  limit: number;
  promise: Promise<Candle[]>;
}

const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_IDLE_MS = 700;

function cloneCandles(candles: readonly Candle[]): Candle[] {
  return candles.map((candle) => ({ ...candle }));
}

function tail(candles: readonly Candle[], limit: number): Candle[] {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  const start = Math.max(0, candles.length - normalizedLimit);
  return cloneCandles(candles.slice(start));
}

/** Build the V1 latest-history dataset key used by the workstation RAM cache. */
export function candleDatasetKey(providerId: string, symbol: string, interval: string): string {
  return `${providerId}|${symbol.trim().toUpperCase()}|${interval}`;
}

/**
 * Session-only latest-history coordinator.
 *
 * Persistent caches remain owned by each Datafeed. This class intentionally knows
 * nothing about IndexedDB, REST URLs, credentials, or provider internals.
 */
export class CandleDataCoordinator {
  private readonly maxEntries: number;
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly memory = new Map<string, CandleMemoryEntry>();
  private readonly inFlight = new Map<string, InFlightLatestLoad[]>();
  private activityGeneration = 0;
  private quietUntil = 0;
  private writeSequence = 0;

  constructor(options: CandleDataCoordinatorOptions = {}) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
    this.idleMs = Math.max(0, Math.floor(options.idleMs ?? DEFAULT_IDLE_MS));
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /** Return a defensive copy of a sufficiently large latest page, if present. */
  peek(key: string, limit: number): Candle[] | null {
    const entry = this.memory.get(key);
    const normalizedLimit = Math.max(1, Math.floor(limit));
    if (!entry || entry.limit < normalizedLimit || entry.candles.length === 0) return null;
    entry.lastUsedAt = this.now();
    return tail(entry.candles, normalizedLimit);
  }

  /** Store a latest page in RAM. Callers retain ownership of their input array. */
  remember(key: string, candles: readonly Candle[], limit: number): void {
    if (candles.length === 0) return;
    this.rememberWithSequence(key, candles, limit, ++this.writeSequence);
  }

  /**
   * Read or load a latest page. Normal calls are RAM-first. Background refreshes
   * set `refresh: true`, wait for the global data-activity quiet period, and then
   * dedupe provider work for the same dataset and compatible limit.
   */
  async loadLatest(
    key: string,
    limit: number,
    load: (limit: number) => Promise<Candle[]>,
    options: CandleLatestLoadOptions = {},
  ): Promise<Candle[]> {
    const normalizedLimit = Math.max(1, Math.floor(limit));
    if (!options.refresh) {
      const cached = this.peek(key, normalizedLimit);
      if (cached) return cached;
    } else {
      await this.waitForIdle();
    }

    const generation = this.activityGeneration;
    const reusable = this.inFlight.get(key)?.find(
      (request) => request.generation === generation && request.limit >= normalizedLimit,
    );
    if (reusable) return reusable.promise.then((candles) => tail(candles, normalizedLimit));

    const sequence = ++this.writeSequence;
    let request!: InFlightLatestLoad;
    const promise = Promise.resolve()
      .then(() => load(normalizedLimit))
      .then((loaded) => {
        const candles = cloneCandles(loaded);
        // A data-affecting action after this request started makes the result
        // unsuitable for the shared latest-page cache. Tile.loadToken separately
        // protects chart state from stale application.
        if (candles.length > 0 && generation === this.activityGeneration) {
          this.rememberWithSequence(key, candles, normalizedLimit, sequence);
        }
        return candles;
      })
      .finally(() => this.removeInFlight(key, request));

    request = { generation, limit: normalizedLimit, promise };
    const requests = this.inFlight.get(key) ?? [];
    requests.push(request);
    this.inFlight.set(key, requests);
    return promise.then((candles) => tail(candles, normalizedLimit));
  }

  /** Delay future refresh work and invalidate shared-cache writes from older work. */
  noteDataActivity(): void {
    this.activityGeneration += 1;
    this.quietUntil = this.now() + this.idleMs;
  }

  /** Clear only this provider's session RAM. Provider-owned persistence is untouched. */
  clearProvider(providerId: string): void {
    const prefix = `${providerId}|`;
    for (const key of this.memory.keys()) {
      if (key.startsWith(prefix)) this.memory.delete(key);
    }
  }

  private rememberWithSequence(
    key: string,
    candles: readonly Candle[],
    limit: number,
    sequence: number,
  ): void {
    const previous = this.memory.get(key);
    if (previous && previous.sequence > sequence) return;
    const now = this.now();
    this.memory.set(key, {
      candles: cloneCandles(candles),
      limit: Math.max(1, Math.floor(limit)),
      updatedAt: now,
      lastUsedAt: now,
      sequence,
    });
    this.evictLeastRecentlyUsed();
  }

  private evictLeastRecentlyUsed(): void {
    while (this.memory.size > this.maxEntries) {
      let oldestKey: string | null = null;
      let oldestUsedAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.memory) {
        if (entry.lastUsedAt < oldestUsedAt) {
          oldestUsedAt = entry.lastUsedAt;
          oldestKey = key;
        }
      }
      if (oldestKey === null) return;
      this.memory.delete(oldestKey);
    }
  }

  private async waitForIdle(): Promise<void> {
    for (;;) {
      const remaining = this.quietUntil - this.now();
      if (remaining <= 0) return;
      await this.sleep(remaining);
    }
  }

  private removeInFlight(key: string, request: InFlightLatestLoad): void {
    const requests = this.inFlight.get(key);
    if (!requests) return;
    const next = requests.filter((candidate) => candidate !== request);
    if (next.length > 0) this.inFlight.set(key, next);
    else this.inFlight.delete(key);
  }
}
