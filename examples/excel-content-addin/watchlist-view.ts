import type { WatchListQuote } from './watchlist-market';

export interface WatchListViewElements {
  list: HTMLElement;
  empty: HTMLElement;
  count: HTMLElement;
  status: HTMLElement;
}

export interface WatchListViewCallbacks {
  onOpen(symbol: string): void;
  onRemove(symbol: string): void;
}

export class WatchListView {
  private readonly rows = new Map<string, HTMLElement>();
  private activeSymbol: string | null = null;
  private readonly onClick = (event: Event) => this.handleClick(event);

  constructor(
    private readonly elements: WatchListViewElements,
    private readonly callbacks: WatchListViewCallbacks,
  ) {
    elements.list.addEventListener('click', this.onClick);
  }

  setSymbols(symbols: readonly string[]): void {
    const wanted = new Set(symbols);
    for (const [symbol, row] of this.rows) {
      if (wanted.has(symbol)) continue;
      row.remove();
      this.rows.delete(symbol);
    }

    for (const symbol of symbols) {
      let row = this.rows.get(symbol);
      if (!row) {
        row = this.createRow(symbol);
        this.rows.set(symbol, row);
      }
      this.elements.list.appendChild(row);
      this.updateActiveState(row, symbol);
    }

    this.elements.count.textContent = `${symbols.length}`;
    this.elements.empty.hidden = symbols.length > 0;
  }

  setQuotes(quotes: ReadonlyMap<string, WatchListQuote>): void {
    for (const [symbol, row] of this.rows) {
      this.updateQuote(row, quotes.get(symbol) ?? null);
    }
  }

  setActiveSymbol(symbol: string | null): void {
    this.activeSymbol = symbol;
    for (const [rowSymbol, row] of this.rows) this.updateActiveState(row, rowSymbol);
  }

  setStatus(message: string, error = false): void {
    this.elements.status.textContent = message;
    this.elements.status.dataset.state = error ? 'error' : 'ready';
  }

  dispose(): void {
    this.elements.list.removeEventListener('click', this.onClick);
    this.rows.clear();
  }

  private createRow(symbol: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'watchlist-row';
    row.dataset.symbol = symbol;
    row.setAttribute('role', 'listitem');
    row.innerHTML = `
      <button class="watchlist-open" type="button" data-action="open" aria-label="Mở ${symbol} trên chart">
        <strong class="watchlist-symbol"></strong>
      </button>
      <span class="watchlist-price">—</span>
      <span class="watchlist-change">—</span>
      <button class="watchlist-remove" type="button" data-action="remove" aria-label="Xóa ${symbol} khỏi Watch List">×</button>
    `;
    const symbolElement = row.querySelector<HTMLElement>('.watchlist-symbol');
    if (symbolElement) symbolElement.textContent = symbol;
    return row;
  }

  private updateQuote(row: HTMLElement, quote: WatchListQuote | null): void {
    const price = row.querySelector<HTMLElement>('.watchlist-price');
    const change = row.querySelector<HTMLElement>('.watchlist-change');
    if (!price || !change) return;
    if (!quote) {
      price.textContent = '—';
      change.textContent = '—';
      change.dataset.tone = 'flat';
      return;
    }
    price.textContent = formatNumber(quote.price);
    const sign = quote.change > 0 ? '+' : '';
    change.textContent = `${sign}${quote.changePercent.toFixed(2)}%`;
    change.dataset.tone = quote.change > 0 ? 'up' : quote.change < 0 ? 'down' : 'flat';
    row.title = `Cập nhật ${formatTime(quote.time)} · Δ ${sign}${formatNumber(quote.change)}`;
  }

  private updateActiveState(row: HTMLElement, symbol: string): void {
    row.dataset.active = symbol === this.activeSymbol ? 'true' : 'false';
  }

  private handleClick(event: Event): void {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-action]') : null;
    const row = target?.closest<HTMLElement>('.watchlist-row');
    const symbol = row?.dataset.symbol;
    if (!target || !symbol) return;
    if (target.dataset.action === 'open') this.callbacks.onOpen(symbol);
    if (target.dataset.action === 'remove') this.callbacks.onRemove(symbol);
  }
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

function formatTime(timestampSeconds: number): string {
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(timestampSeconds * 1_000));
}
