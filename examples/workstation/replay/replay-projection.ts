import type { Candle } from '../../../src/core/types';
import { aggregateCandles, mergeCandleIntoInterval } from '../../../src/candle-aggregation';

export class ReplayProjection {
  private candles: Candle[] = [];

  constructor(
    readonly interval: string,
    private readonly utcOffsetMinutes = 0,
  ) {}

  /** Khoi tao projection tu raw candles da duoc mo khoa toi thoi diem replay hien tai. */
  reset(source: readonly Candle[]): readonly Candle[] {
    this.candles = aggregateCandles(source, this.interval, this.utcOffsetMinutes);
    return this.snapshot();
  }

  /** Cap nhat O(1): replace bucket dang mo hoac append bucket moi. */
  push(source: Candle): Candle {
    const current = this.candles[this.candles.length - 1] ?? null;
    const update = mergeCandleIntoInterval(current, source, this.interval, this.utcOffsetMinutes);
    if (update.appended) this.candles.push(update.candle);
    else this.candles[this.candles.length - 1] = update.candle;
    return { ...update.candle };
  }

  snapshot(): Candle[] {
    return this.candles.map((candle) => ({ ...candle }));
  }
}
