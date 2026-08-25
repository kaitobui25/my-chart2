import { describe, expect, it } from 'vitest';
import { isPeEligibleVietnamEquitySymbol } from '../../src/indicators/external/pe-eligibility';

describe('P/E Vietnam equity eligibility', () => {
  it('accepts normal Vietnam equity tickers', () => {
    expect(isPeEligibleVietnamEquitySymbol('HPG')).toBe(true);
    expect(isPeEligibleVietnamEquitySymbol('mbb')).toBe(true);
    expect(isPeEligibleVietnamEquitySymbol(' VNM ')).toBe(true);
  });

  it('rejects crypto pairs, indices, derivatives, and non-Vietnam ticker shapes', () => {
    for (const symbol of ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'VNINDEX', 'VN30', 'VN30F1M', 'AAPL', '']) {
      expect(isPeEligibleVietnamEquitySymbol(symbol)).toBe(false);
    }
  });
});
