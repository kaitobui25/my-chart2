import type { SymbolSearchResult } from '../../src/datafeed';
import { normalizeYFinanceJapanSymbol } from '../providers/yfinance-jp';

export interface SymbolComboboxOptions {
  input: HTMLInputElement;
  list: HTMLDataListElement;
  initialSymbols: readonly string[];
  debounceMs: number;
  search(query: string): Promise<SymbolSearchResult[]>;
  onCommit(symbol: string): void;
  onError(message: string): void;
}

export interface SymbolComboboxBinding {
  commit(): void;
  dispose(): void;
}

export function createSymbolCombobox(options: SymbolComboboxOptions): SymbolComboboxBinding {
  let timer: number | null = null;
  let requestId = 0;

  renderOptions(options.initialSymbols.map((symbol) => ({ symbol })));

  const scheduleSearch = () => {
    if (timer !== null) window.clearTimeout(timer);
    const currentRequest = ++requestId;
    const query = options.input.value.trim();
    if (!query) {
      renderOptions(options.initialSymbols.map((symbol) => ({ symbol })));
      return;
    }

    timer = window.setTimeout(() => {
      timer = null;
      void options.search(query).then((items) => {
        if (currentRequest !== requestId) return;
        renderOptions(items.length > 0 ? items : options.initialSymbols.map((symbol) => ({ symbol })));
      }).catch((error) => {
        if (currentRequest !== requestId) return;
        options.onError(error instanceof Error ? error.message : 'Không thể tìm mã Nhật.');
      });
    }, options.debounceMs);
  };

  const commit = () => {
    const symbol = normalizeYFinanceJapanSymbol(options.input.value);
    if (!symbol) {
      options.onError('Mã Nhật phải là mã TSE 4 ký tự.');
      return;
    }
    options.input.value = symbol;
    options.onCommit(symbol);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commit();
  };

  options.input.addEventListener('input', scheduleSearch);
  options.input.addEventListener('change', commit);
  options.input.addEventListener('keydown', onKeyDown);

  return {
    commit,
    dispose() {
      if (timer !== null) window.clearTimeout(timer);
      requestId += 1;
      options.input.removeEventListener('input', scheduleSearch);
      options.input.removeEventListener('change', commit);
      options.input.removeEventListener('keydown', onKeyDown);
    },
  };

  function renderOptions(items: readonly Partial<SymbolSearchResult>[]): void {
    const fragment = document.createDocumentFragment();
    const seen = new Set<string>();
    for (const item of items) {
      const symbol = normalizeYFinanceJapanSymbol(String(item.symbol ?? ''));
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      const option = document.createElement('option');
      option.value = symbol;
      option.label = [item.name, item.exchange].filter(Boolean).join(' · ');
      fragment.appendChild(option);
    }
    options.list.replaceChildren(fragment);
  }
}

export function bindSymbolCombobox(options: SymbolComboboxOptions): () => void {
  const binding = createSymbolCombobox(options);
  return () => binding.dispose();
}
