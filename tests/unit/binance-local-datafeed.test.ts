import { describe, expect, it, vi } from 'vitest';
import { BinanceLocalDatafeed } from '../../examples/providers/binance-local';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('BinanceLocalDatafeed', () => {
  it('reads history from the loopback service only', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url.startsWith('http://127.0.0.1:8750/history?')).toBe(true);
      return jsonResponse({
        candles: [{ time: 1000, open: 10, high: 12, low: 9, close: 11, volume: 20 }],
      });
    });
    const feed = new BinanceLocalDatafeed({ fetchImpl: fetchMock as unknown as typeof fetch });

    const candles = await feed.getHistory('BTC/USDT', '30m', 500);

    expect(candles).toHaveLength(1);
    expect(candles[0].close).toBe(11);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('binance.com');
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('binance.vision');
  });

  it('does not auto-import a missing symbol from getHistory', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      code: 'SYMBOL_NOT_INSTALLED',
      message: 'ETHUSDT is not downloaded yet',
    }, 404));
    const feed = new BinanceLocalDatafeed({ fetchImpl: fetchMock as unknown as typeof fetch });

    await expect(feed.getHistory('ETHUSDT', '1h', 500)).rejects.toThrow('SYMBOL_NOT_INSTALLED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/history?');
  });

  it('imports a missing symbol only through explicit ensureSymbol', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/status?')) {
        return jsonResponse({ symbol: 'ETHUSDT', installed: false });
      }
      if (url.endsWith('/import')) {
        return jsonResponse({ symbol: 'ETHUSDT', installed: true, downloadedRows: 123 });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    const feed = new BinanceLocalDatafeed({ fetchImpl: fetchMock as unknown as typeof fetch });

    const status = await feed.ensureSymbol('ETH/USDT');

    expect(status.installed).toBe(true);
    expect(status.symbol).toBe('ETHUSDT');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/status?symbol=ETHUSDT');
    expect(String(fetchMock.mock.calls[1][0])).toBe('http://127.0.0.1:8750/import');
  });

  it('does not import a symbol that is already installed', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/status?')) {
        return jsonResponse({ symbol: 'BTCUSDT', installed: true, rows: 1000 });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    const feed = new BinanceLocalDatafeed({ fetchImpl: fetchMock as unknown as typeof fetch });

    const status = await feed.ensureSymbol('BTCUSDT');

    expect(status.installed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps symbol search local and adds an exact syntactic candidate', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url.startsWith('http://127.0.0.1:8750/symbols?')).toBe(true);
      return jsonResponse({ symbols: [{ symbol: 'BTCUSDT', name: 'BTCUSDT' }] });
    });
    const feed = new BinanceLocalDatafeed({ fetchImpl: fetchMock as unknown as typeof fetch });

    const result = await feed.searchSymbols('ETH/USDT');

    expect(result.some((item) => item.symbol === 'ETHUSDT')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects intervals below 30m before any request', async () => {
    const fetchMock = vi.fn();
    const feed = new BinanceLocalDatafeed({ fetchImpl: fetchMock as unknown as typeof fetch });

    await expect(feed.getHistory('BTCUSDT', '15m', 500)).rejects.toThrow('30m and above');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
