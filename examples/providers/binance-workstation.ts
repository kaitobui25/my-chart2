import type { Candle } from '../../src/core/types';
import type { HistoryRange } from '../../src/datafeed';
import {
  BinanceDatafeed as BaseBinanceDatafeed,
  BinanceIdleRefreshCoordinator,
  type BinanceDatafeedOptions,
} from './binance';
import { BinanceHistoryCache } from './binance-cache';

interface WorkstationIdleRunOptions {
  retryOnInterrupt?: boolean;
  cancelSignal?: AbortSignal;
}

const DEFAULT_WORKSTATION_IDLE_MS = 650;
const DEFAULT_WORKSTATION_REQUEST_TIMEOUT_MS = 6_000;
const FALLBACK_REQUEST_TIMEOUT_MS = 3_500;
const SPOT_ALTERNATE_REST_BASES = [
  'https://api-gcp.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
] as const;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const REST_PROXY_ROUTES = new Map<string, string>([
  ['https://data-api.binance.vision', '/binance-spot-api'],
  ['https://api.binance.com', '/binance-spot-fallback-api'],
  ['https://fapi.binance.com', '/binance-usdm-api'],
]);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, Math.max(0, ms)));
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && (error as { name?: unknown }).name === 'AbortError';
}

function isRetryableLatestError(error: unknown): boolean {
  if (isAbortError(error) || error instanceof TypeError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|network|failed to fetch|fetch failed|ECONN|ENET|EAI_AGAIN|502|503|504/i.test(message);
}

function loopbackOrigin(): string | null {
  const location = globalThis.location;
  if (!location || !LOOPBACK_HOSTS.has(location.hostname)) return null;
  return location.origin;
}

/** Rewrite official Binance REST URLs through the local Vite proxy used by the workstation. */
export function rewriteWorkstationBinanceRestUrl(rawUrl: string, origin: string): string {
  let upstream: URL;
  let localOrigin: URL;
  try {
    upstream = new URL(rawUrl);
    localOrigin = new URL(origin);
  } catch {
    return rawUrl;
  }
  const route = REST_PROXY_ROUTES.get(upstream.origin);
  if (!route) return rawUrl;
  localOrigin.pathname = `${route}${upstream.pathname}`;
  localOrigin.search = upstream.search;
  localOrigin.hash = '';
  return localOrigin.toString();
}

function workstationFetchImpl(): typeof fetch {
  const baseFetch = globalThis.fetch.bind(globalThis);
  const origin = loopbackOrigin();
  if (!origin) return baseFetch;
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const rewritten = rewriteWorkstationBinanceRestUrl(rawUrl, origin);
    if (input instanceof Request && rewritten !== rawUrl) {
      return baseFetch(new Request(rewritten, input), init);
    }
    return baseFetch(rewritten, init);
  }) as typeof fetch;
}

/**
 * Workstation-specific Binance idle coordinator.
 *
 * CandleDataCoordinator already owns the user-visible latest-history quiet gate.
 * A second provider-level wait made foreground cache misses vulnerable to starvation
 * whenever another tile performed a cache read. Calls without a cancellation signal
 * are foreground getHistory() work, so execute them immediately. Subscription/socket
 * startup still carries a cancellation signal and retains the provider quiet period.
 */
export class WorkstationBinanceIdleRefreshCoordinator extends BinanceIdleRefreshCoordinator {
  private workstationGeneration = 0;
  private workstationQuietUntil = 0;

  constructor(private readonly workstationIdleMs = DEFAULT_WORKSTATION_IDLE_MS) {
    super(workstationIdleMs);
  }

  override noteActivity(): void {
    this.workstationGeneration += 1;
    this.workstationQuietUntil = Date.now() + Math.max(0, this.workstationIdleMs);
  }

  override async runWhenIdle<T>(
    task: (signal: AbortSignal) => Promise<T>,
    options: WorkstationIdleRunOptions = {},
  ): Promise<T | undefined> {
    // Base getHistory() calls runWhenIdle without a cancellation signal. The
    // workstation's CandleDataCoordinator has already waited for UI/data idle,
    // so do not put the foreground request behind another global quiet gate.
    if (!options.cancelSignal) {
      const controller = new AbortController();
      return task(controller.signal);
    }

    const retryOnInterrupt = options.retryOnInterrupt ?? false;
    while (!options.cancelSignal.aborted) {
      const generation = this.workstationGeneration;
      const waitMs = this.workstationQuietUntil - Date.now();
      if (waitMs > 0) await delay(waitMs);
      if (options.cancelSignal.aborted) return undefined;
      if (generation !== this.workstationGeneration || Date.now() < this.workstationQuietUntil) continue;

      const controller = new AbortController();
      const cancel = () => controller.abort();
      options.cancelSignal.addEventListener('abort', cancel, { once: true });
      try {
        return await task(controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        if (options.cancelSignal.aborted || !retryOnInterrupt) return undefined;
      } finally {
        options.cancelSignal.removeEventListener('abort', cancel);
      }
    }
    return undefined;
  }
}

interface SpotFallbackFeed {
  restBase: string;
  feed: BaseBinanceDatafeed;
}

/** Binance datafeed profile used only by the multi-chart workstation. */
export class BinanceDatafeed extends BaseBinanceDatafeed {
  private readonly fallbackLatestFeeds: SpotFallbackFeed[];

  constructor(options: BinanceDatafeedOptions = {}) {
    const market = options.market ?? 'spot';
    const cache = options.cache ?? new BinanceHistoryCache();
    const refreshCoordinator = options.refreshCoordinator
      ?? new WorkstationBinanceIdleRefreshCoordinator();
    // Browser-to-Binance REST can hang on some local networks even while the
    // localhost workstation itself is healthy. Keep custom fetch implementations
    // untouched for tests/embedders; otherwise the default market-data route goes
    // through Vite. Alternate official hosts intentionally stay direct so a local
    // proxy/upstream-path failure cannot take every retry down with it.
    const fetchImpl = options.fetchImpl ?? workstationFetchImpl();
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_WORKSTATION_REQUEST_TIMEOUT_MS;
    super({
      ...options,
      market,
      cache,
      fetchImpl,
      requestTimeoutMs,
      refreshCoordinator,
    });
    const fallbackTimeoutMs = Math.min(requestTimeoutMs, FALLBACK_REQUEST_TIMEOUT_MS);
    this.fallbackLatestFeeds = market === 'spot' && !options.restBase
      ? SPOT_ALTERNATE_REST_BASES.map((restBase) => ({
        restBase,
        feed: new BaseBinanceDatafeed({
          ...options,
          market,
          cache,
          fetchImpl,
          restBase,
          requestTimeoutMs: fallbackTimeoutMs,
          refreshCoordinator,
        }),
      }))
      : [];
  }

  override async clearCache(): Promise<void> {
    await super.clearCache();
    // All feeds share persistent storage but keep separate short-lived snapshots.
    await Promise.all(this.fallbackLatestFeeds.map(({ feed }) => feed.clearCache()));
  }

  override async getHistory(
    symbol: string,
    interval: string,
    limit = 500,
    range?: HistoryRange,
  ): Promise<Candle[]> {
    try {
      return await super.getHistory(symbol, interval, limit, range);
    } catch (error) {
      // Explicit range/load-older work stays single-shot and low priority. Invalid
      // requests should also fail immediately instead of being repeated across
      // every endpoint. Network/timeout failures of foreground latest data may use
      // Binance's documented redundant Spot REST hosts.
      if (range || !isRetryableLatestError(error) || this.fallbackLatestFeeds.length === 0) throw error;

      console.warn(
        `Binance Spot primary latest route failed for ${symbol} ${interval}; trying official alternates`,
        error,
      );
      for (const { restBase, feed } of this.fallbackLatestFeeds) {
        const startedAt = Date.now();
        try {
          const candles = await feed.getHistory(symbol, interval, limit);
          if (candles.length > 0) return candles;
          console.warn(
            `Binance Spot alternate latest route returned no candles route=${restBase} symbol=${symbol} interval=${interval} elapsedMs=${Date.now() - startedAt}`,
          );
        } catch (fallbackError) {
          console.warn(
            `Binance Spot alternate latest route failed route=${restBase} symbol=${symbol} interval=${interval} elapsedMs=${Date.now() - startedAt}`,
            fallbackError,
          );
        }
      }

      // Preserve the primary interruption semantics so the workstation keeps the
      // provider enabled instead of treating exhaustion of redundant routes as a
      // provider-fatal error.
      throw error;
    }
  }
}

export type { BinanceDatafeedOptions, BinanceMarket } from './binance';
