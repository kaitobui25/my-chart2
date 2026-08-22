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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, Math.max(0, ms)));
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
  private generation = 0;
  private quietUntil = 0;

  constructor(private readonly workstationIdleMs = DEFAULT_WORKSTATION_IDLE_MS) {
    super(workstationIdleMs);
  }

  override noteActivity(): void {
    this.generation += 1;
    this.quietUntil = Date.now() + Math.max(0, this.workstationIdleMs);
  }

  override async runWhenIdle<T>(
    task: (signal: AbortSignal) => Promise<T>,
    options: WorkstationIdleRunOptions = {},
  ): Promise<T | undefined> {
    const retryOnInterrupt = options.retryOnInterrupt ?? false;
    while (!options.cancelSignal?.aborted) {
      const generation = this.generation;
      const waitMs = this.quietUntil - Date.now();
      if (waitMs > 0) await delay(waitMs);
      if (options.cancelSignal?.aborted) return undefined;
      if (generation !== this.generation || Date.now() < this.quietUntil) continue;

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
}

export type { BinanceDatafeedOptions, BinanceMarket } from './binance';
