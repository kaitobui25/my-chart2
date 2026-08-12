import { describe, expect, it, vi } from 'vitest';

import type { Candle } from '../../src/core/types';
import type { Datafeed } from '../../src/datafeed';
import {
  SyncedReplaySession,
  mergeReplayInitialCandles,
  type ReplayParticipant,
  type ReplaySessionSnapshot,
} from '../../examples/workstation/replay/replay-session';

const utc = (value: string): number => Math.floor(Date.parse(value) / 1000);

class SeedParticipant implements ReplayParticipant {
  data: Candle[] = [];
  selecting = false;
  active = false;

  readonly symbol = 'HPG';
  readonly interval = '15m';

  getReplayHistorySummary() {
    return {
      from: utc('2026-08-07T09:30:00Z'),
      to: utc('2026-08-07T11:00:00Z'),
      count: 7,
    };
  }

  getReplaySelectionTime() {
    return utc('2026-08-07T10:30:00Z');
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

  setReplayStatus() {}

  leaveReplay() {
    this.active = false;
  }
}

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

describe('Replay initial history', () => {
  it('keeps only closed seed candles and lets raw projection own the selected bucket', () => {
    const seed: Candle[] = [
      { time: 100, open: 1, high: 2, low: 1, close: 2 },
      { time: 200, open: 2, high: 3, low: 2, close: 3 },
      { time: 300, open: 3, high: 99, low: 3, close: 99 },
      { time: 400, open: 4, high: 5, low: 4, close: 5 },
    ];
    const projected: Candle[] = [
      { time: 300, open: 3, high: 4, low: 3, close: 4 },
    ];

    expect(mergeReplayInitialCandles(seed, projected)).toEqual([
      seed[0],
      seed[1],
      projected[0],
    ]);
  });

  it('restores cached history before the selected candle without another upstream history request', async () => {
    const participant = new SeedParticipant();
    const replaySource: Candle[] = [
      { time: utc('2026-08-07T10:15:00Z'), open: 100, high: 105, low: 98, close: 104 },
      { time: utc('2026-08-07T10:30:00Z'), open: 104, high: 108, low: 103, close: 107 },
      { time: utc('2026-08-07T10:45:00Z'), open: 107, high: 110, low: 106, close: 109 },
    ];
    const cachedSeed: Candle[] = [
      { time: utc('2026-08-07T09:30:00Z'), open: 96, high: 98, low: 95, close: 97 },
      { time: utc('2026-08-07T09:45:00Z'), open: 97, high: 99, low: 96, close: 98 },
      { time: utc('2026-08-07T10:00:00Z'), open: 98, high: 101, low: 97, close: 100 },
    ];
    const getHistory = vi.fn(async () => replaySource);
    const getCachedHistory = vi.fn(async () => cachedSeed);
    const feed: Datafeed = {
      name: 'Test',
      getCachedHistory,
      getHistory,
      subscribe: () => () => undefined,
    };
    let state = idleReplayState();
    const session = new SyncedReplaySession({
      getParticipants: () => [participant],
      getFeed: () => ({ feed, label: 'Test', utcOffsetMinutes: 0 }),
      claimMarketSource: () => undefined,
      releaseMarketSource: () => undefined,
      publishRawCandle: () => undefined,
      onStateChange: (next) => { state = next; },
    });

    expect(session.beginSelection()).toBe(true);
    session.selectStart(participant, 0);
    await vi.waitFor(() => expect(state.phase).toBe('paused'));

    expect(participant.data.map((candle) => candle.time)).toEqual([
      utc('2026-08-07T09:30:00Z'),
      utc('2026-08-07T09:45:00Z'),
      utc('2026-08-07T10:00:00Z'),
      utc('2026-08-07T10:15:00Z'),
    ]);
    expect(participant.data[participant.data.length - 1]?.close).toBe(104);
    expect(participant.active).toBe(true);
    expect(getCachedHistory).toHaveBeenCalledTimes(1);
    expect(getHistory).toHaveBeenCalledTimes(1);
  });
});
