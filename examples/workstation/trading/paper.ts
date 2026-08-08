export interface MarketQuote {
  symbol: string;
  last: number;
  bid: number;
  ask: number;
  /** True only when the feed supplied both sides of the order book. */
  hasBidAsk: boolean;
  change: number;
  changePct: number;
  time: number;
  source: string;
  bids?: MarketDepthLevel[];
  asks?: MarketDepthLevel[];
}

export interface MarketDepthLevel {
  price: number;
  volume: number;
}

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop';
export type OrderStatus = 'working' | 'filled' | 'cancelled' | 'rejected';

export interface OrderRequest {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  volume: number;
  price?: number;
  takeProfit?: number;
  stopLoss?: number;
}

export interface PaperOrder extends OrderRequest {
  id: string;
  status: OrderStatus;
  createdAt: number;
  updatedAt: number;
  fillPrice?: number;
  message?: string;
}

export interface PaperPosition {
  id: string;
  symbol: string;
  side: OrderSide;
  volume: number;
  entryPrice: number;
  currentPrice: number;
  takeProfit?: number;
  stopLoss?: number;
  openedAt: number;
  unrealizedPnl: number;
}

export interface TradeRecord {
  id: string;
  positionId: string;
  symbol: string;
  side: OrderSide;
  volume: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  openedAt: number;
  closedAt: number;
  reason: 'manual' | 'take-profit' | 'stop-loss';
}

export interface AccountSnapshot {
  balance: number;
  equity: number;
  usedMargin: number;
  freeMargin: number;
  unrealizedPnl: number;
  realizedPnl: number;
}

interface StoredPaperState {
  balance: number;
  orders: PaperOrder[];
  positions: PaperPosition[];
  trades: TradeRecord[];
}

const PAPER_STORAGE_KEY = 'l2chart.paper.v1';
const STARTING_BALANCE = 1_000_000_000;
const CONTRACT_MULTIPLIER = 1000;
const MARGIN_RATE = 0.2;

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function finitePositive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

export class MarketHub {
  private readonly quotes = new Map<string, MarketQuote>();
  private readonly listeners = new Set<(quote: MarketQuote) => void>();
  private readonly exclusiveSources = new Map<string, string>();

  /** Khoa mot symbol vao mot nguon gia, de replay khong bi live feed chen vao. */
  lockSource(symbol: string, source: string): void {
    this.exclusiveSources.set(symbol.trim().toUpperCase(), source);
  }

  /** Chi nguon dang giu lock moi duoc mo lock cua symbol. */
  unlockSource(symbol: string, source: string): void {
    const key = symbol.trim().toUpperCase();
    if (this.exclusiveSources.get(key) === source) this.exclusiveSources.delete(key);
  }

  update(quote: MarketQuote): void {
    const normalized = { ...quote, symbol: quote.symbol.trim().toUpperCase() };
    const exclusiveSource = this.exclusiveSources.get(normalized.symbol);
    if (exclusiveSource && normalized.source !== exclusiveSource) return;
    this.quotes.set(normalized.symbol, normalized);
    for (const listener of this.listeners) listener(normalized);
  }

  get(symbol: string): MarketQuote | null {
    return this.quotes.get(symbol.trim().toUpperCase()) ?? null;
  }

  all(): MarketQuote[] {
    return [...this.quotes.values()];
  }

  onQuote(listener: (quote: MarketQuote) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export class PaperTradingEngine {
  private balance = STARTING_BALANCE;
  private orders: PaperOrder[] = [];
  private positions: PaperPosition[] = [];
  private trades: TradeRecord[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly market: MarketHub) {
    this.restore();
    market.onQuote((quote) => this.onQuote(quote));
  }

  submit(request: OrderRequest): PaperOrder {
    const now = Date.now();
    const order: PaperOrder = {
      ...request,
      symbol: request.symbol.trim().toUpperCase(),
      volume: Math.max(0, Math.floor(request.volume)),
      price: finitePositive(request.price),
      takeProfit: finitePositive(request.takeProfit),
      stopLoss: finitePositive(request.stopLoss),
      id: makeId('O'),
      status: 'working',
      createdAt: now,
      updatedAt: now,
    };

    if (order.volume <= 0) {
      order.status = 'rejected';
      order.message = 'Khoi luong phai lon hon 0';
    } else if (order.type !== 'market' && !order.price) {
      order.status = 'rejected';
      order.message = 'Lenh limit/stop can gia kich hoat';
    }
    this.orders.unshift(order);

    if (order.status === 'working' && order.type === 'market') {
      const quote = this.market.get(order.symbol);
      if (!quote) {
        order.status = 'rejected';
        order.message = 'Chua co gia thi truong';
      } else {
        this.fillOrder(order, order.side === 'buy' ? quote.ask : quote.bid, quote.time * 1000);
      }
    }
    this.changed();
    return { ...order };
  }

  modifyOrder(
    id: string,
    patch: Partial<Pick<OrderRequest, 'price' | 'volume' | 'takeProfit' | 'stopLoss'>>,
  ): boolean {
    const order = this.orders.find((item) => item.id === id && item.status === 'working');
    if (!order) return false;
    if (patch.volume !== undefined) order.volume = Math.max(1, Math.floor(patch.volume));
    if (patch.price !== undefined) order.price = finitePositive(patch.price);
    if (patch.takeProfit !== undefined) order.takeProfit = finitePositive(patch.takeProfit);
    if (patch.stopLoss !== undefined) order.stopLoss = finitePositive(patch.stopLoss);
    order.updatedAt = Date.now();
    this.changed();
    return true;
  }

  cancelOrder(id: string): boolean {
    const order = this.orders.find((item) => item.id === id && item.status === 'working');
    if (!order) return false;
    order.status = 'cancelled';
    order.updatedAt = Date.now();
    this.changed();
    return true;
  }

  closePosition(id: string, reason: TradeRecord['reason'] = 'manual'): boolean {
    const position = this.positions.find((item) => item.id === id);
    if (!position) return false;
    const quote = this.market.get(position.symbol);
    if (!quote) return false;
    const exitPrice = position.side === 'buy' ? quote.bid : quote.ask;
    this.realizePosition(position, exitPrice, quote.time * 1000, reason);
    this.changed();
    return true;
  }

  closeAll(): number {
    let closed = 0;
    for (const position of [...this.positions]) {
      if (this.closePosition(position.id)) closed += 1;
    }
    return closed;
  }

  getOrders(): PaperOrder[] {
    return this.orders.map((order) => ({ ...order }));
  }

  getPositions(): PaperPosition[] {
    return this.positions.map((position) => ({ ...position }));
  }

  getTrades(): TradeRecord[] {
    return this.trades.map((trade) => ({ ...trade }));
  }

  getAccount(): AccountSnapshot {
    const unrealizedPnl = this.positions.reduce((sum, position) => sum + position.unrealizedPnl, 0);
    const usedMargin = this.positions.reduce(
      (sum, position) => sum + position.entryPrice * position.volume * CONTRACT_MULTIPLIER * MARGIN_RATE,
      0,
    );
    const realizedPnl = this.balance - STARTING_BALANCE;
    const equity = this.balance + unrealizedPnl;
    return {
      balance: this.balance,
      equity,
      usedMargin,
      freeMargin: equity - usedMargin,
      unrealizedPnl,
      realizedPnl,
    };
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private onQuote(quote: MarketQuote): void {
    let dirty = false;
    for (const position of [...this.positions]) {
      if (position.symbol !== quote.symbol) continue;
      position.currentPrice = position.side === 'buy' ? quote.bid : quote.ask;
      position.unrealizedPnl = this.positionPnl(position, position.currentPrice);
      dirty = true;

      if (position.side === 'buy') {
        if (position.stopLoss && quote.bid <= position.stopLoss) {
          this.realizePosition(position, quote.bid, quote.time * 1000, 'stop-loss');
        } else if (position.takeProfit && quote.bid >= position.takeProfit) {
          this.realizePosition(position, quote.bid, quote.time * 1000, 'take-profit');
        }
      } else if (position.stopLoss && quote.ask >= position.stopLoss) {
        this.realizePosition(position, quote.ask, quote.time * 1000, 'stop-loss');
      } else if (position.takeProfit && quote.ask <= position.takeProfit) {
        this.realizePosition(position, quote.ask, quote.time * 1000, 'take-profit');
      }
    }

    for (const order of this.orders) {
      if (order.status !== 'working' || order.symbol !== quote.symbol || !order.price) continue;
      const fill =
        order.type === 'limit'
          ? order.side === 'buy'
            ? quote.ask <= order.price
            : quote.bid >= order.price
          : order.side === 'buy'
            ? quote.ask >= order.price
            : quote.bid <= order.price;
      if (!fill) continue;
      this.fillOrder(order, order.side === 'buy' ? quote.ask : quote.bid, quote.time * 1000);
      dirty = true;
    }
    if (dirty) this.changed();
  }

  private fillOrder(order: PaperOrder, price: number, time: number): void {
    const requiredMargin = price * order.volume * CONTRACT_MULTIPLIER * MARGIN_RATE;
    if (this.getAccount().freeMargin < requiredMargin) {
      order.status = 'rejected';
      order.message = 'Khong du suc mua paper';
      order.updatedAt = time;
      return;
    }
    order.status = 'filled';
    order.fillPrice = price;
    order.updatedAt = time;
    this.positions.unshift({
      id: makeId('P'),
      symbol: order.symbol,
      side: order.side,
      volume: order.volume,
      entryPrice: price,
      currentPrice: price,
      takeProfit: order.takeProfit,
      stopLoss: order.stopLoss,
      openedAt: time,
      unrealizedPnl: 0,
    });
  }

  private positionPnl(position: PaperPosition, exitPrice: number): number {
    const direction = position.side === 'buy' ? 1 : -1;
    return (exitPrice - position.entryPrice) * position.volume * CONTRACT_MULTIPLIER * direction;
  }

  private realizePosition(
    position: PaperPosition,
    exitPrice: number,
    closedAt: number,
    reason: TradeRecord['reason'],
  ): void {
    const pnl = this.positionPnl(position, exitPrice);
    this.balance += pnl;
    this.positions = this.positions.filter((item) => item.id !== position.id);
    this.trades.unshift({
      id: makeId('T'),
      positionId: position.id,
      symbol: position.symbol,
      side: position.side,
      volume: position.volume,
      entryPrice: position.entryPrice,
      exitPrice,
      pnl,
      openedAt: position.openedAt,
      closedAt,
      reason,
    });
  }

  private changed(): void {
    this.persist();
    for (const listener of this.listeners) listener();
  }

  private restore(): void {
    try {
      const raw = localStorage.getItem(PAPER_STORAGE_KEY);
      if (!raw) return;
      const state = JSON.parse(raw) as Partial<StoredPaperState>;
      this.balance = Number.isFinite(state.balance) ? Number(state.balance) : STARTING_BALANCE;
      this.orders = Array.isArray(state.orders) ? state.orders : [];
      this.positions = Array.isArray(state.positions) ? state.positions : [];
      this.trades = Array.isArray(state.trades) ? state.trades : [];
    } catch {
      this.balance = STARTING_BALANCE;
    }
  }

  private persist(): void {
    const state: StoredPaperState = {
      balance: this.balance,
      orders: this.orders.slice(0, 200),
      positions: this.positions,
      trades: this.trades.slice(0, 500),
    };
    localStorage.setItem(PAPER_STORAGE_KEY, JSON.stringify(state));
  }
}
