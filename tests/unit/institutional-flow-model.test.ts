import { describe, expect, it } from 'vitest';
import type { Candle } from '../../src/core/types';
import {
  alignInstitutionalFlowToCandles,
  institutionalFlowRangeForCandles,
  isInstitutionalFlowVietnamEquitySymbol,
  vietnamMonthKey,
} from '../../src/indicators/builtin/institutional-flow-model';

function candle(time: number): Candle {
  return { time, open: 10, high: 11, low: 9, close: 10.5, volume: 100 };
}

describe('institutional flow model', () => {
  it('uses Vietnam calendar time instead of the browser timezone', () => {
    const julyInVietnam = Date.UTC(2026, 6, 31, 16, 59) / 1000;
    const augustInVietnam = Date.UTC(2026, 6, 31, 18, 0) / 1000;

    expect(vietnamMonthKey(julyInVietnam)).toBe('2026-07');
    expect(vietnamMonthKey(augustInVietnam)).toBe('2026-08');
  });

  it('aligns source values to monthly candle indices and keeps missing data null', () => {
    const candles = [
      candle(Date.UTC(2026, 6, 1) / 1000),
      candle(Date.UTC(2026, 7, 1) / 1000),
      candle(Date.UTC(2026, 8, 1) / 1000),
    ];
    const points = alignInstitutionalFlowToCandles(candles, [
      { period: '2026-07', foreignNetValueVnd: 100, proprietaryNetValueVnd: null },
      { period: '2026-08', foreignNetValueVnd: -200, proprietaryNetValueVnd: 300 },
    ]);

    expect(points).toEqual([
      { foreign: 100, proprietary: null },
      { foreign: -200, proprietary: 300 },
      { foreign: null, proprietary: null },
    ]);
  });

  it('builds the requested month range from the loaded candles', () => {
    const candles = [
      candle(Date.UTC(2024, 0, 1) / 1000),
      candle(Date.UTC(2026, 7, 1) / 1000),
    ];
    expect(institutionalFlowRangeForCandles(candles)).toEqual({ from: '2024-01', to: '2026-08' });
    expect(institutionalFlowRangeForCandles([])).toBeNull();
  });

  it('accepts listed Vietnam equity ticker shape only', () => {
    expect(isInstitutionalFlowVietnamEquitySymbol('VIC')).toBe(true);
    expect(isInstitutionalFlowVietnamEquitySymbol(' hpg ')).toBe(true);
    for (const symbol of ['VNINDEX', 'VN30F1M', 'BTCUSDT', 'AAPL', '']) {
      expect(isInstitutionalFlowVietnamEquitySymbol(symbol)).toBe(false);
    }
  });
});
