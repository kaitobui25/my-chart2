import { normalizeYFinanceJapanSymbol } from '../providers/yfinance-jp';
import { instrumentFor, marketSessionOpen, quantityDecimals, roundToTick, validIncrement, validPrice } from '../workstation/trading/instruments';
import type { OrderRequest, PaperOrder, PaperPosition, TradeRecord } from '../workstation/trading/paper';
import { ExcelPaperMarketBridge } from './paper-market-bridge';

const EXECUTION_KEY = 'l2chart.paper.execution.v1';

function el<T extends HTMLElement>(root: HTMLElement, id: string): T {
  const found = root.querySelector<T>(`#${id}`);
  if (!found) throw new Error(`Missing Excel paper element #${id}`);
  return found;
}

function format(value: number | null | undefined, currency = '', decimals?: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  const digits = decimals ?? (currency === 'USD' ? 2 : 0);
  return `${new Intl.NumberFormat('vi-VN', { maximumFractionDigits: digits }).format(value)}${currency ? ` ${currency}` : ''}`;
}

function quantity(value: number, step: number): string {
  const decimals = String(step).split('.')[1]?.length ?? 0;
  return format(value, '', decimals);
}

function optionalPrice(input: HTMLInputElement): number | undefined {
  if (!input.value.trim()) return undefined;
  const value = Number(input.value);
  return Number.isFinite(value) ? value : NaN;
}

export class ExcelPaperTradingController {
  private readonly symbol: HTMLSelectElement;
  private readonly volume: HTMLInputElement;
  private readonly orderPrice: HTMLInputElement;
  private readonly type: HTMLSelectElement;
  private readonly side: HTMLSelectElement;
  private readonly tp: HTMLInputElement;
  private readonly sl: HTMLInputElement;
  private readonly submit: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly confirmation: HTMLElement;
  private readonly listeners: Array<() => void> = [];
  private readonly offEngine: () => void;
  private readonly offQuotes: () => void;
  private readonly refreshTimer: ReturnType<typeof setInterval>;
  private pending: OrderRequest | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly bridge: ExcelPaperMarketBridge,
  ) {
    this.symbol = el(root, 'trade-symbol');
    this.volume = el(root, 'trade-volume');
    this.orderPrice = el(root, 'trade-price');
    this.type = el(root, 'trade-type');
    this.side = el(root, 'trade-side');
    this.tp = el(root, 'trade-tp');
    this.sl = el(root, 'trade-sl');
    this.submit = el(root, 'trade-submit');
    this.status = el(root, 'trade-status');
    this.confirmation = el(document.body, 'trade-confirm-overlay');

    this.listen(this.symbol, 'change', () => this.selectSymbol(this.symbol.value));
    this.listen(this.type, 'change', () => {
      el(root, 'trade-price-row').hidden = this.type.value === 'market';
      this.refresh();
    });
    for (const element of [this.volume, this.orderPrice, this.side, this.tp, this.sl]) {
      this.listen(element, 'input', () => this.refresh());
      this.listen(element, 'change', () => this.refresh());
    }
    this.listen(this.submit, 'click', () => this.requestOrder());
    this.listen(el(root, 'trade-positions'), 'click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-close-position]');
      if (!button) return;
      const success = this.bridge.engine.closePosition(button.dataset.closePosition ?? '');
      this.message(success ? 'Đã đóng vị thế paper.' : 'Không thể đóng: thiếu giá hợp lệ hoặc ngoài phiên.', !success);
    });
    this.listen(el(root, 'trade-orders'), 'click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-cancel-order]');
      if (!button) return;
      const success = this.bridge.engine.cancelOrder(button.dataset.cancelOrder ?? '');
      this.message(success ? 'Đã hủy lệnh paper.' : 'Lệnh không còn trạng thái chờ.', !success);
    });
    const cancel = el<HTMLButtonElement>(document.body, 'trade-confirm-cancel');
    const confirm = el<HTMLButtonElement>(document.body, 'trade-confirm-submit');
    this.listen(cancel, 'click', () => this.closeConfirmation());
    this.listen(confirm, 'click', () => {
      const request = this.pending;
      this.closeConfirmation();
      if (!request) return;
      const result = this.bridge.engine.submit(request);
      this.message(result.status === 'rejected'
        ? result.message ?? 'Lệnh bị từ chối.'
        : result.status === 'filled'
          ? `Đã khớp ${request.symbol} @ ${format(result.fillPrice)}.`
          : `Lệnh ${request.type} đã được đặt và đang chờ khớp.`,
      result.status === 'rejected');
    });
    this.listen(this.confirmation, 'click', (event) => {
      if (event.target === this.confirmation) this.closeConfirmation();
    });
    this.listen(document, 'keydown', (event) => {
      if (event instanceof KeyboardEvent && event.key === 'Escape' && !this.confirmation.hidden) {
        this.closeConfirmation();
      }
    });

    this.loadExecution();
    this.offEngine = this.bridge.engine.onChange(() => this.refresh());
    this.offQuotes = this.bridge.hub.onQuote(() => this.refresh());
    this.refreshTimer = setInterval(() => this.refresh(), 15_000);
    this.selectSymbol(this.symbol.value);
  }

  setMarketSymbol(value: string): void {
    const symbol = normalizeYFinanceJapanSymbol(value);
    if (symbol) this.selectSymbol(symbol);
  }

  /** Update the visible Trade tab; quotes and execution continue in the background. */
  refresh(): void {
    if (this.root.hidden || document.hidden) return;
    this.render();
  }

  dispose(): void {
    this.closeConfirmation();
    clearInterval(this.refreshTimer);
    this.offEngine();
    this.offQuotes();
    for (const stop of this.listeners) stop();
  }

  private listen(target: EventTarget, type: string, listener: (event: Event) => void): void {
    target.addEventListener(type, listener);
    this.listeners.push(() => target.removeEventListener(type, listener));
  }

  private selectSymbol(value: string): void {
    const symbol = normalizeYFinanceJapanSymbol(value);
    if (!symbol) return;
    if (![...this.symbol.options].some((option) => option.value === symbol)) {
      const option = new Option(symbol, symbol);
      this.symbol.add(option);
    }
    this.symbol.value = symbol;
    this.bridge.setSymbol(symbol);
    const spec = instrumentFor(symbol);
    this.volume.min = String(spec.minQuantity);
    this.volume.step = String(spec.quantityStep);
    this.volume.value = String(spec.minQuantity);
    el(this.root, 'trade-unit').textContent = spec.unit;
    for (const price of [this.orderPrice, this.tp, this.sl]) {
      price.step = String(spec.tickSize);
      price.min = String(spec.tickSize);
      price.value = '';
    }
    el(this.root, 'trade-rules').textContent =
      `Min ${spec.minQuantity} ${spec.unit} · bước ${spec.quantityStep} · tick ${spec.tickSize} · multiplier ×${spec.multiplier} · margin ${spec.marginRate * 100}%`;
    this.refresh();
  }

  private loadExecution(): void {
    const fields = ['trade-spread', 'trade-slippage', 'trade-commission']
      .map((id) => el<HTMLInputElement>(this.root, id));
    try {
      const stored = JSON.parse(localStorage.getItem(EXECUTION_KEY) ?? 'null') as number[] | null;
      if (Array.isArray(stored) && stored.length === 3) {
        fields.forEach((field, index) => {
          const saved = Number(stored[index]);
          if (Number.isFinite(saved)) field.value = String(Math.max(0, Math.min(1000, saved)));
        });
      }
    } catch { /* Bad local settings reset to the defaults shown in the form. */ }
    const apply = () => {
      const values = fields.map((field) => {
        const value = Number(field.value);
        return Number.isFinite(value) ? Math.max(0, Math.min(1000, value)) : 0;
      });
      this.bridge.engine.setExecution({
        spreadBps: values[0], slippageBps: values[1], commissionBps: values[2],
      });
      localStorage.setItem(EXECUTION_KEY, JSON.stringify(values));
      this.refresh();
    };
    fields.forEach((field) => this.listen(field, 'change', apply));
    apply();
  }

  private requestOrder(): void {
    const symbol = this.symbol.value;
    const spec = instrumentFor(symbol);
    const volume = Number(this.volume.value);
    const type = this.type.value as OrderRequest['type'];
    const price = type === 'market' ? undefined : optionalPrice(this.orderPrice);
    const takeProfit = optionalPrice(this.tp);
    const stopLoss = optionalPrice(this.sl);
    if (!validIncrement(volume, spec.minQuantity, spec.quantityStep)) {
      this.message(`Khối lượng tối thiểu ${spec.minQuantity} ${spec.unit}, bước ${spec.quantityStep}.`, true);
      return;
    }
    if (type !== 'market' && !validPrice(price, spec)) {
      this.message(`Giá ${type} phải đúng bước ${spec.tickSize}.`, true);
      return;
    }
    if ([takeProfit, stopLoss].some((value) => value !== undefined && !validPrice(value, spec))) {
      this.message(`TP/SL phải đúng bước ${spec.tickSize}.`, true);
      return;
    }
    if (type === 'market') {
      const quote = this.bridge.getQuote(symbol);
      if (!quote || quote.tradable === false || !quote.receivedAt
        || Date.now() - quote.receivedAt > 150_000
        || Date.now() - quote.time * 1000 > 86_400_000
        || !marketSessionOpen(spec, Date.now())) {
        this.message('Giá Yahoo chưa sẵn sàng, đã cũ hoặc ngoài phiên giao dịch.', true);
        return;
      }
    }
    this.pending = {
      symbol, side: this.side.value as OrderRequest['side'], type, volume,
      price, takeProfit, stopLoss,
    };
    const estimate = this.bridge.engine.estimateOrder(symbol, volume, price);
    el(this.confirmation, 'trade-confirm-summary').textContent =
      `${this.pending.side.toUpperCase()} ${type.toUpperCase()} · ${symbol} · ${volume} ${spec.unit}`
      + (price ? ` @ ${price}` : '')
      + ` · margin ≈ ${format(estimate?.margin, spec.accountCurrency)}`;
    this.confirmation.hidden = false;
    el<HTMLButtonElement>(this.confirmation, 'trade-confirm-submit').focus();
  }

  private closeConfirmation(): void {
    this.pending = null;
    this.confirmation.hidden = true;
  }

  private message(text: string, error = false): void {
    this.status.textContent = text;
    this.status.dataset.state = error ? 'error' : 'success';
  }

  private render(): void {
    const symbol = this.symbol.value;
    const spec = instrumentFor(symbol);
    const quote = this.bridge.getQuote(symbol);
    const latest = el(this.root, 'trade-quote');
    latest.textContent = quote ? `${format(quote.last, spec.currency, quantityDecimals(spec) + 3)} · ${new Date(quote.time * 1000).toLocaleString('vi-VN')}` : 'Chờ báo giá Yahoo';
    latest.dataset.state = quote?.tradable === false || !quote || !quote.receivedAt
      || Date.now() - quote.receivedAt > 150_000
      || Date.now() - quote.time * 1000 > 86_400_000
      || !marketSessionOpen(spec, Date.now()) ? 'stale' : 'ready';
    const price = this.type.value === 'market' ? undefined : optionalPrice(this.orderPrice);
    const volume = Number(this.volume.value);
    if (this.type.value !== 'market' && !this.orderPrice.value && quote) {
      this.orderPrice.value = String(roundToTick(quote.last, spec));
    }
    const estimate = this.bridge.engine.estimateOrder(symbol, volume, price ?? undefined);
    el(this.root, 'trade-estimate').textContent = estimate
      ? `Giá trị ≈ ${format(estimate.notional, estimate.currency)} · margin ≈ ${format(estimate.margin, estimate.accountCurrency)} · phí ≈ ${format(estimate.fee, estimate.accountCurrency)}`
      : 'Chưa có giá để ước tính lệnh.';
    const account = this.bridge.engine.getAccount(symbol);
    el(this.root, 'trade-equity').textContent = format(account.equity, account.currency);
    el(this.root, 'trade-balance').textContent = format(account.balance, account.currency);
    el(this.root, 'trade-margin').textContent = format(account.usedMargin, account.currency);
    el(this.root, 'trade-available').textContent = format(account.freeMargin, account.currency);
    el(this.root, 'trade-account-note').textContent = account.warning ?? '';
    this.renderItems();
  }

  private renderItems(): void {
    this.renderList('trade-positions', this.bridge.engine.getPositions(), (position) => this.positionRow(position));
    this.renderList('trade-orders', this.bridge.engine.getOrders().filter((order) => order.status === 'working'),
      (order) => this.orderRow(order));
    this.renderList('trade-history', this.bridge.engine.getTrades().slice(0, 30),
      (trade) => this.historyRow(trade));
  }

  private renderList<T>(id: string, items: T[], create: (item: T) => HTMLElement): void {
    const node = el(this.root, id);
    if (!items.length) {
      const empty = document.createElement('small');
      empty.textContent = 'Chưa có.';
      node.replaceChildren(empty);
      return;
    }
    node.replaceChildren(...items.map(create));
  }

  private row(title: string, details: string, action?: { text: string; key: string; id: string }): HTMLElement {
    const row = document.createElement('div');
    row.className = 'trade-row';
    const copy = document.createElement('span');
    const heading = document.createElement('strong');
    heading.textContent = title;
    const info = document.createElement('small');
    info.textContent = details;
    copy.append(heading, info);
    row.append(copy);
    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.text;
      button.dataset[action.key] = action.id;
      row.append(button);
    }
    return row;
  }

  private positionRow(position: PaperPosition): HTMLElement {
    const spec = position.instrument ?? instrumentFor(position.symbol);
    return this.row(`${position.symbol} · ${position.side.toUpperCase()} · ${quantity(position.volume, spec.quantityStep)} ${spec.unit}`,
      `Vào ${format(position.entryPrice)} · P&L ${format(position.unrealizedPnl, spec.currency, 2)}`,
      { text: 'Đóng', key: 'closePosition', id: position.id });
  }

  private orderRow(order: PaperOrder): HTMLElement {
    const spec = order.instrument ?? instrumentFor(order.symbol);
    return this.row(`${order.symbol} · ${order.side.toUpperCase()} ${order.type.toUpperCase()}`,
      `${quantity(order.volume, spec.quantityStep)} ${spec.unit} @ ${format(order.price)}`,
      { text: 'Hủy', key: 'cancelOrder', id: order.id });
  }

  private historyRow(trade: TradeRecord): HTMLElement {
    const spec = instrumentFor(trade.symbol);
    return this.row(`${trade.symbol} · ${trade.side.toUpperCase()} · ${quantity(trade.volume, spec.quantityStep)} ${spec.unit}`,
      `${new Date(trade.closedAt).toLocaleString('vi-VN')} · P&L ${format(trade.pnl, trade.pnlCurrency ?? spec.currency, 2)} · ${trade.reason}`);
  }
}
