import type { Candle } from '../../src/core/types';
import type { HistoryRange } from '../../src/datafeed';
import {
  BinanceDatafeed as BaseBinanceDatafeed,
  BinanceIdleRefreshCoordinator,
  type BinanceDatafeedOptions,
} from './binance';

interface WorkstationIdleRunOptions {
  retryOnInterrupt?: boolean;
  cancelSignal?: AbortSignal;
}

const DEFAULT_WORKSTATION_IDLE_MS = 650;
const LATEST_RETRY_DELAY_MS = 150;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, Math.max(0, ms)));
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && (error as { name?: unknown }).name === 'AbortError';
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
  constructor(options: BinanceDatafeedOptions = {}) {
    super({
      ...options,
      refreshCoordinator: options.refreshCoordinator
        ?? new WorkstationBinanceIdleRefreshCoordinator(),
    });
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
      // In the base Binance feed, the internal request timeout is implemented by
      // AbortController.abort(), so a timeout is surfaced as AbortError. Latest
      // chart loads have no caller cancellation signal, therefore one retry is
      // safe and prevents a transient 10s network stall from leaving a tile empty.
      // Explicit range / load-older requests remain single-shot background work.
      if (range || !isAbortError(error)) throw error;
      await delay(LATEST_RETRY_DELAY_MS);
      return super.getHistory(symbol, interval, limit, range);
    }
  }
}

export type { BinanceDatafeedOptions, BinanceMarket } from './binance';
