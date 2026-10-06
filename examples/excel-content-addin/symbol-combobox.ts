import type { SymbolSearchResult } from '../../src/datafeed';
import { normalizeYFinanceJapanSymbol } from '../providers/yfinance-jp';
import './symbol-combobox.css';

export interface SymbolComboboxOptions {
  root: HTMLElement;
  input: HTMLInputElement;
  menu: HTMLElement;
  trigger?: HTMLButtonElement;
  getSymbols(): readonly string[];
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
  let disposed = false;
  let open = false;
  let activeIndex = -1;
  let optionElements: HTMLElement[] = [];

  configureAccessibility();

  const onInput = () => {
    cancelPendingSearch();
    const query = options.input.value.trim();
    if (!query) {
      showDefaultOptions();
      return;
    }

    const currentRequest = ++requestId;
    timer = window.setTimeout(() => {
      timer = null;
      void options.search(query).then((items) => {
        if (disposed || currentRequest !== requestId) return;
        renderOptions(items.length > 0 ? items : defaultItems());
        setOpen(true);
      }).catch((error) => {
        if (disposed || currentRequest !== requestId) return;
        options.onError(error instanceof Error ? error.message : 'Không thể tìm mã Nhật.');
      });
    }, options.debounceMs);
  };

  const onChange = () => commit();

  const onFocus = () => {
    if (!open) showDefaultOptions();
  };

  const onInputPointerDown = () => {
    if (!open) showDefaultOptions();
  };

  const onTriggerClick = () => {
    if (open) {
      closeMenu();
      return;
    }
    showDefaultOptions();
    options.input.focus({ preventScroll: true });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) showDefaultOptions();
      setActiveIndex(Math.min(activeIndex + 1, optionElements.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) showDefaultOptions();
      setActiveIndex(Math.max(activeIndex - 1, 0));
      return;
    }
    if (event.key === 'Escape') {
      if (!open) return;
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const activeSymbol = optionElements[activeIndex]?.dataset.symbol;
      if (open && activeSymbol) commitValue(activeSymbol);
      else commit();
      return;
    }
    if (event.key === 'Tab') closeMenu();
  };

  const onMenuPointerDown = (event: PointerEvent) => {
    event.preventDefault();
  };

  const onMenuClick = (event: MouseEvent) => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-symbol]')
      : null;
    const symbol = target?.dataset.symbol;
    if (symbol) commitValue(symbol);
  };

  const onDocumentPointerDown = (event: PointerEvent) => {
    if (!open || options.root.contains(event.target as Node)) return;
    closeMenu();
  };

  options.input.addEventListener('input', onInput);
  options.input.addEventListener('change', onChange);
  options.input.addEventListener('focus', onFocus);
  options.input.addEventListener('pointerdown', onInputPointerDown);
  options.input.addEventListener('keydown', onKeyDown);
  options.menu.addEventListener('pointerdown', onMenuPointerDown);
  options.menu.addEventListener('click', onMenuClick);
  options.trigger?.addEventListener('click', onTriggerClick);
  document.addEventListener('pointerdown', onDocumentPointerDown);

  return {
    commit,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelPendingSearch();
      options.input.removeEventListener('input', onInput);
      options.input.removeEventListener('change', onChange);
      options.input.removeEventListener('focus', onFocus);
      options.input.removeEventListener('pointerdown', onInputPointerDown);
      options.input.removeEventListener('keydown', onKeyDown);
      options.menu.removeEventListener('pointerdown', onMenuPointerDown);
      options.menu.removeEventListener('click', onMenuClick);
      options.trigger?.removeEventListener('click', onTriggerClick);
      document.removeEventListener('pointerdown', onDocumentPointerDown);
    },
  };

  function configureAccessibility(): void {
    options.input.setAttribute('role', 'combobox');
    options.input.setAttribute('aria-autocomplete', 'list');
    options.input.setAttribute('aria-expanded', 'false');
    if (options.menu.id) options.input.setAttribute('aria-controls', options.menu.id);
    options.menu.setAttribute('role', 'listbox');
    options.menu.hidden = true;
    if (options.trigger && options.menu.id) {
      options.trigger.setAttribute('aria-controls', options.menu.id);
      options.trigger.setAttribute('aria-expanded', 'false');
    }
  }

  function commit(): void {
    const symbol = normalizeYFinanceJapanSymbol(options.input.value);
    if (!symbol) {
      options.onError('Mã Nhật phải là mã TSE 4 ký tự.');
      return;
    }
    commitValue(symbol);
  }

  function commitValue(symbolInput: string): void {
    const symbol = normalizeYFinanceJapanSymbol(symbolInput);
    if (!symbol) return;
    options.input.value = symbol;
    closeMenu();
    options.onCommit(symbol);
  }

  function showDefaultOptions(): void {
    cancelPendingSearch();
    requestId += 1;
    renderOptions(defaultItems());
    setOpen(true);
  }

  function defaultItems(): SymbolSearchResult[] {
    return options.getSymbols().map((symbol) => ({ symbol }));
  }

  function renderOptions(items: readonly Partial<SymbolSearchResult>[]): void {
    const normalized = normalizeSymbolSuggestions(items);
    const fragment = document.createDocumentFragment();
    optionElements = normalized.map((item, index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'symbol-combobox-option';
      option.dataset.symbol = item.symbol;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.id = `${options.menu.id || 'symbol-menu'}-option-${index}`;

      const symbol = document.createElement('strong');
      symbol.textContent = item.symbol;
      option.appendChild(symbol);

      const detail = [item.name, item.exchange].filter(Boolean).join(' · ');
      if (detail) {
        const meta = document.createElement('small');
        meta.textContent = detail;
        option.appendChild(meta);
      }
      fragment.appendChild(option);
      return option;
    });

    if (normalized.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'symbol-combobox-empty';
      empty.textContent = 'Không có mã trong Watch List.';
      fragment.appendChild(empty);
    }

    activeIndex = -1;
    options.input.removeAttribute('aria-activedescendant');
    options.menu.replaceChildren(fragment);
  }

  function setActiveIndex(index: number): void {
    if (optionElements.length === 0 || index < 0) return;
    activeIndex = Math.min(index, optionElements.length - 1);
    optionElements.forEach((element, optionIndex) => {
      element.setAttribute('aria-selected', String(optionIndex === activeIndex));
    });
    const active = optionElements[activeIndex];
    options.input.setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block: 'nearest' });
  }

  function setOpen(nextOpen: boolean): void {
    open = nextOpen;
    options.menu.hidden = !nextOpen;
    options.input.setAttribute('aria-expanded', String(nextOpen));
    options.trigger?.setAttribute('aria-expanded', String(nextOpen));
  }

  function closeMenu(): void {
    cancelPendingSearch();
    requestId += 1;
    activeIndex = -1;
    options.input.removeAttribute('aria-activedescendant');
    setOpen(false);
  }

  function cancelPendingSearch(): void {
    if (timer === null) return;
    window.clearTimeout(timer);
    timer = null;
  }
}

export function normalizeSymbolSuggestions(
  items: readonly Partial<SymbolSearchResult>[],
): SymbolSearchResult[] {
  const seen = new Set<string>();
  const output: SymbolSearchResult[] = [];
  for (const item of items) {
    const symbol = normalizeYFinanceJapanSymbol(String(item.symbol ?? ''));
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    output.push({
      symbol,
      ...(item.name ? { name: item.name } : {}),
      ...(item.exchange ? { exchange: item.exchange } : {}),
    });
  }
  return output;
}
