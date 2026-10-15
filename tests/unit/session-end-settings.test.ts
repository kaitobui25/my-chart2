import { describe, expect, it } from 'vitest';
import { sessionEndTimes } from '../../examples/workstation/session-end-settings';

const time = (hm: string) => Date.parse(`2026-10-13T${hm}:00+09:00`) / 1000;

describe('session end candle timestamps', () => {
  it('does not highlight lunch or an unfinished day', () => {
    expect(sessionEndTimes(['11:15', '11:30', '14:45'].map(time), '15m', 'yfinance-jp', '7203.T')).toEqual([]);
  });
  it('marks only the last candle, including a source closing auction', () => {
    const times = ['11:15', '15:00', '15:15', '15:30'].map(time);
    expect(sessionEndTimes(times, '15m', 'yfinance-jp', '7203.T')).toEqual([time('15:30')]);
  });
  it('supports both native and replay hourly timestamps', () => {
    expect(sessionEndTimes(['13:30', '14:30'].map(time), '1h', 'yfinance-jp', '7203.T'))
      .toEqual([time('14:30'), time('14:00')]);
  });
  it('does not mark daily or continuous-market candles', () => {
    expect(sessionEndTimes([time('15:15')], '1d', 'yfinance-jp', '7203.T')).toEqual([]);
    expect(sessionEndTimes([time('15:15')], '15m', 'binance', 'BTCUSDT')).toEqual([]);
  });
});
