import type { DrawingStyle, SerializedDrawing } from '../../../src/core/drawings';
import {
  type MarketQuote,
  type OrderRequest,
  type OrderSide,
  type OrderType,
  type PaperOrder,
  MarketHub,
  PaperTradingEngine,
} from './paper';
import { localeTag, tr } from '../i18n';

interface DrawingAdapter {
  list(): { drawings: SerializedDrawing[]; selectedId: number | null };
  select(id: number | null): void;
  update(id: number, patch: { text?: string; style?: Partial<DrawingStyle> }): void;
  remove(id: number): void;
}

export interface TradingWorkspaceOptions {
  market: MarketHub;
  engine: PaperTradingEngine;
  getActiveSymbol: () => string;
  selectSymbol: (symbol: string) => void;
  drawings: DrawingAdapter;
  onWatchlistChange: (symbols: string[], addedSymbol?: string) => void;
}

const WATCHLIST_KEY = 'l2chart.watchlist.v1';
const ONE_CLICK_KEY = 'l2chart.paper.oneClick';
const DEFAULT_WATCHLIST = ['HPG', 'SSI', 'VNM', 'FPT', 'VN30F1M', 'VNINDEX'];

function el<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}`);
  return value as T;
}

function safe(text: unknown): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function number(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat(localeTag(), { maximumFractionDigits: 0 }).format(value);
}

function formatPrice(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '--';
  if (Math.abs(value) >= 1000) return value.toLocaleString(localeTag(), { maximumFractionDigits: 2 });
  return value.toFixed(value < 10 ? 3 : 2);
}

function quoteChangeClass(quote: MarketQuote | null | undefined): string {
  if (!quote) return '';
  if (quote.change > 0) return 'up';
  if (quote.change < 0) return 'down';
  return 'unchanged';
}

function drawingName(drawing: SerializedDrawing): string {
  const names: Partial<Record<SerializedDrawing['tool'], string>> = {
    trendline: 'Trend line',
    ray: 'Ray',
    arrow: 'Arrow',
    'horizontal-line': 'Horizontal line',
    'vertical-line': 'Vertical line',
    rectangle: 'Rectangle',
    text: 'Text',
    'fib-retracement': 'Fibonacci',
    'long-position': 'Long position',
    'short-position': 'Short position',
  };
  return drawing.style?.label || drawing.text || names[drawing.tool] || drawing.tool;
}

export class TradingWorkspace {
  private watchlist: string[];
  private side: OrderSide = 'buy';
  private orderType: OrderType = 'market';
  private blotterTab: 'positions' | 'orders' | 'history' = 'positions';
  private pendingOrder: OrderRequest | null = null;

  private readonly watchlistRows = el<HTMLDivElement>('watchlist-rows');
  private readonly watchlistSource = el<HTMLSpanElement>('watchlist-source');
  private readonly orderSymbol = el<HTMLElement>('order-symbol');
  private readonly orderQuote = el<HTMLElement>('order-quote');
  private readonly orderPriceRow = el<HTMLElement>('order-price-row');
  private readonly orderPrice = el<HTMLInputElement>('order-price');
  private readonly orderVolume = el<HTMLInputElement>('order-volume');
  private readonly orderTp = el<HTMLInputElement>('order-tp');
  private readonly orderSl = el<HTMLInputElement>('order-sl');
  private readonly submitOrder = el<HTMLButtonElement>('submit-order');
  private readonly orderMessage = el<HTMLDivElement>('order-message');
  private readonly oneClick = el<HTMLInputElement>('one-click');
  private readonly domLadder = el<HTMLDivElement>('dom-ladder');
  private readonly blotterTable = el<HTMLDivElement>('blotter-table');
  private readonly objectTree = el<HTMLDivElement>('object-tree');
  private readonly objectEditor = el<HTMLDivElement>('object-editor');
  private readonly objectColor = el<HTMLInputElement>('object-color');
  private readonly objectWidth = el<HTMLInputElement>('object-width');
  private readonly objectLineStyle = el<HTMLSelectElement>('object-line-style');
  private readonly objectLabel = el<HTMLInputElement>('object-label');
  private readonly objectText = el<HTMLInputElement>('object-text');

  constructor(private readonly options: TradingWorkspaceOptions) {
    this.watchlist = this.readWatchlist();
    this.oneClick.checked = localStorage.getItem(ONE_CLICK_KEY) === '1';
    this.bindTabs();
    this.bindWatchlist();
    this.bindOrderTicket();
    this.bindBlotter();
    this.bindObjects();
    options.market.onQuote((quote) => this.onQuote(quote));
    options.engine.onChange(() => this.renderTradingState());
    this.renderWatchlist();
    this.refreshActiveSymbol();
    this.renderTradingState();
    this.refreshObjects();
  }

  getWatchlist(): string[] {
    return [...this.watchlist];
  }

  setSourceLabel(label: string): void {
    this.watchlistSource.textContent = label;
  }

  refreshActiveSymbol(): void {
    const symbol = this.options.getActiveSymbol() || '--';
    this.orderSymbol.textContent = symbol;
    el<HTMLElement>('dom-symbol').textContent = `${symbol} · DOM`;
    const quote = this.options.market.get(symbol);
    this.renderActiveQuote(quote);
    this.renderDom(quote);
    this.renderWatchlist();
  }

  refreshObjects(): void {
    const { drawings, selectedId } = this.options.drawings.list();
    if (drawings.length === 0) {
      this.objectTree.innerHTML = '<div class="empty-state">Chưa có đối tượng trên chart</div>';
      this.objectEditor.hidden = true;
      return;
    }
    this.objectTree.innerHTML = drawings
      .map((drawing) => {
        const visible = drawing.style?.visible !== false;
        return `<div class="object-row${drawing.id === selectedId ? ' active' : ''}" data-object-id="${drawing.id}">
          <button class="object-visibility" data-object-action="visibility" title="${visible ? 'Ẩn' : 'Hiện'}">${visible ? '●' : '○'}</button>
          <span><strong>${safe(drawingName(drawing))}</strong><small>${safe(drawing.tool)}</small></span>
          <button class="object-delete" data-object-action="delete" title="Xóa">×</button>
        </div>`;
      })
      .join('');

    const selected = drawings.find((drawing) => drawing.id === selectedId);
    this.objectEditor.hidden = !selected;
    if (!selected) return;
    this.objectColor.value = selected.style?.color || '#91b8cb';
    this.objectWidth.value = String(selected.style?.width ?? 1.5);
    this.objectLineStyle.value = selected.style?.lineStyle ?? 'solid';
    this.objectLabel.value = selected.style?.label ?? '';
    this.objectText.value = selected.text ?? '';
  }

  private bindTabs(): void {
    el<HTMLElement>('right-tabs').addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-right-tab]');
      if (!button) return;
      el<HTMLElement>('right-tabs').querySelectorAll('button').forEach((item) => item.classList.toggle('active', item === button));
      const tab = button.dataset.rightTab;
      for (const view of ['order', 'dom', 'objects']) el<HTMLElement>(`${view}-view`).hidden = view !== tab;
      if (tab === 'objects') this.refreshObjects();
    });
    el<HTMLElement>('blotter-tabs').addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-blotter-tab]');
      if (!button) return;
      this.blotterTab = button.dataset.blotterTab as typeof this.blotterTab;
      el<HTMLElement>('blotter-tabs').querySelectorAll('[data-blotter-tab]').forEach((item) => item.classList.toggle('active', item === button));
      this.renderBlotter();
    });
  }

  private bindWatchlist(): void {
    const input = el<HTMLInputElement>('watchlist-symbol');
    const add = () => {
      const symbol = input.value.trim().toUpperCase();
      if (!symbol || this.watchlist.includes(symbol)) return;
      this.watchlist.push(symbol);
      input.value = '';
      this.saveWatchlist(symbol);
    };
    el<HTMLButtonElement>('watchlist-add').addEventListener('click', add);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') add();
    });
    this.watchlistRows.addEventListener('click', (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('[data-watchlist-symbol]');
      if (!row) return;
      const symbol = row.dataset.watchlistSymbol!;
      if ((event.target as HTMLElement).closest('[data-watchlist-remove]')) {
        this.watchlist = this.watchlist.filter((item) => item !== symbol);
        this.saveWatchlist();
        return;
      }
      this.options.selectSymbol(symbol);
      this.refreshActiveSymbol();
    });
  }

  private bindOrderTicket(): void {
    el<HTMLElement>('order-side').addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-order-side]');
      if (!button) return;
      this.side = button.dataset.orderSide as OrderSide;
      el<HTMLElement>('order-side').querySelectorAll('button').forEach((item) => item.classList.toggle('active', item === button));
      this.refreshSubmitButton();
    });
    el<HTMLElement>('order-type').addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-order-type]');
      if (!button) return;
      this.orderType = button.dataset.orderType as OrderType;
      el<HTMLElement>('order-type').querySelectorAll('button').forEach((item) => item.classList.toggle('active', item === button));
      this.orderPriceRow.hidden = this.orderType === 'market';
      const quote = this.options.market.get(this.options.getActiveSymbol());
      if (quote && this.orderType !== 'market') this.orderPrice.value = formatPrice(quote.last);
      this.refreshSubmitButton();
    });
    el<HTMLElement>('volume-presets').addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-volume]');
      if (button) this.orderVolume.value = button.dataset.volume ?? '100';
    });
    this.oneClick.addEventListener('change', () => localStorage.setItem(ONE_CLICK_KEY, this.oneClick.checked ? '1' : '0'));
    this.submitOrder.addEventListener('click', () => this.requestOrder());
    el<HTMLButtonElement>('order-confirm-cancel').addEventListener('click', () => this.closeConfirmation());
    el<HTMLButtonElement>('order-confirm-submit').addEventListener('click', () => {
      if (this.pendingOrder) this.placeOrder(this.pendingOrder);
      this.closeConfirmation();
    });
    el<HTMLElement>('order-confirm-overlay').addEventListener('pointerdown', (event) => {
      if (event.target === el<HTMLElement>('order-confirm-overlay')) this.closeConfirmation();
    });
    this.refreshSubmitButton();
  }

  private bindBlotter(): void {
    el<HTMLButtonElement>('close-all').addEventListener('click', () => this.options.engine.closeAll());
    this.blotterTable.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-row-action]');
      if (!target) return;
      const id = target.dataset.rowId!;
      if (target.dataset.rowAction === 'close') this.options.engine.closePosition(id);
      if (target.dataset.rowAction === 'cancel') this.options.engine.cancelOrder(id);
      if (target.dataset.rowAction === 'modify') {
        const order = this.options.engine.getOrders().find((item) => item.id === id);
        if (!order) return;
        const value = window.prompt(tr('Giá mới'), String(order.price ?? ''));
        if (value !== null) this.options.engine.modifyOrder(id, { price: number(value) });
      }
    });
  }

  private bindObjects(): void {
    this.objectTree.addEventListener('click', (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('[data-object-id]');
      if (!row) return;
      const id = Number(row.dataset.objectId);
      const action = (event.target as HTMLElement).closest<HTMLElement>('[data-object-action]')?.dataset.objectAction;
      if (action === 'delete') this.options.drawings.remove(id);
      else if (action === 'visibility') {
        const drawing = this.options.drawings.list().drawings.find((item) => item.id === id);
        this.options.drawings.update(id, { style: { visible: drawing?.style?.visible === false } });
      } else this.options.drawings.select(id);
      this.refreshObjects();
    });
    const updateStyle = () => {
      const id = this.options.drawings.list().selectedId;
      if (id === null) return;
      this.options.drawings.update(id, {
        style: {
          color: this.objectColor.value,
          width: Number(this.objectWidth.value),
          lineStyle: this.objectLineStyle.value as DrawingStyle['lineStyle'],
          label: this.objectLabel.value,
        },
        text: this.objectText.value,
      });
    };
    for (const input of [this.objectColor, this.objectWidth, this.objectLineStyle, this.objectLabel, this.objectText]) {
      input.addEventListener('input', updateStyle);
      input.addEventListener('change', updateStyle);
    }
  }

  private requestOrder(): void {
    const request: OrderRequest = {
      symbol: this.options.getActiveSymbol(),
      side: this.side,
      type: this.orderType,
      volume: Math.max(0, Math.floor(Number(this.orderVolume.value))),
      price: this.orderType === 'market' ? undefined : number(this.orderPrice.value),
      takeProfit: number(this.orderTp.value),
      stopLoss: number(this.orderSl.value),
    };
    if (this.oneClick.checked) {
      this.placeOrder(request);
      return;
    }
    this.pendingOrder = request;
    el<HTMLElement>('order-confirm-summary').innerHTML = `
      <strong class="${request.side}">${request.side === 'buy' ? tr('Mua').toUpperCase() : tr('Bán').toUpperCase()} ${safe(request.symbol)}</strong>
      <span>${formatMoney(request.volume)} cp · ${safe(request.type.toUpperCase())}</span>
      <span>${request.price ? `@ ${formatPrice(request.price)}` : tr('Theo giá thị trường')}</span>`;
    el<HTMLElement>('order-confirm-overlay').hidden = false;
  }

  private placeOrder(request: OrderRequest): void {
    const order = this.options.engine.submit(request);
    this.orderMessage.className = order.status === 'rejected' ? 'error' : 'success';
    this.orderMessage.textContent = order.status === 'rejected' ? order.message ?? tr('Lệnh bị từ chối') : `${tr('Đã gửi')} ${order.id}`;
  }

  private closeConfirmation(): void {
    this.pendingOrder = null;
    el<HTMLElement>('order-confirm-overlay').hidden = true;
  }

  private onQuote(quote: MarketQuote): void {
    this.renderWatchlistQuote(quote);
    if (quote.symbol !== this.options.getActiveSymbol()) return;
    this.renderActiveQuote(quote);
    this.renderDom(quote);
  }

  private renderWatchlist(): void {
    const active = this.options.getActiveSymbol();
    this.watchlistRows.innerHTML = this.watchlist
      .map((symbol) => {
        const quote = this.options.market.get(symbol);
        const changeClass = quoteChangeClass(quote);
        return `<div class="watchlist-row${symbol === active ? ' active' : ''}" data-watchlist-symbol="${safe(symbol)}">
          <span><strong>${safe(symbol)}</strong><button data-watchlist-remove title="Xóa">×</button></span>
          <span data-watchlist-price class="${changeClass}">${quote ? formatPrice(quote.last) : '--'}</span>
          <span data-watchlist-change class="${changeClass}">${quote ? `${quote.changePct >= 0 ? '+' : ''}${quote.changePct.toFixed(2)}` : '--'}</span>
        </div>`;
      })
      .join('');
  }

  private renderWatchlistQuote(quote: MarketQuote): void {
    const row = this.watchlistRows.querySelector<HTMLElement>(
      `[data-watchlist-symbol="${CSS.escape(quote.symbol)}"]`,
    );
    if (!row) return;
    const changeClass = quoteChangeClass(quote);
    const price = row.querySelector<HTMLElement>('[data-watchlist-price]');
    const change = row.querySelector<HTMLElement>('[data-watchlist-change]');
    if (price) {
      price.className = changeClass;
      price.textContent = formatPrice(quote.last);
    }
    if (change) {
      change.className = changeClass;
      change.textContent = `${quote.changePct >= 0 ? '+' : ''}${quote.changePct.toFixed(2)}`;
    }
  }

  private renderActiveQuote(quote: MarketQuote | null): void {
    this.orderQuote.textContent = quote?.hasBidAsk
      ? `${formatPrice(quote.bid)} / ${formatPrice(quote.ask)}`
      : '-- / --';
    if (quote && this.orderType !== 'market' && !this.orderPrice.matches(':focus')) {
      this.orderPrice.value = formatPrice(quote.last);
    }
  }

  private renderDom(quote: MarketQuote | null): void {
    if (!quote) {
      this.domLadder.innerHTML = '<div class="empty-state">Đang chờ giá</div>';
      return;
    }
    const levels: { side: 'ask' | 'bid'; price: number; volume: number }[] = [];
    if (!quote.hasBidAsk || !quote.bids?.length || !quote.asks?.length) {
      this.domLadder.innerHTML = '<div class="empty-state">Chưa có dữ liệu dư mua / dư bán</div>';
      return;
    }
    levels.push(
      ...quote.asks.slice(0, 6).reverse().map((level) => ({ side: 'ask' as const, ...level })),
      ...quote.bids.slice(0, 6).map((level) => ({ side: 'bid' as const, ...level })),
    );
    const maxVolume = Math.max(...levels.map((level) => level.volume));
    this.domLadder.innerHTML = levels
      .map((level) => `<button class="dom-row ${level.side}" data-dom-price="${level.price}">
        <span class="dom-depth" style="width:${(level.volume / maxVolume) * 100}%"></span>
        <strong>${formatPrice(level.price)}</strong><span>${formatMoney(level.volume)}</span>
      </button>`)
      .join('');
    this.domLadder.querySelectorAll<HTMLButtonElement>('[data-dom-price]').forEach((button) => {
      button.addEventListener('click', () => {
        this.orderType = 'limit';
        this.orderPrice.value = button.dataset.domPrice ?? '';
        this.orderPriceRow.hidden = false;
        el<HTMLElement>('right-tabs').querySelector<HTMLButtonElement>('[data-right-tab="order"]')?.click();
        el<HTMLElement>('order-type').querySelector<HTMLButtonElement>('[data-order-type="limit"]')?.click();
      });
    });
  }

  private renderTradingState(): void {
    const account = this.options.engine.getAccount();
    el<HTMLElement>('account-equity').textContent = formatMoney(account.equity);
    el<HTMLElement>('account-balance').textContent = formatMoney(account.balance);
    el<HTMLElement>('account-margin').textContent = formatMoney(account.usedMargin);
    el<HTMLElement>('account-free').textContent = formatMoney(account.freeMargin);
    const pnl = el<HTMLElement>('account-pnl');
    const totalPnl = account.realizedPnl + account.unrealizedPnl;
    pnl.textContent = `${totalPnl >= 0 ? '+' : ''}${formatMoney(totalPnl)}`;
    pnl.className = totalPnl > 0 ? 'up' : totalPnl < 0 ? 'down' : '';
    pnl.title = `${tr('Đã chốt')}: ${formatMoney(account.realizedPnl)} · ${tr('Đang mở')}: ${formatMoney(account.unrealizedPnl)}`;
    const positions = this.options.engine.getPositions();
    const working = this.options.engine.getOrders().filter((order) => order.status === 'working');
    el<HTMLElement>('positions-count').textContent = positions.length ? String(positions.length) : '';
    el<HTMLElement>('orders-count').textContent = working.length ? String(working.length) : '';
    el<HTMLButtonElement>('close-all').disabled = positions.length === 0;
    this.renderBlotter();
  }

  private renderBlotter(): void {
    if (this.blotterTab === 'positions') {
      const positions = this.options.engine.getPositions();
      this.blotterTable.innerHTML = positions.length
        ? `<table><thead><tr><th>Mã</th><th>Phía</th><th>KL</th><th>Giá vào</th><th>Hiện tại</th><th>P&amp;L</th><th>SL / TP</th><th></th></tr></thead><tbody>${positions.map((position) => `<tr>
          <td><strong>${safe(position.symbol)}</strong></td><td class="${position.side}">${position.side === 'buy' ? 'Mua' : 'Bán'}</td><td>${formatMoney(position.volume)}</td>
          <td>${formatPrice(position.entryPrice)}</td><td>${formatPrice(position.currentPrice)}</td><td class="${position.unrealizedPnl >= 0 ? 'up' : 'down'}">${position.unrealizedPnl >= 0 ? '+' : ''}${formatMoney(position.unrealizedPnl)}</td>
          <td>${formatPrice(position.stopLoss)} / ${formatPrice(position.takeProfit)}</td><td><button data-row-action="close" data-row-id="${position.id}">Đóng</button></td>
        </tr>`).join('')}</tbody></table>`
        : '<div class="empty-state">Chưa có vị thế paper</div>';
      return;
    }
    if (this.blotterTab === 'orders') {
      const orders = this.options.engine.getOrders();
      this.blotterTable.innerHTML = orders.length
        ? `<table><thead><tr><th>Mã</th><th>Phía</th><th>Loại</th><th>KL</th><th>Giá</th><th>Trạng thái</th><th></th></tr></thead><tbody>${orders.map((order: PaperOrder) => `<tr>
          <td><strong>${safe(order.symbol)}</strong></td><td class="${order.side}">${order.side === 'buy' ? 'Mua' : 'Bán'}</td><td>${safe(order.type)}</td><td>${formatMoney(order.volume)}</td>
          <td>${formatPrice(order.fillPrice ?? order.price)}</td><td>${safe(order.status)}</td><td>${order.status === 'working' ? `<button data-row-action="modify" data-row-id="${order.id}">Sửa</button><button data-row-action="cancel" data-row-id="${order.id}">Hủy</button>` : ''}</td>
        </tr>`).join('')}</tbody></table>`
        : '<div class="empty-state">Chưa có lệnh paper</div>';
      return;
    }
    const trades = this.options.engine.getTrades();
    this.blotterTable.innerHTML = trades.length
      ? `<table><thead><tr><th>Thời gian</th><th>Mã</th><th>Phía</th><th>KL</th><th>Vào</th><th>Ra</th><th>P&amp;L</th><th>Lý do</th></tr></thead><tbody>${trades.map((trade) => `<tr>
        <td>${new Date(trade.closedAt).toLocaleString(localeTag())}</td><td><strong>${safe(trade.symbol)}</strong></td><td class="${trade.side}">${trade.side === 'buy' ? tr('Mua') : tr('Bán')}</td>
        <td>${formatMoney(trade.volume)}</td><td>${formatPrice(trade.entryPrice)}</td><td>${formatPrice(trade.exitPrice)}</td><td class="${trade.pnl >= 0 ? 'up' : 'down'}">${trade.pnl >= 0 ? '+' : ''}${formatMoney(trade.pnl)}</td><td>${safe(trade.reason)}</td>
      </tr>`).join('')}</tbody></table>`
      : '<div class="empty-state">Chưa có lịch sử khớp lệnh</div>';
  }

  private refreshSubmitButton(): void {
    const sideText = this.side === 'buy' ? tr('Mua') : tr('Bán');
    this.submitOrder.textContent = `${sideText} ${this.orderType}`;
    this.submitOrder.className = `submit-order ${this.side}`;
  }

  private readWatchlist(): string[] {
    try {
      const parsed = JSON.parse(localStorage.getItem(WATCHLIST_KEY) ?? 'null');
      return Array.isArray(parsed) && parsed.length ? parsed.map(String) : [...DEFAULT_WATCHLIST];
    } catch {
      return [...DEFAULT_WATCHLIST];
    }
  }

  private saveWatchlist(addedSymbol?: string): void {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(this.watchlist));
    this.renderWatchlist();
    this.options.onWatchlistChange(this.getWatchlist(), addedSymbol);
  }
}
