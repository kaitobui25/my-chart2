import { instrumentFor, marketSessionOpen, roundToTick, validIncrement, validPrice, type Currency, type InstrumentSpec } from './instruments';

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
  /** Updated by MarketHub on arrival; candle time can be the bar's start. */
  receivedAt?: number;
  /** False for seeded historical bars that are not executable prices. */
  tradable?: boolean;
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
  instrument?: InstrumentSpec;
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
  instrument?: InstrumentSpec;
  pnlCurrency?: Currency;
  entryFeeAccount?: number;
  entryFeeQuote?: number;
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
  pnlCurrency?: Currency;
  pnlAccount?: number;
  accountCurrency?: 'VND' | 'USD';
  fees?: number;
  openedAt: number;
  closedAt: number;
  reason: 'manual' | 'take-profit' | 'stop-loss';
}

export interface AccountSnapshot {
  currency: 'VND' | 'USD';
  ready: boolean;
  warning?: string;
  balance: number;
  equity: number | null;
  usedMargin: number | null;
  freeMargin: number | null;
  unrealizedPnl: number | null;
  realizedPnl: number;
}

interface StoredPaperState {
  version: 2;
  balanceVnd: number;
  balanceUsd: number;
  orders: PaperOrder[];
  positions: PaperPosition[];
  trades: TradeRecord[];
}

const PAPER_STORAGE_KEY = 'l2chart.paper.v1';
const PAPER_STORAGE_V2_KEY = 'l2chart.paper.v2';
const STARTING_BALANCE = 1_000_000_000;
const STARTING_USD_BALANCE = 100_000;
const MAX_QUOTE_AGE_MS = 150_000;
const MAX_YAHOO_BAR_AGE_MS = 24 * 3_600_000;
const MAX_FX_BAR_AGE_MS = 3 * 86_400_000;

export interface ExecutionSettings {
  /** Synthetic bid/ask spread when the provider only supplies OHLCV. Defaults to zero. */
  spreadBps?: number;
  slippageBps?: number;
  commissionBps?: number;
}

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
    const normalized = { ...quote, symbol: quote.symbol.trim().toUpperCase(), receivedAt: Date.now() };
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
  private balanceVnd = STARTING_BALANCE;
  private balanceUsd = STARTING_USD_BALANCE;
  private orders: PaperOrder[] = [];
  private positions: PaperPosition[] = [];
  private trades: TradeRecord[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly market: MarketHub,
    private readonly execution: ExecutionSettings = {},
  ) {
    this.restore();
    market.onQuote((quote) => this.onQuote(quote));
  }

  getInstrument(symbol: string): InstrumentSpec {
    return instrumentFor(symbol);
  }

  setExecution(settings: ExecutionSettings): void {
    const bps = (value: number | undefined) =>
      value !== undefined && Number.isFinite(value) ? Math.max(0, Math.min(1000, value)) : 0;
    this.execution.spreadBps = bps(settings.spreadBps);
    this.execution.slippageBps = bps(settings.slippageBps);
    this.execution.commissionBps = bps(settings.commissionBps);
    for (const position of this.positions) {
      const quote = this.market.get(position.symbol);
      if (!quote || quote.last <= 0) continue;
      position.currentPrice = this.executionPrice(quote, position.side === 'buy' ? 'sell' : 'buy');
      position.unrealizedPnl = this.positionPnl(position, position.currentPrice);
    }
    this.changed();
  }

  estimateOrder(symbol: string, volume: number, price?: number): {
    notional: number; currency: Currency; margin: number | null; fee: number | null;
    accountCurrency: 'VND' | 'USD';
  } | null {
    const spec = instrumentFor(symbol);
    const quote = this.market.get(spec.symbol);
    const value = price ?? quote?.last;
    if (!value || !Number.isFinite(value) || !Number.isFinite(volume) || volume <= 0) return null;
    const notional = value * volume * spec.multiplier;
    const source = quote?.source;
    return {
      notional, currency: spec.currency, accountCurrency: spec.accountCurrency,
      margin: this.accountAmount(notional * spec.marginRate, spec, source),
      fee: this.accountAmount(this.fee(value, volume, spec), spec, source),
    };
  }

  /** Convert a quoted amount into its account currency, using USD/JPY when necessary. */
  private accountAmount(amount: number, spec: InstrumentSpec, source?: string): number | null {
    if (spec.currency === spec.accountCurrency) return amount;
    if (spec.currency !== 'JPY' || spec.accountCurrency !== 'USD') return null;
    const fx = this.market.get('JPY=X');
    if (!fx || !Number.isFinite(fx.last) || fx.last <= 0) return null;
    if (source === 'Replay') {
      if (fx.source !== 'Replay') return null;
    } else if (fx.source !== 'Yahoo Japan' || Date.now() - fx.time * 1000 > MAX_FX_BAR_AGE_MS) {
      return null;
    }
    return amount / fx.last;
  }

  private validQuotePrices(quote: MarketQuote | null): quote is MarketQuote {
    if (!quote || !Number.isFinite(quote.last) || quote.last <= 0) return false;
    if (quote.hasBidAsk && (
      !Number.isFinite(quote.bid) || quote.bid <= 0
      || !Number.isFinite(quote.ask) || quote.ask <= 0
    )) return false;
    return true;
  }

  private usableQuote(quote: MarketQuote | null): quote is MarketQuote {
    if (!this.validQuotePrices(quote) || quote.tradable === false) return false;
    if (quote.source === 'Replay') return true;
    const spec = instrumentFor(quote.symbol);
    return Number.isFinite(quote.receivedAt)
      && Date.now() - quote.receivedAt! <= MAX_QUOTE_AGE_MS
      && (quote.source !== 'Yahoo Japan'
        || (Number.isFinite(quote.time) && Date.now() - quote.time * 1000 <= MAX_YAHOO_BAR_AGE_MS))
      && marketSessionOpen(spec, Date.now());
  }

  private fillTimestamp(quote: MarketQuote): number {
    return quote.source === 'Replay' ? quote.time * 1000 : Date.now();
  }

  private executionPrice(quote: MarketQuote, side: OrderSide): number {
    const spread = Math.max(0, this.execution.spreadBps ?? 0) / 20_000;
    const slip = Math.max(0, this.execution.slippageBps ?? 0) / 10_000;
    const marketSide = quote.hasBidAsk
      ? side === 'buy' ? quote.ask : quote.bid
      : quote.last * (side === 'buy' ? 1 + spread : 1 - spread);
    return roundToTick(marketSide * (side === 'buy' ? 1 + slip : 1 - slip), instrumentFor(quote.symbol));
  }

  private fee(price: number, volume: number, spec: InstrumentSpec): number {
    const bps = Math.max(0, this.execution.commissionBps ?? spec.commissionBps);
    return price * volume * spec.multiplier * bps / 10_000;
  }

  submit(request: OrderRequest): PaperOrder {
    const now = Date.now();
    const spec = instrumentFor(request.symbol);
    const order: PaperOrder = {
      ...request,
      instrument: spec,
      symbol: spec.symbol,
      volume: request.volume,
      price: finitePositive(request.price),
      takeProfit: finitePositive(request.takeProfit),
      stopLoss: finitePositive(request.stopLoss),
      id: makeId('O'),
      status: 'working',
      createdAt: now,
      updatedAt: now,
    };

    if (!validIncrement(order.volume, spec.minQuantity, spec.quantityStep)) {
      order.status = 'rejected';
      order.message = `Khối lượng tối thiểu ${spec.minQuantity} ${spec.unit}, bước ${spec.quantityStep}`;
    } else if (order.type !== 'market' && !validPrice(request.price, spec)) {
      order.status = 'rejected';
      order.message = `Giá limit/stop phải theo bước ${spec.tickSize}`;
    } else if ([request.takeProfit, request.stopLoss].some((value) => value !== undefined && !validPrice(value, spec))) {
      order.status = 'rejected';
      order.message = `Giá TP/SL phải theo bước ${spec.tickSize}`;
    }
    this.orders.unshift(order);

    if (order.status === 'working' && order.type === 'market') {
      const quote = this.market.get(order.symbol);
      if (!this.usableQuote(quote)) {
        order.status = 'rejected';
        order.message = 'Giá chưa có, đã cũ hoặc ngoài phiên giao dịch';
      } else {
        this.fillOrder(order, this.executionPrice(quote, order.side), this.fillTimestamp(quote), quote.source);
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
    const spec = order.instrument ?? instrumentFor(order.symbol);
    if (patch.volume !== undefined && !validIncrement(patch.volume, spec.minQuantity, spec.quantityStep)) return false;
    if (patch.price !== undefined && !validPrice(patch.price, spec)) return false;
    if ([patch.takeProfit, patch.stopLoss].some((value) => value !== undefined && !validPrice(value, spec))) return false;
    if (patch.volume !== undefined) order.volume = patch.volume;
    if (patch.price !== undefined) order.price = patch.price;
    if (patch.takeProfit !== undefined) order.takeProfit = patch.takeProfit;
    if (patch.stopLoss !== undefined) order.stopLoss = patch.stopLoss;
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
    if (!this.usableQuote(quote)) return false;
    const exitPrice = this.executionPrice(quote, position.side === 'buy' ? 'sell' : 'buy');
    if (!this.realizePosition(position, exitPrice, this.fillTimestamp(quote), reason, quote.source)) return false;
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

  getAccount(symbol = ''): AccountSnapshot {
    return this.accountForCurrency(instrumentFor(symbol).accountCurrency);
  }

  private accountForCurrency(currency: 'VND' | 'USD'): AccountSnapshot {
    const balance = currency === 'USD' ? this.balanceUsd : this.balanceVnd;
    const initial = currency === 'USD' ? STARTING_USD_BALANCE : STARTING_BALANCE;
    let unrealizedPnl = 0;
    let usedMargin = 0;
    let ready = true;
    for (const position of this.positions) {
      const spec = position.instrument ?? instrumentFor(position.symbol);
      if (spec.accountCurrency !== currency) continue;
      const source = this.market.get(position.symbol)?.source;
      const pnl = this.accountAmount(position.unrealizedPnl, spec, source);
      const margin = this.accountAmount(position.entryPrice * position.volume * spec.multiplier * spec.marginRate, spec, source);
      if (pnl === null || margin === null) {
        ready = false;
        continue;
      }
      unrealizedPnl += pnl;
      usedMargin += margin;
    }
    const equity = ready ? balance + unrealizedPnl : null;
    return {
      currency,
      ready,
      ...(!ready ? { warning: 'Thiếu tỷ giá JPY=X để quy đổi vị thế' } : {}),
      balance,
      equity,
      usedMargin: ready ? usedMargin : null,
      freeMargin: equity === null ? null : equity - usedMargin,
      unrealizedPnl: ready ? unrealizedPnl : null,
      realizedPnl: balance - initial,
    };
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private onQuote(quote: MarketQuote): void {
    if (!this.validQuotePrices(quote)) return;
    let dirty = false;
    const executable = this.usableQuote(quote);
    for (const position of [...this.positions]) {
      if (position.symbol !== quote.symbol) continue;
      position.currentPrice = this.executionPrice(quote, position.side === 'buy' ? 'sell' : 'buy');
      position.unrealizedPnl = this.positionPnl(position, position.currentPrice);
      dirty = true;

      if (!executable) continue;
      if (position.side === 'buy') {
        if (position.stopLoss && position.currentPrice <= position.stopLoss) {
          this.realizePosition(position, position.currentPrice, this.fillTimestamp(quote), 'stop-loss', quote.source);
        } else if (position.takeProfit && position.currentPrice >= position.takeProfit) {
          this.realizePosition(position, position.currentPrice, this.fillTimestamp(quote), 'take-profit', quote.source);
        }
      } else if (position.stopLoss && position.currentPrice >= position.stopLoss) {
        this.realizePosition(position, position.currentPrice, this.fillTimestamp(quote), 'stop-loss', quote.source);
      } else if (position.takeProfit && position.currentPrice <= position.takeProfit) {
        this.realizePosition(position, position.currentPrice, this.fillTimestamp(quote), 'take-profit', quote.source);
      }
    }

    for (const order of this.orders) {
      if (!executable || order.status !== 'working' || order.symbol !== quote.symbol || !order.price) continue;
      const price = this.executionPrice(quote, order.side);
      const fill =
        order.type === 'limit'
          ? order.side === 'buy'
            ? price <= order.price
            : price >= order.price
          : order.side === 'buy'
            ? price >= order.price
            : price <= order.price;
      if (!fill) continue;
      this.fillOrder(order, price, this.fillTimestamp(quote), quote.source);
      dirty = true;
    }
    if (dirty) this.changed();
  }

  private fillOrder(order: PaperOrder, price: number, time: number, source: string): void {
    const spec = order.instrument ?? instrumentFor(order.symbol);
    const entryFeeQuote = this.fee(price, order.volume, spec);
    const requiredMargin = this.accountAmount(price * order.volume * spec.multiplier * spec.marginRate, spec, source);
    const entryFee = this.accountAmount(entryFeeQuote, spec, source);
    const free = this.accountForCurrency(spec.accountCurrency).freeMargin;
    if (requiredMargin === null || entryFee === null || free === null) {
      order.status = 'rejected';
      order.message = 'Thiếu tỷ giá JPY=X để quy đổi margin/P&L';
      order.updatedAt = time;
      return;
    }
    if (free < requiredMargin + entryFee) {
      order.status = 'rejected';
      order.message = 'Khong du suc mua paper';
      order.updatedAt = time;
      return;
    }
    if (spec.accountCurrency === 'USD') this.balanceUsd -= entryFee;
    else this.balanceVnd -= entryFee;
    order.status = 'filled';
    order.fillPrice = price;
    order.updatedAt = time;
    const quote = this.market.get(order.symbol);
    const exitSide = order.side === 'buy' ? 'sell' : 'buy';
    const currentPrice = quote ? this.executionPrice(quote, exitSide) : price;
    const direction = order.side === 'buy' ? 1 : -1;
    this.positions.unshift({
      id: makeId('P'),
      symbol: order.symbol,
      side: order.side,
      volume: order.volume,
      entryPrice: price,
      currentPrice,
      takeProfit: order.takeProfit,
      stopLoss: order.stopLoss,
      openedAt: time,
      unrealizedPnl: (currentPrice - price) * order.volume * spec.multiplier * direction,
      instrument: spec,
      pnlCurrency: spec.currency,
      entryFeeAccount: entryFee,
      entryFeeQuote,
    });
  }

  private positionPnl(position: PaperPosition, exitPrice: number): number {
    const direction = position.side === 'buy' ? 1 : -1;
    return (exitPrice - position.entryPrice) * position.volume
      * (position.instrument ?? instrumentFor(position.symbol)).multiplier * direction;
  }

  private realizePosition(
    position: PaperPosition,
    exitPrice: number,
    closedAt: number,
    reason: TradeRecord['reason'],
    source: string,
  ): boolean {
    const spec = position.instrument ?? instrumentFor(position.symbol);
    const grossPnl = this.positionPnl(position, exitPrice);
    const exitFee = this.fee(exitPrice, position.volume, spec);
    const converted = this.accountAmount(grossPnl - exitFee, spec, source);
    if (converted === null) return false;
    if (spec.accountCurrency === 'USD') this.balanceUsd += converted;
    else this.balanceVnd += converted;
    this.positions = this.positions.filter((item) => item.id !== position.id);
    this.trades.unshift({
      id: makeId('T'),
      positionId: position.id,
      symbol: position.symbol,
      side: position.side,
      volume: position.volume,
      entryPrice: position.entryPrice,
      exitPrice,
      pnl: grossPnl - exitFee - (position.entryFeeQuote ?? 0),
      pnlCurrency: spec.currency,
      pnlAccount: converted - (position.entryFeeAccount ?? 0),
      accountCurrency: spec.accountCurrency,
      fees: exitFee + (position.entryFeeQuote ?? 0),
      openedAt: position.openedAt,
      closedAt,
      reason,
    });
    return true;
  }

  private changed(): void {
    this.persist();
    for (const listener of this.listeners) listener();
  }

  private restore(): void {
    try {
      const latest = localStorage.getItem(PAPER_STORAGE_V2_KEY);
      if (latest) {
        const state = JSON.parse(latest) as Partial<StoredPaperState>;
        if (state.version !== 2) return;
        this.balanceVnd = Number.isFinite(state.balanceVnd) ? state.balanceVnd! : STARTING_BALANCE;
        this.balanceUsd = Number.isFinite(state.balanceUsd) ? state.balanceUsd! : STARTING_USD_BALANCE;
        this.orders = Array.isArray(state.orders) ? state.orders : [];
        this.positions = Array.isArray(state.positions) ? state.positions : [];
        this.trades = Array.isArray(state.trades) ? state.trades : [];
        return;
      }
      const old = localStorage.getItem(PAPER_STORAGE_KEY);
      if (!old) return;
      const legacy = JSON.parse(old) as {
        balance?: number; orders?: PaperOrder[]; positions?: PaperPosition[]; trades?: TradeRecord[];
      };
      this.balanceVnd = Number.isFinite(legacy.balance) ? legacy.balance! : STARTING_BALANCE;
      this.orders = (legacy.orders ?? []).map((order) => ({
        ...order, instrument: { ...instrumentFor('FPT'), symbol: order.symbol },
      }));
      this.positions = (legacy.positions ?? []).map((position) => ({
        ...position, instrument: { ...instrumentFor('FPT'), symbol: position.symbol },
        pnlCurrency: 'VND' as const,
      }));
      this.trades = (legacy.trades ?? []).map((trade) => ({
        ...trade, pnlCurrency: 'VND' as const, pnlAccount: trade.pnl, accountCurrency: 'VND' as const,
      }));
      this.persist();
    } catch {
      // Invalid saved data is ignored, and the v1 key is never overwritten.
    }
  }

  private persist(): void {
    const state: StoredPaperState = {
      version: 2,
      balanceVnd: this.balanceVnd,
      balanceUsd: this.balanceUsd,
      orders: this.orders.slice(0, 200),
      positions: this.positions,
      trades: this.trades.slice(0, 500),
    };
    localStorage.setItem(PAPER_STORAGE_V2_KEY, JSON.stringify(state));
  }
}
