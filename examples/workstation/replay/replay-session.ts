import type { Candle } from '../../../src/core/types';
import type { Datafeed } from '../../../src/datafeed';
import { estimateIntervalBars, intervalApproxSeconds, intervalStart, nextIntervalStart } from '../../../src/interval';
import { ReplayClock, type ReplayClockSnapshot } from './replay-clock';
import { ReplayProjection } from './replay-projection';

export type ReplaySessionPhase = 'idle' | 'selecting' | 'loading' | 'paused' | 'playing';

export interface ReplaySessionSnapshot {
  phase: ReplaySessionPhase;
  cursor: number;
  total: number;
  speed: number;
  currentTime: number | null;
  baseInterval: string | null;
  symbol: string | null;
  error: string | null;
}

export interface ReplayRestoreState {
  currentTime: number;
  speed: number;
}

export interface ReplayHistorySummary {
  from: number;
  to: number;
  count: number;
}

export interface ReplayParticipant {
  readonly symbol: string;
  readonly interval: string;
  getReplayHistorySummary(): ReplayHistorySummary | null;
  getReplayHistoryCandles(): readonly Candle[];
  getReplaySelectionTime(index: number, utcOffsetMinutes: number): number | null;
  setReplaySelecting(selecting: boolean): void;
  enterReplay(): void;
  setReplayData(candles: readonly Candle[]): void;
  updateReplayCandle(candle: Candle): void;
  setReplayStatus(label: string): void;
  leaveReplay(reload: boolean): void;
}

export interface ReplayFeedContext {
  feed: Datafeed | null;
  label: string;
  utcOffsetMinutes: number;
}

export interface ReplaySessionEnvironment {
  getParticipants(): ReplayParticipant[];
  getFeed(): ReplayFeedContext;
  claimMarketSource(symbol: string, source: string): void;
  releaseMarketSource(symbol: string, source: string): void;
  publishRawCandle(symbol: string, candle: Candle, currentTime: number, source: string): void;
  onStateChange(snapshot: ReplaySessionSnapshot): void;
}

const MAX_SOURCE_BARS = 20_000;

/** Chon raw timeframe nho nhat co the dung chung ma khong tao bucket calendar sai. */
export function chooseReplayBaseInterval(intervals: readonly string[]): string | null {
  if (intervals.length === 0) return null;
  if (intervals.every((interval) => interval === intervals[0])) return intervals[0];

  // Week khong the gop chinh xac thanh month vi mot week co the cat ngang hai thang.
  if (intervals.includes('1M') && intervals.every((interval) => interval === '1w' || interval === '1M')) {
    return '1d';
  }

  return [...intervals].sort((a, b) => intervalApproxSeconds(a) - intervalApproxSeconds(b))[0];
}

export class SyncedReplaySession {
  private readonly clock: ReplayClock;
  private phase: ReplaySessionPhase = 'idle';
  private participants: ReplayParticipant[] = [];
  private projections = new Map<ReplayParticipant, ReplayProjection>();
  private sourceCandles: Candle[] = [];
  private baseInterval: string | null = null;
  private symbol: string | null = null;
  private sourceLabel = 'Replay';
  private utcOffsetMinutes = 0;
  private error: string | null = null;
  private loadToken = 0;
  private marketSourceClaimed = false;

  constructor(private readonly environment: ReplaySessionEnvironment) {
    this.clock = new ReplayClock(
      (cursor, currentTime) => this.applySourceCandle(cursor, currentTime),
      (clock) => this.handleClockChange(clock),
    );
  }

  snapshot(): ReplaySessionSnapshot {
    const clock = this.clock.snapshot();
    return {
      phase: this.phase,
      cursor: clock.cursor,
      total: clock.total,
      speed: clock.speed,
      currentTime: clock.currentTime,
      baseInterval: this.baseInterval,
      symbol: this.symbol,
      error: this.error,
    };
  }

  toggle(): void {
    if (this.phase === 'idle') this.beginSelection();
    else this.stop(true);
  }

  /** Restore a saved replay cursor as paused after its participants have loaded history. */
  async restore(state: ReplayRestoreState): Promise<boolean> {
    if (!Number.isFinite(state.currentTime)) return false;
    if (this.phase !== 'idle') this.stop(false);
    if (!this.beginSelection()) return false;
    await this.startAt(state.currentTime);
    if (this.phase !== 'paused') return false;
    this.clock.setSpeed(state.speed);
    return true;
  }

  beginSelection(): boolean {
    const participants = this.environment.getParticipants();
    if (participants.length === 0) return this.fail('Khong co chart de replay');
    const symbols = new Set(participants.map((participant) => participant.symbol.trim().toUpperCase()));
    if (symbols.size !== 1) return this.fail('Replay dong bo can cac chart cung mot symbol');
    if (participants.some((participant) => (participant.getReplayHistorySummary()?.count ?? 0) < 2)) {
      return this.fail('Chua du du lieu de replay');
    }

    this.loadToken += 1;
    this.participants = participants;
    this.symbol = [...symbols][0];
    this.baseInterval = chooseReplayBaseInterval(participants.map((participant) => participant.interval));
    this.error = null;
    this.phase = 'selecting';
    for (const participant of participants) participant.setReplaySelecting(true);
    this.emitChange();
    return true;
  }

  selectStart(participant: ReplayParticipant, index: number): void {
    if (this.phase !== 'selecting' || !this.participants.includes(participant)) return;
    const selectedTime = participant.getReplaySelectionTime(index, this.utcOffsetMinutesFromCurrentFeed());
    if (selectedTime === null) return;
    void this.startAt(selectedTime);
  }

  togglePlayback(): void {
    if (this.phase !== 'paused' && this.phase !== 'playing') return;
    this.clock.togglePlayback();
  }

  step(): void {
    if (this.phase !== 'paused' && this.phase !== 'playing') return;
    if (this.phase === 'playing') this.clock.pause();
    this.clock.step();
  }

  cycleSpeed(): void {
    if (this.phase !== 'paused' && this.phase !== 'playing') return;
    this.clock.cycleSpeed();
  }

  stop(reload = true): void {
    this.loadToken += 1;
    this.releaseMarketSource();
    this.phase = 'idle';
    this.clock.stop();
    for (const participant of this.participants) {
      participant.setReplaySelecting(false);
      participant.leaveReplay(reload);
    }
    this.participants = [];
    this.projections.clear();
    this.sourceCandles = [];
    this.baseInterval = null;
    this.symbol = null;
    this.sourceLabel = 'Replay';
    this.error = null;
    this.emitChange();
  }

  private async startAt(selectedTime: number): Promise<void> {
    const token = ++this.loadToken;
    const feedContext = this.environment.getFeed();
    if (!feedContext.feed || !this.baseInterval || !this.symbol) {
      this.cancelSelection('Nguon gia khong san sang');
      return;
    }

    this.utcOffsetMinutes = feedContext.utcOffsetMinutes;
    const historyByParticipant = new Map<ReplayParticipant, ReplayHistorySummary>();
    const windows = this.participants.map((participant) => {
      const summary = participant.getReplayHistorySummary();
      if (!summary) return null;
      historyByParticipant.set(participant, summary);
      return {
        from: summary.from,
        // summary.to la thoi gian mo nen; doi sang bien dong cua timeframe de tim giao lich su chung.
        to: nextIntervalStart(summary.to, participant.interval, this.utcOffsetMinutes),
      };
    });
    if (windows.some((window) => window === null)) {
      this.cancelSelection('Chua du lich su de replay');
      return;
    }
    const resolvedWindows = windows.filter((window): window is { from: number; to: number } => window !== null);
    const commonFrom = Math.max(...resolvedWindows.map((window) => window.from));
    const commonTo = Math.min(...resolvedWindows.map((window) => window.to));
    if (commonFrom >= commonTo || selectedTime <= commonFrom || selectedTime > commonTo) {
      this.cancelSelection('Thoi diem chon nam ngoai lich su chung cua cac chart');
      return;
    }

    this.sourceLabel = `${feedContext.label} Replay`;
    this.phase = 'loading';
    for (const participant of this.participants) participant.setReplaySelecting(false);
    this.emitChange();

    // Lui ve dau bucket lon nhat dang mo de partial candle khong mat OHLC dau bucket.
    const sourceFrom = Math.min(
      intervalStart(commonFrom, this.baseInterval, this.utcOffsetMinutes),
      ...this.participants.map((participant) => intervalStart(
        commonFrom,
        participant.interval,
        this.utcOffsetMinutes,
      )),
    );
    const range = { from: sourceFrom, to: commonTo };
    const estimated = estimateIntervalBars(range.from, range.to, this.baseInterval) + 8;
    if (estimated > MAX_SOURCE_BARS) {
      this.cancelSelection('Khoang replay can qua nhieu raw candles; hay chon timeframe gan nhau hon');
      return;
    }
    const limit = Math.max(50, estimated);

    try {
      const loaded = await feedContext.feed.getHistory(this.symbol, this.baseInterval, limit, range);
      if (token !== this.loadToken || this.phase !== 'loading') return;
      const byTime = new Map<number, Candle>();
      for (const candle of loaded) byTime.set(candle.time, { ...candle });
      const source = [...byTime.values()].sort((a, b) => a.time - b.time);
      if (source.length < 2) {
        this.cancelSelection('Khong du raw candles de replay');
        return;
      }

      const timeline = source.map((candle) => nextIntervalStart(
        candle.time,
        this.baseInterval!,
        this.utcOffsetMinutes,
      ));
      let startCursor = -1;
      for (let index = 0; index < timeline.length; index += 1) {
        if (timeline[index] <= selectedTime) startCursor = index;
        else break;
      }
      if (startCursor < 0) startCursor = 0;
      startCursor = Math.min(startCursor, source.length - 2);

      this.sourceCandles = source;
      this.projections.clear();
      this.environment.claimMarketSource(this.symbol, this.sourceLabel);
      this.marketSourceClaimed = true;
      const revealed = source.slice(0, startCursor + 1);
      for (const participant of this.participants) {
        participant.enterReplay();
        const projection = new ReplayProjection(participant.interval, this.utcOffsetMinutes);
        this.projections.set(participant, projection);

        const summary = historyByParticipant.get(participant)!;
        const seed = participant.getReplayHistoryCandles()
          .filter((candle) => nextIntervalStart(
            candle.time,
            participant.interval,
            this.utcOffsetMinutes,
          ) <= sourceFrom)
          .map((candle) => ({ ...candle }));
        const projected = projection.reset(revealed)
          .filter((candle) => candle.time >= summary.from);
        const initialByTime = new Map<number, Candle>();
        for (const candle of seed) initialByTime.set(candle.time, candle);
        for (const candle of projected) initialByTime.set(candle.time, { ...candle });
        participant.setReplayData([...initialByTime.values()].sort((a, b) => a.time - b.time));
        participant.setReplayStatus(`replay · ${startCursor + 1}/${source.length}`);
      }

      this.publishSourceCandle(startCursor, timeline[startCursor]);
      this.error = null;
      // Clock load se emit snapshot ngay; chuyen phase truoc de khong bo mat trang thai paused.
      this.phase = 'paused';
      this.clock.load(timeline, startCursor);
    } catch (error) {
      if (token !== this.loadToken) return;
      this.cancelSelection(error instanceof Error ? error.message : 'Khong tai duoc du lieu replay');
    }
  }

  private applySourceCandle(cursor: number, currentTime: number): void {
    const source = this.sourceCandles[cursor];
    if (!source) return;
    for (const participant of this.participants) {
      const projection = this.projections.get(participant);
      if (!projection) continue;
      participant.updateReplayCandle(projection.push(source));
      participant.setReplayStatus(`replay · ${cursor + 1}/${this.sourceCandles.length}`);
    }
    this.publishSourceCandle(cursor, currentTime);
  }

  private publishSourceCandle(cursor: number, currentTime: number): void {
    const source = this.sourceCandles[cursor];
    if (!source || !this.symbol) return;
    this.environment.publishRawCandle(this.symbol, { ...source }, currentTime, this.sourceLabel);
  }

  private handleClockChange(clock: ReplayClockSnapshot): void {
    if (this.phase === 'loading' || this.phase === 'selecting') return;
    if (clock.phase === 'idle') this.phase = 'idle';
    else this.phase = clock.phase;
    this.emitChange();
  }

  private cancelSelection(message: string): void {
    this.releaseMarketSource();
    for (const participant of this.participants) participant.setReplaySelecting(false);
    this.participants = [];
    this.projections.clear();
    this.sourceCandles = [];
    this.baseInterval = null;
    this.symbol = null;
    this.phase = 'idle';
    this.error = message;
    this.clock.stop();
    this.emitChange();
  }

  private fail(message: string): boolean {
    this.error = message;
    this.emitChange();
    return false;
  }

  private releaseMarketSource(): void {
    if (!this.marketSourceClaimed || !this.symbol) return;
    this.environment.releaseMarketSource(this.symbol, this.sourceLabel);
    this.marketSourceClaimed = false;
  }

  private utcOffsetMinutesFromCurrentFeed(): number {
    return this.environment.getFeed().utcOffsetMinutes;
  }

  private emitChange(): void {
    this.environment.onStateChange(this.snapshot());
  }
}
