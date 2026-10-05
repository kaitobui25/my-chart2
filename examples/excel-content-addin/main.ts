import { L2Chart, type Candle } from '../../src/library';
import { ExcelAssistantController } from './assistant-controller';
import { createExcelAssistantBridge, type ExcelAssistantSource } from './assistant-context';
import { isExcelHost, readSelectedRange, waitForOfficeReady } from './excel-host';
import { IndicatorController } from './indicator-controller';
import {
  JAPAN_MARKET_CONFIG,
  JAPAN_TIMEFRAMES,
  type JapanTimeframe,
} from './japan-market-config';
import { JapanMarketController } from './japan-market-controller';
import { candlesFromRange, inferCandleIntervalSeconds } from './ohlc-range';
import { excelRangeOptions, excelStealthChartOptions, excelStealthUi } from './stealth-preset';
import { bindSymbolCombobox } from './symbol-combobox';
import { bindViewTabs, type ViewTabsBinding } from './view-tabs';
import { WatchListController } from './watchlist-controller';
import { WatchListStore } from './watchlist-store';
import { WatchListView } from './watchlist-view';
import './style.css';

const chartElement = requiredElement<HTMLElement>('#chart');
const statusElement = requiredElement<HTMLElement>('#status');
const loadButton = requiredElement<HTMLButtonElement>('#load-selection');
const symbolInput = requiredElement<HTMLInputElement>('#symbol-input');
const symbolOptions = requiredElement<HTMLDataListElement>('#symbol-options');
const timeframeSelect = requiredElement<HTMLSelectElement>('#timeframe-select');
const indicatorControl = requiredElement<HTMLElement>('#indicator-control');
const indicatorSelect = requiredElement<HTMLSelectElement>('#indicator-select');
const indicatorTrigger = requiredElement<HTMLButtonElement>('#indicator-trigger');
const indicatorTriggerLabel = requiredElement<HTMLElement>('#indicator-trigger-label');
const indicatorMenu = requiredElement<HTMLElement>('#indicator-menu');
const chartTab = requiredElement<HTMLButtonElement>('#chart-tab');
const watchlistTab = requiredElement<HTMLButtonElement>('#watchlist-tab');
const chartViewElement = requiredElement<HTMLElement>('#chart-view');
const watchlistViewElement = requiredElement<HTMLElement>('#watchlist-view');
const watchlistInput = requiredElement<HTMLInputElement>('#watchlist-symbol-input');
const watchlistOptions = requiredElement<HTMLDataListElement>('#watchlist-symbol-options');
const watchlistAddButton = requiredElement<HTMLButtonElement>('#watchlist-add');

const chart = new L2Chart(chartElement, excelStealthChartOptions);
const indicators = new IndicatorController(chart);
const market = new JapanMarketController(chart);
const watchlistStore = new WatchListStore(JAPAN_MARKET_CONFIG.defaultSymbols);
let watchlist: WatchListController;
let viewTabs: ViewTabsBinding;
let activeSource: ExcelAssistantSource = 'market';
let statusMessage: string = excelStealthUi.loading;
let statusIsError = false;
let marketLoadId = 0;

const assistant = new ExcelAssistantController(createExcelAssistantBridge({
  chart,
  indicators,
  market,
  getSource: () => activeSource,
  getSymbol: () => market.getSnapshot()?.symbol ?? symbolInput.value.trim(),
  getTimeframe: () => market.getSnapshot()?.timeframe ?? timeframeSelect.value,
}));

const watchlistView = new WatchListView({
  list: requiredElement<HTMLElement>('#watchlist-list'),
  empty: requiredElement<HTMLElement>('#watchlist-empty'),
  count: requiredElement<HTMLElement>('#watchlist-count'),
  status: requiredElement<HTMLElement>('#watchlist-status'),
}, {
  onOpen: (symbol) => openWatchlistSymbol(symbol),
  onRemove: (symbol) => watchlist.removeSymbol(symbol),
});

watchlist = new WatchListController({
  feed: market.getDatafeed(),
  store: watchlistStore,
  view: watchlistView,
  input: watchlistInput,
  suggestions: watchlistOptions,
  addButton: watchlistAddButton,
});

viewTabs = bindViewTabs({
  chartTab,
  watchlistTab,
  chartView: chartViewElement,
  watchlistView: watchlistViewElement,
  onChange: (view) => watchlist.setActive(view === 'watchlist'),
});

populateTimeframes();
populateIndicators();
symbolInput.value = JAPAN_MARKET_CONFIG.defaultSymbol;
timeframeSelect.value = JAPAN_MARKET_CONFIG.defaultTimeframe;

const unbindSymbol = bindSymbolCombobox({
  input: symbolInput,
  list: symbolOptions,
  initialSymbols: JAPAN_MARKET_CONFIG.defaultSymbols,
  debounceMs: JAPAN_MARKET_CONFIG.symbolSearchDebounceMs,
  search: (query) => market.searchSymbols(query),
  onCommit: () => void reloadMarket(),
  onError: (message) => setPersistentStatus(message, true),
});

timeframeSelect.addEventListener('change', () => void reloadMarket());
indicatorSelect.addEventListener('change', () => {
  try {
    indicators.select(indicatorSelect.value);
    syncIndicatorTrigger();
    renderIndicatorMenu();
    assistant.refreshContext();
    setPersistentStatus(statusMessage);
  } catch (error) {
    setPersistentStatus(error instanceof Error ? error.message : 'Không thể bật indicator.', true);
  }
});
indicatorTrigger.addEventListener('click', () => {
  setIndicatorMenuOpen(Boolean(indicatorMenu.hidden));
});
document.addEventListener('pointerdown', (event) => {
  if (!indicatorMenu.hidden && !indicatorControl.contains(event.target as Node)) {
    setIndicatorMenuOpen(false);
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || indicatorMenu.hidden) return;
  setIndicatorMenuOpen(false);
  indicatorTrigger.focus();
});
loadButton.addEventListener('click', () => void loadSelectedRange());
chart.on('crosshair', ({ candle }) => setFocusStatus(candle));
window.addEventListener('blur', () => chart.clearCrosshair());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) chart.clearCrosshair();
});
window.addEventListener('beforeunload', () => {
  unbindSymbol();
  viewTabs.dispose();
  watchlist.dispose();
  assistant.dispose();
  indicators.dispose();
  market.dispose();
});

void initializeHost();
void reloadMarket();

async function initializeHost(): Promise<void> {
  const officeInfo = await waitForOfficeReady();
  loadButton.disabled = !isExcelHost(officeInfo);
}

async function reloadMarket(): Promise<void> {
  const loadId = ++marketLoadId;
  const timeframe = timeframeSelect.value as JapanTimeframe;
  setPersistentStatus(`Đang tải ${symbolInput.value.trim()} · ${timeframe}…`);

  try {
    const result = await market.load(symbolInput.value, timeframe);
    if (!result || loadId !== marketLoadId) return;
    symbolInput.value = result.symbol;
    activeSource = 'market';
    assistant.refreshContext();
    watchlist.setActiveSymbol(result.symbol);
    setPersistentStatus(`${result.symbol} · ${timeframeLabel(result.timeframe)} · ${result.candles.length.toLocaleString()} nến`);
  } catch (error) {
    if (loadId !== marketLoadId) return;
    setPersistentStatus(error instanceof Error ? error.message : 'Không thể tải dữ liệu Nhật.', true);
  }
}

async function loadSelectedRange(): Promise<void> {
  loadButton.disabled = true;
  marketLoadId += 1;
  setPersistentStatus(excelStealthUi.loading);

  try {
    const candles = candlesFromRange(await readSelectedRange(), excelRangeOptions);
    if (candles.length === 0) throw new Error(excelStealthUi.emptyRange);
    market.pause();
    chart.setIntervalSec(inferCandleIntervalSeconds(candles));
    chart.setData(candles);
    chart.fitContent();
    activeSource = 'sheet';
    assistant.refreshContext();
    watchlist.setActiveSymbol(null);
    setPersistentStatus(`Sheet · ${candles.length.toLocaleString()} nến`);
  } catch (error) {
    setPersistentStatus(error instanceof Error ? error.message : excelStealthUi.genericError, true);
  } finally {
    loadButton.disabled = false;
  }
}

function openWatchlistSymbol(symbol: string): void {
  symbolInput.value = symbol;
  viewTabs.select('chart');
  void reloadMarket();
}

function populateTimeframes(): void {
  const fragment = document.createDocumentFragment();
  for (const item of JAPAN_TIMEFRAMES) {
    const option = document.createElement('option');
    option.value = item.value;
    option.textContent = item.label;
    fragment.appendChild(option);
  }
  timeframeSelect.replaceChildren(fragment);
}

function populateIndicators(): void {
  const selectedId = indicatorSelect.value;
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'Indicator';
  const options = indicators.options();
  const optionElements = options.map((item) => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.name;
    return option;
  });
  indicatorSelect.replaceChildren(none, ...optionElements);
  indicatorSelect.value = selectedId;
  syncIndicatorTrigger();
  renderIndicatorMenu(options);
}

function renderIndicatorMenu(options = indicators.options()): void {
  const labels: Record<string, string> = {
    overlay: 'Overlay',
    oscillator: 'Oscillator',
    volume: 'Volume',
  };
  const favorites = options.filter((item) => item.favorite);
  const regular = options.filter((item) => !item.favorite);
  const fragment = document.createDocumentFragment();

  const clearRow = createIndicatorRow('', 'Không dùng indicator', false);
  fragment.appendChild(clearRow);

  if (favorites.length > 0) {
    fragment.appendChild(createIndicatorGroupLabel('Yêu thích'));
    favorites.forEach((item) => fragment.appendChild(createIndicatorRow(item.id, item.name, true)));
  }

  const grouped = new Map<string, typeof regular>();
  for (const item of regular) {
    const group = grouped.get(item.category) ?? [];
    group.push(item);
    grouped.set(item.category, group);
  }
  for (const [category, items] of grouped) {
    fragment.appendChild(createIndicatorGroupLabel(labels[category] ?? category));
    items.forEach((item) => fragment.appendChild(createIndicatorRow(item.id, item.name, false)));
  }

  indicatorMenu.replaceChildren(fragment);
}

function createIndicatorGroupLabel(label: string): HTMLElement {
  const heading = document.createElement('div');
  heading.className = 'indicator-menu-group';
  heading.textContent = label;
  return heading;
}

function createIndicatorRow(id: string, name: string, favorite: boolean): HTMLElement {
  const row = document.createElement('div');
  row.className = 'indicator-menu-row';
  row.dataset.selected = String(indicatorSelect.value === id);

  const selectButton = document.createElement('button');
  selectButton.type = 'button';
  selectButton.className = 'indicator-menu-select';
  selectButton.setAttribute('role', 'menuitemradio');
  selectButton.setAttribute('aria-checked', String(indicatorSelect.value === id));
  selectButton.textContent = name;
  selectButton.addEventListener('click', () => {
    indicatorSelect.value = id;
    indicatorSelect.dispatchEvent(new Event('change', { bubbles: true }));
    setIndicatorMenuOpen(false);
    indicatorTrigger.focus();
  });
  row.appendChild(selectButton);

  if (id) {
    const favoriteButton = document.createElement('button');
    favoriteButton.type = 'button';
    favoriteButton.className = 'indicator-menu-favorite';
    favoriteButton.textContent = favorite ? '★' : '☆';
    favoriteButton.setAttribute('aria-pressed', String(favorite));
    favoriteButton.setAttribute(
      'aria-label',
      favorite ? `Bỏ ${name} khỏi yêu thích` : `Đánh dấu ${name} yêu thích`,
    );
    favoriteButton.title = favorite ? 'Bỏ khỏi yêu thích' : 'Yêu thích';
    favoriteButton.addEventListener('click', () => {
      try {
        indicators.toggleFavorite(id);
        populateIndicators();
      } catch (error) {
        setPersistentStatus(error instanceof Error ? error.message : 'Không thể cập nhật yêu thích.', true);
      }
    });
    row.appendChild(favoriteButton);
  }

  return row;
}

function syncIndicatorTrigger(): void {
  const selected = indicators.options().find((item) => item.id === indicatorSelect.value);
  indicatorTriggerLabel.textContent = selected?.name ?? 'Indicator';
  indicatorTrigger.title = selected?.name ?? 'Indicator';
}

function setIndicatorMenuOpen(open: boolean): void {
  indicatorMenu.hidden = !open;
  indicatorTrigger.setAttribute('aria-expanded', String(open));
}

function setFocusStatus(candle: Candle | null): void {
  if (!candle) {
    setStatus(statusMessage, statusIsError);
    return;
  }
  setStatus(
    `${formatCandleTime(candle.time)} · O ${formatPrice(candle.open)}  H ${formatPrice(candle.high)}  `
    + `L ${formatPrice(candle.low)}  C ${formatPrice(candle.close)}`,
  );
}

function setPersistentStatus(message: string, error = false): void {
  statusMessage = message;
  statusIsError = error;
  setStatus(message, error);
}

function formatPrice(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value);
}

function formatCandleTime(timestampSeconds: number): string {
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(timestampSeconds * 1000));
}

function timeframeLabel(value: JapanTimeframe): string {
  return JAPAN_TIMEFRAMES.find((item) => item.value === value)?.label ?? value;
}

function setStatus(message: string, error = false): void {
  statusElement.textContent = message;
  statusElement.title = message;
  statusElement.dataset.state = error ? 'error' : 'ready';
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing Excel content add-in element: ${selector}`);
  return element;
}
