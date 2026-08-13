import { describe, expect, it, vi } from 'vitest';

import type { Candle } from '../../src/core/types';
import type { Datafeed } from '../../src/datafeed';
import {
  SyncedReplaySession,
  chooseReplayParticipants,
  chooseReplayBaseInterval,
  type ReplayParticipant,
  type ReplaySessionSnapshot,
} from '../../examples/workstation/replay/replay-session';

const utc = (value: string): number => Math.floor(Date.parse(value) / 1000);

function idleReplayState(): ReplaySessionSnapshot {
  return {
    phase: 'idle',
    cursor: -1,
    total: 0,
    speed: 1,
    currentTime: null,
    baseInterval: null,
    symbol: null,
    error: null,
  };
}

class TestParticipant implements ReplayParticipant {
  data: Candle[] = [];
  selecting = false;
  active = false;
  status = '';
  reloads = 0;
  replayTime: number | null = null;

  constructor(
    readonly symbol: string,
    readonly interval: string,
    private readonly selectedTime: number,
    private readonly historyCount = 20,
    private readonly historyFrom = utc('2026-08-07T10:00:00Z'),
    private readonly historyTo = utc('2026-08-07T12:00:00Z'),
  ) {}

  getReplayHistorySummary() {
    if (this.historyCount === 0) return null;
    return {
      from: this.historyFrom,
      to: this.historyTo,
      count: this.historyCount,
    };
  }

  getReplaySelectionTime() {
    return this.selectedTime;
  }

  setReplaySelecting(selecting: boolean) {
    this.selecting = selecting;
  }

  enterReplay() {
    this.active = true;
  }

  setReplayData(candles: readonly Candle[], currentTime: number) {
    this.data = candles.map((candle) => ({ ...candle }));
    this.replayTime = currentTime;
  }

  updateReplayCandle(candle: Candle, currentTime: number) {
    const last = this.data[this.data.length - 1];
    if (last?.time === candle.time) this.data[this.data.length - 1] = { ...candle };
    else this.data.push({ ...candle });
    this.replayTime = currentTime;
  }

  setReplayStatus(label: string) {
    this.status = label;
  }

  leaveReplay(reload: boolean) {
    this.active = false;
    if (reload) this.reloads += 1;
  }
}

function sourceCandles(): Candle[] {
  return [
    { time: utc('2026-08-07T10:00:00Z'), open: 100, high: 101, low: 99, close: 100 },
    { time: utc('2026-08-07T10:15:00Z'), open: 100, high: 105, low: 98, close: 104 },
    { time: utc('2026-08-07T10:30:00Z'), open: 104, high: 130, low: 103, close: 125 },
    { time: utc('2026-08-07T10:45:00Z'), open: 125, high: 126, low: 110, close: 115 },
  ];
}

describe('SyncedReplaySession', () => {
  it('groups visible charts by the active symbol without letting other symbols block replay', () => {
    const selectedTime = utc('2026-08-07T10:30:00Z');
    const activeDaily = new TestParticipant('HPG', '1d', selectedTime);
    const sameSymbolMonth = new TestParticipant('HPG', '1M', selectedTime);
    const otherSymbol = new TestParticipant('SSI', '1d', selectedTime);
    const emptySameSymbol = new TestParticipant('HPG', '1h', selectedTime, 0);

    expect(chooseReplayParticipants(
      [otherSymbol, activeDaily, sameSymbolMonth, emptySameSymbol],
      activeDaily,
    )).toEqual([activeDaily, sameSymbolMonth, emptySameSymbol]);
  });

  it('keeps a same-symbol chart in replay so it can be projected from another timeframe', () => {
    const selectedTime = utc('2026-08-07T10:30:00Z');
    const ready = new TestParticipant('HPG', '1d', selectedTime);
    const empty = new TestParticipant('HPG', '1M', selectedTime, 0);
    let state = idleReplayState();
    const session = new SyncedReplaySession({
      getParticipants: () => [ready, empty],
      getFeed: () => ({ feed: null, label: 'Test', utcOffsetMinutes: 0 }),
      claimMarketSource: () => undefined,
      releaseMarketSource: () => undefined,
      publishRawCandle: () => undefined,
      onStateChange: (next) => { state = next; },
    });

    expect(session.beginSelection()).toBe(true);
    expect(state.phase).toBe('selecting');
    expect(ready.selecting).toBe(true);
    expect(empty.selecting).toBe(true);
  });

  it('projects an empty monthly chart from the daily replay source', async () => {
    const selectedTime = utc('2026-08-07T10:30:00Z');
    const daily = new TestParticipant('HPG', '1d', selectedTime);
    const monthly = new TestParticipant('HPG', '1M', selectedTime, 0);
    let state = idleReplayState();
    const feed: Datafeed = {
      name: 'Test',
      getHistory: vi.fn(async () => sourceCandles()),
      subscribe: () => () => undefined,
    };
    const session = new SyncedReplaySession({
      getParticipants: () => [monthly, daily],
      getFeed: () => ({ feed, label: 'Test', utcOffsetMinutes: 0 }),
      claimMarketSource: () => undefined,
      releaseMarketSource: () => undefined,
      publishRawCandle: () => undefined,
      onStateChange: (next) => { state = next; },
    });

    expect(session.beginSelection()).toBe(true);
    session.selectStart(daily, 1);
    await vi.waitFor(() => expect(state.phase).toBe('paused'));
    expect(monthly.active).toBe(true);
    expect(monthly.data.length).toBeGreaterThan(0);
  });

  it('backfills replay when another timeframe starts after the selected date', async () => {
    const selectedTime = utc('2023-10-03T00:00:00Z');
    const monthly = new TestParticipant(
      'MBB',
      '1M',
      selectedTime,
      24,
      utc('2021-08-01T00:00:00Z'),
      utc('2026-08-01T00:00:00Z'),
    );
    const daily = new TestParticipant(
      'MBB',
      '1d',
      selectedTime,
      500,
      utc('2024-08-12T00:00:00Z'),
      utc('2026-08-03T00:00:00Z'),
    );
    const replaySource: Candle[] = [
      { time: utc('2023-10-02T00:00:00Z'), open: 18, high: 19, low: 17, close: 18.5 },
      { time: utc('2023-10-03T00:00:00Z'), open: 18.5, high: 20, low: 18, close: 19.5 },
      { time: utc('2023-10-04T00:00:00Z'), open: 19.5, high: 21, low: 19, close: 20 },
    ];
    let state = idleReplayState();
    const feed: Datafeed = {
      name: 'Vnstock test',
      getHistory: vi.fn(async () => replaySource),
      subscribe: () => () => undefined,
    };
    const session = new SyncedReplaySession({
      getParticipants: () => [monthly, daily],
      getFeed: () => ({ feed, label: 'Vnstock', utcOffsetMinutes: 0 }),
      claimMarketSource: () => undefined,
      releaseMarketSource: () => undefined,
      publishRawCandle: () => undefined,
      onStateChange: (next) => { state = next; },
    });

    expect(session.beginSelection()).toBe(true);
    session.selectStart(monthly, 1);
    await vi.waitFor(() => expect(state.phase).toBe('paused'));
    expect(daily.active).toBe(true);
    expect(daily.data[0]?.time).toBe(utc('2023-10-02T00:00:00Z'));
  });

  it('uses daily raw data when week and month are shown together', () => {
    expect(chooseReplayBaseInterval(['1w', '1M'])).toBe('1d');
  });

  it('drives different timeframes from one clock without future leak', async () => {
    const selectedTime = utc('2026-08-07T10:30:00Z');
    const chart15m = new TestParticipant('BTCUSDT', '15m', selectedTime);
    const chart1h = new TestParticipant('BTCUSDT', '1h', selectedTime);
    const publishes: Array<{ candle: Candle; currentTime: number }> = [];
    const claims: Array<[string, string]> = [];
    const releases: Array<[string, string]> = [];
    let state = idleReplayState();
    const feed: Datafeed = {
      name: 'Test',
      getHistory: vi.fn(async () => sourceCandles()),
      subscribe: () => () => undefined,
    };
    const session = new SyncedReplaySession({
      getParticipants: () => [chart15m, chart1h],
      getFeed: () => ({ feed, label: 'Test', utcOffsetMinutes: 0 }),
      claimMarketSource: (symbol, source) => claims.push([symbol, source]),
      releaseMarketSource: (symbol, source) => releases.push([symbol, source]),
      publishRawCandle: (_symbol, candle, currentTime) => publishes.push({ candle, currentTime }),
      onStateChange: (next) => { state = next; },
    });

    expect(session.beginSelection()).toBe(true);
    session.selectStart(chart15m, 1);
    await vi.waitFor(() => expect(state.phase).toBe('paused'));

    expect(state.baseInterval).toBe('15m');
    expect(state.currentTime).toBe(selectedTime);
    expect(chart15m.data).toEqual([
      { time: utc('2026-08-07T10:00:00Z'), open: 100, high: 101, low: 99, close: 100 },
      { time: utc('2026-08-07T10:15:00Z'), open: 100, high: 105, low: 98, close: 104 },
    ]);
    expect(chart1h.data).toEqual([
      { time: utc('2026-08-07T10:00:00Z'), open: 100, high: 105, low: 98, close: 104 },
    ]);
    expect(chart15m.replayTime).toBe(selectedTime);
    expect(chart1h.replayTime).toBe(selectedTime);
    expect(claims).toEqual([['BTCUSDT', 'Test Replay']]);
    expect(publishes).toHaveLength(1);
    expect(publishes[0].candle.close).toBe(104);
    expect(publishes[0].currentTime).toBe(selectedTime);

    session.step();
    expect(state.currentTime).toBe(utc('2026-08-07T10:45:00Z'));
    expect(chart15m.data).toHaveLength(3);
    expect(chart1h.data[0].high).toBe(130);
    expect(chart15m.replayTime).toBe(utc('2026-08-07T10:45:00Z'));
    expect(chart1h.replayTime).toBe(utc('2026-08-07T10:45:00Z'));
    expect(publishes).toHaveLength(2);

    session.stop(false);
    expect(releases).toEqual([['BTCUSDT', 'Test Replay']]);
  });

  it('rejects synchronized replay when visible charts use different symbols', () => {
    const a = new TestParticipant('BTCUSDT', '15m', 100);
    const b = new TestParticipant('ETHUSDT', '1h', 100);
    let state = idleReplayState();
    const session = new SyncedReplaySession({
      getParticipants: () => [a, b],
      getFeed: () => ({ feed: null, label: 'Test', utcOffsetMinutes: 0 }),
      claimMarketSource: () => undefined,
      releaseMarketSource: () => undefined,
      publishRawCandle: () => undefined,
      onStateChange: (next) => { state = next; },
    });

    expect(session.beginSelection()).toBe(false);
    expect(state.error).toContain('cung mot symbol');
  });

});
