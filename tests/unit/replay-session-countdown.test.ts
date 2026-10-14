import { describe, expect, it } from 'vitest';
import { buildReplaySessionCountdown } from '../../examples/workstation/replay/replay-session-countdown';

const time = (hm: string) => Date.parse(`2026-10-13T${hm}:00+09:00`) / 1000;
const history = ['13:45', '14:00', '14:15', '14:30', '14:45', '15:00', '15:15'].map(time);
describe('Replay session countdown', () => {
  it.each([
    ['5m', ['15:05', '15:10', '15:15', '15:20', '15:25']],
    ['30m', ['13:00', '13:30', '14:00', '14:30', '15:00']],
  ])('counts five closing bars for %s without labeling the lunch break', (interval, times) => {
    const history = [time('11:00'), ...times.map(time)];
    expect(buildReplaySessionCountdown(history, history, interval, 'yfinance-jp', '6758.T')
      .map(label => label.text)).toEqual(['5', '4', '3', '2', '1']);
  });
  it('labels only the last five actual bars, above the candle', () => {
    const labels = buildReplaySessionCountdown(history, history, '15m', 'yfinance-jp', '6758.T');
    expect(labels.map(label => label.text)).toEqual(['5', '4', '3', '2', '1']);
    expect(labels[labels.length - 1]).toMatchObject({ time: time('15:15'), position: 'above' });
  });
  it('accounts for a closing auction candle when the source supplies it', () => {
    const times = [...history, time('15:30')];
    const labels = buildReplaySessionCountdown(times, times, '15m', 'yfinance-jp', '^N225');
    expect(labels[0]).toMatchObject({ time: time('14:30'), text: '5' });
    expect(labels[labels.length - 1]).toMatchObject({ time: time('15:30'), text: '1' });
  });
  it('uses future timestamps but only labels candles already revealed', () => {
    expect(buildReplaySessionCountdown(history.slice(0, 4), history, '15m', 'yfinance-jp', '6758.T')
      .map(label => label.text)).toEqual(['5', '4']);
  });
  it('does not mark an incomplete day or continuous market', () => {
    expect(buildReplaySessionCountdown(history.slice(0, 4), history.slice(0, 4), '15m', 'yfinance-jp', '6758.T')).toEqual([]);
    expect(buildReplaySessionCountdown(history, history, '15m', 'yfinance-jp', 'BTC-USD')).toEqual([]);
    expect(buildReplaySessionCountdown(history, history, '1d', 'yfinance-jp', '6758.T')).toEqual([]);
  });
  it('aligns projected hourly bars with native session timestamps', () => {
    const times = ['10:00', '11:00', '12:30', '13:30', '14:30'].map(time);
    const projected = ['10:00', '11:00', '12:00', '13:00', '14:00'].map(time);
    expect(buildReplaySessionCountdown(projected, times, '1h', 'yfinance-jp', '6758.T')
      .map(label => label.text)).toEqual(['5', '4', '3', '2', '1']);
  });
});
