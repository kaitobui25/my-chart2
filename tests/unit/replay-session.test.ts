import { describe, expect, it, vi } from 'vitest';

import type { Candle } from '../../src/core/types';
import type { Datafeed } from '../../src/datafeed';
import {
  SyncedReplaySession,
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

  constructor(
    readonly symbol: string,
    readonly interval: string,
    private readonly selectedTime: number,
  ) {}

  getReplayHistorySummary() {
    return { from: utc('2026-08-07T10:00:00Z'), to: utc('2026-08-07T12:00:00Z'), count: 20 };
  }

  getReplayHistoryCandles(): readonly Candle[] {
    return [];
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

  setReplayData(candles: readonly Candle[]) {
    this.data = candles.map((candle) => ({ ...candle }));
  }

  updateReplayCandle(candle: Candle) {
    const last = this.data[this.data.length - 1];
    if (last?.time === candle.time) this.data[this.data.length - 1] = { ...candle };
    else this.data.push({ ...candle });
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
    expect(chart15m.data).toHaveLength(2);
    expect(chart1h.data).toEqual([
      { time: utc('2026-08-07T10:00:00Z'), open: 100, high: 105, low: 98, close: 104 },
    ]);
    expect(claims).toEqual([['BTCUSDT', 'Test Replay']]);
    expect(publishes).toHaveLength(1);
    expect(publishes[0].candle.close).toBe(104);
    expect(publishes[0].currentTime).toBe(selectedTime);

    session.step();
    expect(state.currentTime).toBe(utc('2026-08-07T10:45:00Z'));
    expect(chart15m.data).toHaveLength(3);
    expect(chart1h.data[0].high).toBe(130);
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

  it('restores a saved replay cursor as paused with its saved speed', async () => {
    const selectedTime = utc('2026-08-07T10:30:00Z');
    const participant = new TestParticipant('BTCUSDT', '15m', selectedTime);
    let state = idleReplayState();
    const feed: Datafeed = {
      name: 'Test',
      getHistory: vi.fn(async () => sourceCandles()),
      subscribe: () => () => undefined,
    };
    const session = new SyncedReplaySession({
      getParticipants: () => [participant],
      getFeed: () => ({ feed, label: 'Test', utcOffsetMinutes: 0 }),
      claimMarketSource: () => undefined,
      releaseMarketSource: () => undefined,
      publishRawCandle: () => undefined,
      onStateChange: (next) => { state = next; },
    });

    await expect(session.restore({ currentTime: selectedTime, speed: 5 })).resolves.toBe(true);
    expect(state).toMatchObject({ phase: 'paused', currentTime: selectedTime, speed: 5 });
    expect(participant.active).toBe(true);
  });
});
