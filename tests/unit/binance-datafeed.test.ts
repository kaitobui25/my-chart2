import { describe, expect, it, vi } from 'vitest';
import type { Candle } from '../../src/core/types';
import {
  BinanceDatafeed,
  mergeBinanceCandles,
  missingBinanceHistoryRanges,
} from '../../examples/providers/binance';

describe('BinanceDatafeed helpers', () => {
  it('merges candles by timestamp and keeps the latest value', () => {
    const first: Candle[] = [
      { time: 60, open: 1, high: 2, low: 1, close: 2 },
      { time: 120, open: 2, high: 3, low: 2, close: 3 },
    ];
    const update: Candle[] = [
      { time: 120, open: 2, high: 4, low: 2, close: 4 },
      { time: 180, open: 4, high: 5, low: 4, close: 5 },
    ];
    expect(mergeBinanceCandles(first, update).map((candle) => [candle.time, candle.close])).toEqual([
      [60, 2],
      [120, 4],
      [180, 5],
    ]);
  });

  it('finds leading, interior, and trailing cache gaps', () => {
    const cached: Candle[] = [120, 180, 300].map((time) => ({
      time,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
    }));
    expect(missingBinanceHistoryRanges(
      cached,
      { from: 60, to: 360 },
      60,
    )).toEqual([
      { from: 60, to: 60 },
      { from: 240, to: 240 },
      { from: 360, to: 360 },
    ]);
  });

  it('keeps Spot and USD-M names explicit', () => {
    expect(new BinanceDatafeed({ market: 'spot' }).name).toBe('Binance Spot');
    expect(new BinanceDatafeed({ market: 'usdm' }).name).toBe('Binance USD-M Futures');
  });

  it('filters USD-M symbol search to perpetual contracts', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      symbols: [
        { symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT', contractType: 'PERPETUAL' },
        { symbol: 'BTCUSDT_260925', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT', contractType: 'CURRENT_QUARTER' },
      ],
    }), { status: 200 })) as unknown as typeof fetch;
    const feed = new BinanceDatafeed({ market: 'usdm', fetchImpl });
    await expect(feed.searchSymbols('BTC')).resolves.toEqual([
      { symbol: 'BTCUSDT', name: 'BTC/USDT', exchange: 'BINANCE USD-M' },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://fapi.binance.com/fapi/v1/exchangeInfo',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
