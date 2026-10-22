import type { Candle } from '../../src/library';
import { nextIntervalStart } from '../../src/interval';
import { ReplayClock } from '../shared/replay/replay-clock';
import { captureLogicalViewport, restoreLogicalViewport } from '../shared/replay/replay-viewport';
import type { ExcelAssistantSource } from './assistant-context';
import type { JapanTimeframe } from './japan-market-config';

interface ReplayViewport {
  barSpacing: number;
  rightIndex: number;
}

export type ExcelReplayPhase = 'idle' | 'selecting' | 'paused' | 'playing';

export interface ExcelReplaySnapshot {
  phase: ExcelReplayPhase;
  source: ExcelAssistantSource | null;
  cursor: number;
  total: number;
  speed: number;
  currentTime: number | null;
  error: string | null;
}

export interface ReplayChart {
  getCandles(): readonly Candle[];
  setData(candles: Candle[]): void;
  updateCandle(candle: Candle): void;
  ensureCandlePriceVisible(candle: Candle): void;
  setReplaySelectionMode(active: boolean): void;
  scrollToLatest(): void;
  fitContent(): void;
  invalidate(): void;
  timeScale: ReplayViewport & { scroll(dxPx: number): void };
}

export interface ExcelReplayDependencies {
  chart: ReplayChart;
  market: { pause(): void; resume(): void };
  getSource(): ExcelAssistantSource;
  getMarketTimeframe(): JapanTimeframe;
  getPreserveReplayZoom?(): boolean;
  /** Invalidate any pending market/worksheet load before the chart is frozen. */
  onBegin(): void;
  onChange(snapshot: ExcelReplaySnapshot): void;
  nowSeconds?(): number;
}

const MAX_REPLAY_BARS = 20_000;
const TOKYO_OFFSET_MINUTES = 540;

/**
 * Single-chart replay, using already loaded OHLCV as the sole replay source.
 * Keeps a private copy because L2Chart mutates its current candle array in place.
 */
export class ExcelReplayController {
  private readonly clock: ReplayClock;
  private candles: Candle[] = [];
  private originalCandles: Candle[] = [];
  private source: ExcelAssistantSource | null = null;
  private selecting = false;
  private error: string | null = null;
  private disposed = false;
  private stopping = false;
  private preserveZoom = false;
  private viewportBeforeSelection: ReplayViewport | null = null;

  constructor(private readonly deps: ExcelReplayDependencies) {
    this.clock = new ReplayClock(
      (cursor) => this.reveal(cursor),
      () => this.emit(),
    );
  }

  snapshot(): ExcelReplaySnapshot {
    const state = this.clock.snapshot();
    return {
      phase: this.selecting ? 'selecting' : state.phase,
      source: this.source,
      cursor: state.cursor,
      total: this.candles.length,
      speed: state.speed,
      currentTime: state.currentTime,
      error: this.error,
    };
  }

  begin(): boolean {
    if (this.disposed) return false;
    if (this.snapshot().phase !== 'idle') {
      this.stop();
      return true;
    }

    const source = this.deps.getSource();
    const original = this.deps.chart.getCandles().map((candle) => ({ ...candle }));
    const candles = [...original];
    // Exclude the still-forming market candle; a Sheet row is assumed complete.
    if (source === 'market' && candles.length > 0) {
      const last = candles[candles.length - 1];
      const closedAt = nextIntervalStart(last.time, this.deps.getMarketTimeframe(), TOKYO_OFFSET_MINUTES);
      if (closedAt > (this.deps.nowSeconds?.() ?? Date.now() / 1000)) candles.pop();
    }
    if (candles.length < 2) return this.fail('Cần ít nhất hai nến đã đóng để Replay.');
    if (candles.length > MAX_REPLAY_BARS) return this.fail('Quá 20.000 nến; hãy chọn vùng dữ liệu ngắn hơn.');

    this.deps.onBegin();
    this.deps.market.pause(); // Also invalidates an outstanding market load when Sheet is active.
    this.candles = candles;
    this.originalCandles = original;
    this.source = source;
    this.selecting = true;
    this.error = null;
    this.deps.chart.setReplaySelectionMode(true);
    this.emit();
    return true;
  }

  selectStart(index: number): boolean {
    if (this.selecting && this.clock.snapshot().cursor >= 0) {
      return this.rewindTo(index);
    }
    if (!this.selecting || !Number.isInteger(index) || index < 0 || index >= this.candles.length - 1) {
      if (this.selecting) return this.fail('Chọn một nến trước nến cuối để bắt đầu.');
      return false;
    }

    this.selecting = false;
    this.error = null;
    this.preserveZoom = this.deps.getPreserveReplayZoom?.() ?? false;
    this.viewportBeforeSelection = this.preserveZoom ? this.captureViewport() : null;
    this.deps.chart.setReplaySelectionMode(false);
    this.deps.chart.setData(this.candles.slice(0, index + 1).map((candle) => ({ ...candle })));
    if (this.viewportBeforeSelection) this.restoreViewport(this.viewportBeforeSelection);
    else this.deps.chart.scrollToLatest();
    this.deps.chart.ensureCandlePriceVisible(this.candles[index]);
    this.clock.load(this.candles.map((candle) => candle.time), index);
    return true;
  }

  togglePlayback(): void {
    if (this.selecting) return;
    this.clock.togglePlayback();
  }

  step(): void {
    if (this.selecting) return;
    if (this.clock.snapshot().phase === 'playing') this.clock.pause();
    this.clock.step();
  }

  stepBack(): void {
    if (this.selecting || this.clock.snapshot().phase === 'idle') return;
    this.clock.pause();
    this.rewindTo(this.clock.snapshot().cursor - 1);
  }

  toggleRewindSelection(): void {
    if (this.clock.snapshot().phase === 'idle') return;
    if (this.selecting) {
      this.cancelSelection();
      return;
    }
    this.clock.pause();
    this.selecting = true;
    this.error = null;
    this.deps.chart.setReplaySelectionMode(true);
    this.emit();
  }

  cancelSelection(): void {
    if (!this.selecting) return;
    if (this.clock.snapshot().phase === 'idle') {
      this.stop();
      return;
    }
    this.selecting = false;
    this.error = null;
    this.deps.chart.setReplaySelectionMode(false);
    this.emit();
  }

  private rewindTo(index: number): boolean {
    const cursor = this.clock.snapshot().cursor;
    if (!Number.isInteger(index) || index < 0 || index >= cursor) return false;
    const viewport = this.preserveZoom ? this.captureViewport() : null;
    this.selecting = false;
    this.error = null;
    this.deps.chart.setReplaySelectionMode(false);
    this.deps.chart.setData(this.candles.slice(0, index + 1).map((candle) => ({ ...candle })));
    if (viewport) this.restoreViewport(viewport);
    else this.deps.chart.scrollToLatest();
    this.deps.chart.ensureCandlePriceVisible(this.candles[index]);
    this.clock.load(this.candles.map((candle) => candle.time), index);
    return true;
  }

  cycleSpeed(): void {
    if (this.selecting || this.clock.snapshot().phase === 'idle') return;
    this.clock.cycleSpeed();
  }

  pause(): void {
    if (this.clock.snapshot().phase === 'playing') this.clock.pause();
  }

  /** Restore the original candles; resume only the Market subscription we froze. */
  stop(resumeMarket = true): void {
    if (this.source === null) return;
    const previousSource = this.source;
    const restored = this.originalCandles.map((candle) => ({ ...candle }));
    const viewport = this.viewportBeforeSelection
      ?? (this.selecting && this.deps.getPreserveReplayZoom?.() ? this.captureViewport() : null);
    this.stopping = true;
    this.clock.stop();
    this.selecting = false;
    this.deps.chart.setReplaySelectionMode(false);
    this.source = null;
    this.candles = [];
    this.originalCandles = [];
    this.error = null;
    this.preserveZoom = false;
    this.viewportBeforeSelection = null;
    // The snapshot can exclude an incomplete Market bar; a current live update restores it.
    this.deps.chart.setData(restored);
    if (viewport) this.restoreViewport(viewport);
    else this.deps.chart.fitContent();
    if (resumeMarket && previousSource === 'market') this.deps.market.resume();
    this.stopping = false;
    this.emit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clock.stop();
    this.selecting = false;
    this.source = null;
    this.candles = [];
    this.originalCandles = [];
    this.viewportBeforeSelection = null;
    this.deps.chart.setReplaySelectionMode(false);
  }

  private reveal(cursor: number): void {
    const candle = this.candles[cursor];
    if (!candle) return;
    this.deps.chart.updateCandle({ ...candle });
    this.deps.chart.ensureCandlePriceVisible(candle);
    if (!this.preserveZoom) this.deps.chart.scrollToLatest();
  }

  private captureViewport(): ReplayViewport {
    return captureLogicalViewport(this.deps.chart.timeScale);
  }

  private restoreViewport(viewport: ReplayViewport): void {
    // Use TimeScale's clamp so a truncated Replay cannot scroll into unlimited empty future space.
    restoreLogicalViewport(this.deps.chart.timeScale, viewport);
    this.deps.chart.invalidate();
  }

  private fail(message: string): false {
    this.error = message;
    this.emit();
    return false;
  }

  private emit(): void {
    if (!this.disposed && !this.stopping) this.deps.onChange(this.snapshot());
  }
}
