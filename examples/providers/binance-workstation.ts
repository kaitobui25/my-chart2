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
const LATEST_RETRY_DELAY_MS = 150;
const SPOT_FALLBACK_REST_BASE = 'https://api.binance.com';
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
 * Binance's legacy coordinator treats any new cache read as a reason to abort
 * every active REST refresh. That is useful for a single replaceable chart, but
 * it makes independent workstation tiles cancel one another.
 *
 * The workstation variant keeps the same quiet-period and per-subscriber
 * cancellation behavior while making data activity non-destructive: activity
 * delays work that has not started yet, but never aborts another tile's active
 * request. A tile unsubscribe still aborts its own task through cancelSignal.
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
    const retryOnInterrupt = options.retryOnInterrupt ?? false;
    while (!options.cancelSignal?.aborted) {
      const generation = this.workstationGeneration;
      const waitMs = this.workstationQuietUntil - Date.now();
      if (waitMs > 0) await delay(waitMs);
      if (options.cancelSignal?.aborted) return undefined;
      if (generation !== this.workstationGeneration || Date.now() < this.workstationQuietUntil) continue;

      const controller = new AbortController();
      const cancel = () => controller.abort();
      options.cancelSignal?.addEventListener('abort', cancel, { once: true });
      try {
        return await task(controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        if (options.cancelSignal?.aborted || !retryOnInterrupt) return undefined;
      } finally {
        options.cancelSignal?.removeEventListener('abort', cancel);
      }
    }
    return undefined;
  }
}

/** Binance datafeed profile used only by the multi-chart workstation. */
export class BinanceDatafeed extends BaseBinanceDatafeed {
  private readonly fallbackLatestFeed: BaseBinanceDatafeed | null;

  constructor(options: BinanceDatafeedOptions = {}) {
    const market = options.market ?? 'spot';
    const cache = options.cache ?? new BinanceHistoryCache();
    const refreshCoordinator = options.refreshCoordinator
      ?? new WorkstationBinanceIdleRefreshCoordinator();
    // Browser-to-Binance REST can hang on some local networks even while the
    // localhost workstation itself is healthy. Keep custom fetch implementations
    // untouched for tests/embedders; otherwise local dev routes REST through Vite.
    const fetchImpl = options.fetchImpl ?? workstationFetchImpl();
    super({
      ...options,
      market,
      cache,
      fetchImpl,
      refreshCoordinator,
    });
    this.fallbackLatestFeed = market === 'spot' && !options.restBase
      ? new BaseBinanceDatafeed({
        ...options,
        market,
        cache,
        fetchImpl,
        restBase: SPOT_FALLBACK_REST_BASE,
        refreshCoordinator,
      })
      : null;
  }

  override async clearCache(): Promise<void> {
    await super.clearCache();
    // Both feeds share the same persistent cache, but the fallback keeps its own
    // short-lived recent snapshot map, so clear it too.
    await this.fallbackLatestFeed?.clearCache();
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
      // The base Binance feed implements its request timeout with
      // AbortController.abort(), so an internal timeout surfaces as AbortError.
      // Latest chart loads have no caller cancellation signal here. Give them one
      // second chance; for default Spot, use Binance's official primary REST base
      // as a different network path. Explicit range/load-older work stays
      // single-shot and low priority.
      if (range || !isAbortError(error)) throw error;
      await delay(LATEST_RETRY_DELAY_MS);
      if (!this.fallbackLatestFeed) return super.getHistory(symbol, interval, limit, range);
      try {
        return await this.fallbackLatestFeed.getHistory(symbol, interval, limit, range);
      } catch (fallbackError) {
        console.warn(`Binance Spot fallback latest load failed for ${symbol} ${interval}`, fallbackError);
        // Preserve AbortError semantics so the workstation keeps the provider on
        // and reports an interrupted load instead of treating fallback routing as
        // a provider-fatal error.
        throw error;
      }
    }
  }
}

export type { BinanceDatafeedOptions, BinanceMarket } from './binance';
