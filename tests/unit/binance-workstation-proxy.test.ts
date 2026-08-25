import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { rewriteWorkstationBinanceRestUrl } from '../../examples/providers/binance-workstation';

describe('Binance workstation REST proxy routing', () => {
  it('rewrites official Binance REST hosts through localhost routes', () => {
    const origin = 'http://127.0.0.1:53173';

    expect(rewriteWorkstationBinanceRestUrl(
      'https://data-api.binance.vision/api/v3/klines?symbol=ETHUSDT&interval=1d',
      origin,
    )).toBe(
      'http://127.0.0.1:53173/binance-spot-api/api/v3/klines?symbol=ETHUSDT&interval=1d',
    );

    expect(rewriteWorkstationBinanceRestUrl(
      'https://api.binance.com/api/v3/klines?symbol=ETHUSDT&interval=1d',
      origin,
    )).toBe(
      'http://127.0.0.1:53173/binance-spot-fallback-api/api/v3/klines?symbol=ETHUSDT&interval=1d',
    );

    expect(rewriteWorkstationBinanceRestUrl(
      'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1d',
      origin,
    )).toBe(
      'http://127.0.0.1:53173/binance-usdm-api/fapi/v1/klines?symbol=BTCUSDT&interval=1d',
    );
  });

  it('keeps unrelated URLs untouched', () => {
    const url = 'https://example.com/api/v3/klines';
    expect(rewriteWorkstationBinanceRestUrl(url, 'http://127.0.0.1:53173')).toBe(url);
  });

  it('declares matching Vite proxy routes', () => {
    const source = readFileSync(path.resolve('examples/workstation/vite.config.ts'), 'utf8');
    expect(source).toContain("'/binance-spot-api': {");
    expect(source).toContain("target: 'https://data-api.binance.vision'");
    expect(source).toContain("'/binance-spot-fallback-api': {");
    expect(source).toContain("target: 'https://api.binance.com'");
    expect(source).toContain("'/binance-usdm-api': {");
    expect(source).toContain("target: 'https://fapi.binance.com'");
  });
});
