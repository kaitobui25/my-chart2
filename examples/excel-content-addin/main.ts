import { L2Chart, type Candle } from '../../src/library';
import { ExcelAssistantController } from './assistant-controller';
import { createExcelAssistantBridge, type ExcelAssistantSource } from './assistant-context';
import { isExcelHost, readSelectedRange, waitForOfficeReady } from './excel-host';
import { IndicatorController } from './indicator-controller';
import { IndicatorSettingsDialog } from './indicator-settings-dialog';
import {
  JAPAN_MARKET_CONFIG,
  JAPAN_TIMEFRAMES,
  type JapanTimeframe,
} from './japan-market-config';
import { JapanMarketController } from './japan-market-controller';
import { MarketSelectionStore } from './market-selection-store';
import { ExcelOptionsController } from './options-controller';
import { candlesFromRange, inferCandleIntervalSeconds } from './ohlc-range';
import { excelRangeOptions, excelStealthChartOptions, excelStealthUi } from './stealth-preset';
import { createSymbolCombobox } from './symbol-combobox';
import { bindViewTabs, type ViewTabsBinding } from './view-tabs';
import { buildVisibleSmcExport, SMC_IDS } from './smc-export';
import { WatchListController } from './watchlist-controller';
import { WatchListStore } from './watchlist-store';
import { WatchListView } from './watchlist-view';
import './style.css';

const chartElement = requiredElement<HTMLElement>('#chart');
const chartPointerDot = requiredElement<HTMLElement>('#chart-pointer-dot');
const appShell = requiredElement<HTMLElement>('.app-shell');
const statusElement = requiredElement<HTMLElement>('#status');
const loadButton = requiredElement<HTMLButtonElement>('#load-selection');
const symbolControl = requiredElement<HTMLElement>('#symbol-control');
const symbolInput = requiredElement<HTMLInputElement>('#symbol-input');
const symbolMenu = requiredElement<HTMLElement>('#symbol-menu');
const symbolTrigger = requiredElement<HTMLButtonElement>('#symbol-trigger');
const timeframeSelect = requiredElement<HTMLSelectElement>('#timeframe-select');
const indicatorControl = requiredElement<HTMLElement>('#indicator-control');
const indicatorTrigger = requiredElement<HTMLButtonElement>('#indicator-trigger');
const indicatorTriggerLabel = requiredElement<HTMLElement>('#indicator-trigger-label');
const indicatorMenu = requiredElement<HTMLElement>('#indicator-menu');
const chartTab = requiredElement<HTMLButtonElement>('#chart-tab');
const watchlistTab = requiredElement<HTMLButtonElement>('#watchlist-tab');
const optionsTab = requiredElement<HTMLButtonElement>('#options-tab');
const exportButton = requiredElement<HTMLButtonElement>('#export-button');
const chartViewElement = requiredElement<HTMLElement>('#chart-view');
const watchlistViewElement = requiredElement<HTMLElement>('#watchlist-view');
const optionsViewElement = requiredElement<HTMLElement>('#options-view');
const watchlistSymbolControl = requiredElement<HTMLElement>('#watchlist-symbol-control');
const watchlistInput = requiredElement<HTMLInputElement>('#watchlist-symbol-input');
const watchlistMenu = requiredElement<HTMLElement>('#watchlist-symbol-menu');
const watchlistAddButton = requiredElement<HTMLButtonElement>('#watchlist-add');

const chart = new L2Chart(chartElement, excelStealthChartOptions);
const indicators = new IndicatorController(chart);
const indicatorSettings = new IndicatorSettingsDialog(indicators, () => {
  assistant.refreshContext();
  setPersistentStatus(statusMessage);
});
const market = new JapanMarketController(chart);
const marketSelectionStore = new MarketSelectionStore();
const optionsController = new ExcelOptionsController({
  chart,
  surface: appShell,
  candlesOnHoverOnly: requiredElement<HTMLInputElement>('#candles-on-hover-only'),
});
const watchlistStore = new WatchListStore(JAPAN_MARKET_CONFIG.defaultSymbols);
let watchlist: WatchListController;
let viewTabs: ViewTabsBinding;
let activeSource: ExcelAssistantSource = 'market';
let statusMessage: string = excelStealthUi.loading;
let statusIsError = false;
let marketLoadId = 0;
let lastVisibleRange: { from: number; to: number } | null = null;

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
  symbolControl: watchlistSymbolControl,
  input: watchlistInput,
  menu: watchlistMenu,
  addButton: watchlistAddButton,
});

viewTabs = bindViewTabs({
  chartTab,
  watchlistTab,
  optionsTab,
  chartView: chartViewElement,
  watchlistView: watchlistViewElement,
  optionsView: optionsViewElement,
  onChange: (view) => {
    if (view !== 'chart') lastVisibleRange = chart.timeScale.visibleRange() ?? lastVisibleRange;
    watchlist.setActive(view === 'watchlist');
  },
});
const offVisibleRange = chart.onVisibleRangeChange(({ from, to }) => {
  if (!chartViewElement.hidden) lastVisibleRange = { from, to };
});

populateTimeframes();
populateIndicators();
const marketSelection = marketSelectionStore.get();
symbolInput.value = marketSelection.symbol;
timeframeSelect.value = marketSelection.timeframe;

const symbolCombobox = createSymbolCombobox({
  root: symbolControl,
  input: symbolInput,
  menu: symbolMenu,
  trigger: symbolTrigger,
  getSymbols: () => watchlistStore.list(),
  debounceMs: JAPAN_MARKET_CONFIG.symbolSearchDebounceMs,
  search: (query) => market.searchSymbols(query),
  onCommit: () => void reloadMarket(),
  onError: (message) => setPersistentStatus(message, true),
});

timeframeSelect.addEventListener('change', () => void reloadMarket());
const offIndicatorSettings = chart.onIndicatorSettings((id) => indicatorSettings.open(id));
const offIndicatorRemove = chart.onIndicatorRemove((id) => {
  if (!indicators.isActive(id)) return;
  indicators.deactivate(id);
  refreshActiveIndicators();
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
exportButton.addEventListener('click', exportVisibleSmc);
chart.on('crosshair', ({ candle }) => setFocusStatus(candle));
appShell.addEventListener('pointerenter', () => setChartHoverChrome(true));
appShell.addEventListener('pointerleave', () => setChartHoverChrome(false));
chartElement.addEventListener('pointermove', (event) => updateChartPointerDot(event));
chartElement.addEventListener('pointerleave', () => {
  hideChartPointerDot();
});
chartElement.addEventListener('pointercancel', hideChartPointerDot);
window.addEventListener('blur', () => {
  chart.clearCrosshair();
  hideChartPointerDot();
  setChartHoverChrome(false);
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  chart.clearCrosshair();
  hideChartPointerDot();
  setChartHoverChrome(false);
});
window.addEventListener('beforeunload', () => {
  symbolCombobox.dispose();
  viewTabs.dispose();
  watchlist.dispose();
  assistant.dispose();
  offIndicatorSettings();
  offIndicatorRemove();
  offVisibleRange();
  indicatorSettings.dispose();
  optionsController.dispose();
  indicators.dispose();
  market.dispose();
});

void initializeHost();
void reloadMarket();

function exportVisibleSmc(): void {
  try {
    const snapshot = buildVisibleSmcExport({
      symbol: activeSource === 'sheet' ? 'Excel range' : market.getSnapshot()?.symbol ?? symbolInput.value.trim(),
      timeframe: activeSource === 'sheet' ? 'sheet' : market.getSnapshot()?.timeframe ?? timeframeSelect.value,
      source: activeSource,
      candles: chart.getCandles(),
      visibleRange: chartViewElement.hidden ? lastVisibleRange : chart.timeScale.visibleRange(),
      indicators: indicators.debugSnapshots(SMC_IDS),
    });
    const file = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    const safe = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, '_');
    link.href = url;
    link.download = `smc-${safe(snapshot.meta.symbol)}-${safe(snapshot.meta.timeframe)}-${snapshot.meta.visibleRange.fromTime}-${snapshot.meta.visibleRange.toTime}.json`;
    link.style.display = 'none';
    document.body.appendChild(link);
    try { link.click(); } finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
    setStatus(`Export ${snapshot.candles.length} nến · ${snapshot.indicators.length} SMC`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Không thể export chart.', true);
  }
}

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
    timeframeSelect.value = result.timeframe;
    marketSelectionStore.update({ symbol: result.symbol, timeframe: result.timeframe });
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

function updateChartPointerDot(event: PointerEvent): void {
  if (event.pointerType && event.pointerType !== 'mouse') {
    hideChartPointerDot();
    return;
  }
  const rect = chartElement.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
    hideChartPointerDot();
    return;
  }
  chartPointerDot.style.left = `${x}px`;
  chartPointerDot.style.top = `${y}px`;
  chartPointerDot.hidden = false;
}

function hideChartPointerDot(): void {
  chartPointerDot.hidden = true;
}

function setChartHoverChrome(active: boolean): void {
  chart.setChrome({
    priceAxis: active,
    timeAxis: active,
    legend: active,
    crosshair: active,
  });
}

function populateIndicators(): void {
  const options = indicators.options();
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

  if (indicators.getActiveIds().length > 0) {
    fragment.appendChild(createClearIndicatorsRow());
  }

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
  const active = indicators.isActive(id);
  const row = document.createElement('div');
  row.className = 'indicator-menu-row';
  row.dataset.selected = String(active);

  const selectButton = document.createElement('button');
  selectButton.type = 'button';
  selectButton.className = 'indicator-menu-select';
  selectButton.setAttribute('aria-pressed', String(active));
  selectButton.textContent = name;
  selectButton.addEventListener('click', () => {
    try {
      indicators.toggle(id);
      refreshActiveIndicators();
    } catch (error) {
      setPersistentStatus(error instanceof Error ? error.message : 'Không thể cập nhật indicator.', true);
    }
  });
  row.appendChild(selectButton);

  if (id) {
    if (active) {
      const settingsButton = document.createElement('button');
      settingsButton.type = 'button';
      settingsButton.className = 'indicator-menu-settings';
      settingsButton.textContent = '⚙';
      settingsButton.setAttribute('aria-label', `Cấu hình ${name}`);
      settingsButton.title = 'Cấu hình';
      settingsButton.addEventListener('click', () => {
        setIndicatorMenuOpen(false);
        indicatorSettings.open(id);
      });
      row.classList.add('has-settings');
      row.appendChild(settingsButton);
    }

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

function createClearIndicatorsRow(): HTMLElement {
  const row = document.createElement('div');
  row.className = 'indicator-menu-row indicator-menu-clear-row';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'indicator-menu-select';
  button.textContent = 'Xóa tất cả indicator';
  button.addEventListener('click', () => {
    indicators.clear();
    refreshActiveIndicators();
  });
  row.appendChild(button);
  return row;
}

function refreshActiveIndicators(): void {
  syncIndicatorTrigger();
  renderIndicatorMenu();
  assistant.refreshContext();
  setPersistentStatus(statusMessage);
}

function syncIndicatorTrigger(): void {
  const activeIds = indicators.getActiveIds();
  const activeNames = activeIds
    .map((id) => indicators.getDefinition(id)?.name)
    .filter((name): name is string => Boolean(name));
  indicatorTriggerLabel.textContent = activeNames.length === 1
    ? activeNames[0]
    : activeNames.length > 1
      ? `Indicator (${activeNames.length})`
      : 'Indicator';
  indicatorTrigger.title = activeNames.length > 0 ? activeNames.join(', ') : 'Indicator';
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
