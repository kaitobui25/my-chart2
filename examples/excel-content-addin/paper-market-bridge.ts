import type { Candle, Datafeed } from '../../src/library';
import { instrumentFor } from '../workstation/trading/instruments';
import { MarketHub, PaperTradingEngine, type MarketQuote } from '../workstation/trading/paper';

/** Feeds the same PaperTradingEngine used by Workstation, never using sheet or replay bars. */
export class ExcelPaperMarketBridge {
  readonly hub = new MarketHub();
  readonly engine = new PaperTradingEngine(this.hub);

  private symbol = '7203.T';
  private readonly subscriptions = new Map<string, () => void>();
  private readonly generations = new Map<string, number>();
  private nextGeneration = 0;
  private readonly unsubscribeEngine: () => void;
  private disposed = false;

  constructor(private readonly feed: Datafeed) {
    this.unsubscribeEngine = this.engine.onChange(() => this.reconcile());
    this.reconcile();
  }

  setSymbol(symbol: string): void {
    if (this.symbol === symbol || this.disposed) return;
    this.symbol = symbol;
    this.reconcile();
  }

  getQuote(symbol = this.symbol): MarketQuote | null {
    return this.hub.get(symbol);
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeEngine();
    for (const stop of this.subscriptions.values()) stop();
    this.subscriptions.clear();
    this.generations.clear();
  }

  private reconcile(): void {
    if (this.disposed) return;
    const symbols = new Set<string>([this.symbol]);
    for (const position of this.engine.getPositions()) symbols.add(position.symbol);
    for (const order of this.engine.getOrders()) {
      if (order.status === 'working') symbols.add(order.symbol);
    }
    if ([...symbols].some((symbol) => instrumentFor(symbol).currency === 'JPY')) {
      symbols.add('JPY=X');
    }
    for (const [symbol, stop] of this.subscriptions) {
      if (symbols.has(symbol)) continue;
      stop();
      this.subscriptions.delete(symbol);
      this.generations.delete(symbol);
    }
    let added = false;
    for (const symbol of symbols) {
      if (this.subscriptions.has(symbol)) continue;
      const generation = ++this.nextGeneration;
      this.generations.set(symbol, generation);
      const publish = (candle: Candle, tradable: boolean) => {
        if (this.disposed || this.generations.get(symbol) !== generation) return;
        const previous = this.hub.get(symbol);
        // A completed historical fetch must not replace a more recent live quote.
        if (!tradable && previous?.tradable !== false && previous?.time !== undefined
          && previous.time >= candle.time) return;
        if (!Number.isFinite(candle.close) || candle.close <= 0) return;
        this.hub.update({
          symbol, last: candle.close, bid: candle.close, ask: candle.close, hasBidAsk: false,
          change: candle.close - candle.open,
          changePct: candle.open > 0 ? (candle.close / candle.open - 1) * 100 : 0,
          time: candle.time, source: 'Yahoo Japan', tradable,
        });
      };
      this.subscriptions.set(symbol, this.feed.subscribe(symbol, '1d', (candle) => publish(candle, true)));
      added = true;
      void this.feed.getHistory(symbol, '1d', 2).then((candles) => {
        const last = candles[candles.length - 1];
        if (last) publish(last, false);
      }).catch(() => {
        // Poll subscriptions remain active if Yahoo history is unavailable.
      });
    }
    if (added) void this.feed.refreshQuotes?.().catch(() => {
      // UI displays missing prices until the next scheduled Yahoo poll.
    });
  }
}
