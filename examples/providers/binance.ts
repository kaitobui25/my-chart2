import type { Candle } from '../../src/core/types';
import type { Datafeed, HistoryRange } from '../../src/datafeed';

/** Live crypto data from Binance public endpoints (no API key required). */
export class BinanceDatafeed implements Datafeed {
  readonly name = 'Binance';
  private restBase: string;
  private wsBase: string;

  constructor(restBase = 'https://api.binance.com', wsBase = 'wss://stream.binance.com:9443/ws') {
    this.restBase = restBase;
    this.wsBase = wsBase;
  }

  /**
   * Reachability check. Binance error responses lack CORS headers, so in a
   * browser a bad symbol and a dead network both surface as "Failed to fetch" —
   * ping lets callers tell the two apart.
   */
  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.restBase}/api/v3/time`, { signal: AbortSignal.timeout(4000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async getHistory(symbol: string, interval: string, limit = 500, range?: HistoryRange): Promise<Candle[]> {
    const url = new URL('/api/v3/klines', this.restBase);
    url.searchParams.set('symbol', symbol.toUpperCase());
    url.searchParams.set('interval', interval);
    url.searchParams.set('limit', String(Math.min(1000, limit)));
    if (range) {
      url.searchParams.set('startTime', String(range.from * 1000));
      url.searchParams.set('endTime', String(range.to * 1000));
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Binance klines HTTP ${res.status}`);
    const rows: (string | number)[][] = await res.json();
    return rows.map((r) => ({
      time: Math.floor(Number(r[0]) / 1000),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
    }));
  }

  subscribe(symbol: string, interval: string, onCandle: (c: Candle) => void): () => void {
    let ws: WebSocket | null = null;
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      ws = new WebSocket(`${this.wsBase}/${symbol.toLowerCase()}@kline_${interval}`);
      ws.onmessage = (ev) => {
        try {
          const k = JSON.parse(ev.data).k;
          if (!k) return;
          onCandle({
            time: Math.floor(k.t / 1000),
            open: Number(k.o),
            high: Number(k.h),
            low: Number(k.l),
            close: Number(k.c),
            volume: Number(k.v),
          });
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        if (!closed) retryTimer = setTimeout(connect, 2000);
      };
    };
    connect();

    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
    };
  }
}
