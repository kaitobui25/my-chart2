import type { JapanMarketDatafeed } from './japan-market-controller';
import { JAPAN_MARKET_CONFIG } from './japan-market-config';
import { createSymbolCombobox, type SymbolComboboxBinding } from './symbol-combobox';
import { WATCHLIST_CONFIG } from './watchlist-config';
import { loadWatchListQuotes } from './watchlist-market';
import { WatchListStore } from './watchlist-store';
import { WatchListView } from './watchlist-view';

export interface WatchListControllerOptions {
  feed: JapanMarketDatafeed;
  store: WatchListStore;
  view: WatchListView;
  input: HTMLInputElement;
  suggestions: HTMLDataListElement;
  addButton: HTMLButtonElement;
  pollMs?: number;
}

export class WatchListController {
  private active = false;
  private disposed = false;
  private refreshId = 0;
  private refreshTimer: number | null = null;
  private activeSymbol: string | null = null;
  private readonly combobox: SymbolComboboxBinding;
  private readonly onAddClick = () => this.combobox.commit();

  constructor(private readonly options: WatchListControllerOptions) {
    this.combobox = createSymbolCombobox({
      input: options.input,
      list: options.suggestions,
      initialSymbols: JAPAN_MARKET_CONFIG.defaultSymbols,
      debounceMs: JAPAN_MARKET_CONFIG.symbolSearchDebounceMs,
      search: (query) => options.feed.searchSymbols(query, JAPAN_MARKET_CONFIG.symbolSearchLimit),
      onCommit: (symbol) => this.add(symbol),
      onError: (message) => options.view.setStatus(message, true),
    });
    options.addButton.addEventListener('click', this.onAddClick);
    options.view.setSymbols(options.store.list());
    options.view.setStatus(`${options.store.list().length}/${WATCHLIST_CONFIG.maxSymbols} mã`);
  }

  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return;
    this.active = active;
    this.clearTimer();
    if (active) void this.refresh();
    else this.refreshId += 1;
  }

  setActiveSymbol(symbol: string | null): void {
    this.activeSymbol = symbol;
    this.options.view.setActiveSymbol(symbol);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    this.refreshId += 1;
    this.clearTimer();
    this.options.addButton.removeEventListener('click', this.onAddClick);
    this.combobox.dispose();
    this.options.view.dispose();
  }

  private add(symbol: string): void {
    const result = this.options.store.add(symbol);
    if (result === 'invalid') {
      this.options.view.setStatus('Mã Nhật không hợp lệ.', true);
      return;
    }
    if (result === 'full') {
      this.options.view.setStatus(`Watch List tối đa ${WATCHLIST_CONFIG.maxSymbols} mã.`, true);
      return;
    }
    this.options.input.value = '';
    this.syncSymbols();
    this.options.view.setStatus(result === 'exists' ? `${symbol} đã có trong Watch List.` : `Đã thêm ${symbol}.`);
    if (this.active && result === 'added') void this.refresh();
  }

  removeSymbol(symbol: string): void {
    if (!this.options.store.remove(symbol)) return;
    this.syncSymbols();
    this.options.view.setStatus(`Đã xóa ${symbol}.`);
  }

  private syncSymbols(): void {
    this.options.view.setSymbols(this.options.store.list());
    this.options.view.setActiveSymbol(this.activeSymbol);
  }

  private async refresh(): Promise<void> {
    if (!this.active || this.disposed) return;
    const requestId = ++this.refreshId;
    this.clearTimer();
    const symbols = this.options.store.list();
    if (symbols.length === 0) {
      this.options.view.setQuotes(new Map());
      this.options.view.setStatus('Watch List trống.');
      return;
    }
    this.options.view.setStatus('Đang cập nhật…');
    try {
      const quotes = await loadWatchListQuotes(this.options.feed, symbols);
      if (!this.active || this.disposed || requestId !== this.refreshId) return;
      this.options.view.setQuotes(quotes);
      this.options.view.setStatus(
        `${symbols.length}/${WATCHLIST_CONFIG.maxSymbols} mã · cập nhật ${Math.round(this.pollDelay() / 1_000)}s`,
      );
    } catch (error) {
      if (!this.active || this.disposed || requestId !== this.refreshId) return;
      this.options.view.setStatus(error instanceof Error ? error.message : 'Không thể cập nhật Watch List.', true);
    } finally {
      if (this.active && !this.disposed && requestId === this.refreshId) this.scheduleRefresh();
    }
  }

  private scheduleRefresh(): void {
    this.clearTimer();
    const delay = this.pollDelay();
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, delay);
  }

  private clearTimer(): void {
    if (this.refreshTimer === null) return;
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  private pollDelay(): number {
    return Math.max(10_000, this.options.pollMs ?? WATCHLIST_CONFIG.pollMs);
  }
}
