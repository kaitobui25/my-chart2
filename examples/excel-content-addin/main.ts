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
import './style.css';

const chartElement = requiredElement<HTMLElement>('#chart');
const statusElement = requiredElement<HTMLElement>('#status');
const loadButton = requiredElement<HTMLButtonElement>('#load-selection');
const symbolInput = requiredElement<HTMLInputElement>('#symbol-input');
const symbolOptions = requiredElement<HTMLDataListElement>('#symbol-options');
const timeframeSelect = requiredElement<HTMLSelectElement>('#timeframe-select');
const indicatorSelect = requiredElement<HTMLSelectElement>('#indicator-select');

const chart = new L2Chart(chartElement, excelStealthChartOptions);
const indicators = new IndicatorController(chart);
const market = new JapanMarketController(chart);
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
    assistant.refreshContext();
    setPersistentStatus(statusMessage);
  } catch (error) {
    setPersistentStatus(error instanceof Error ? error.message : 'Không thể bật indicator.', true);
  }
});
loadButton.addEventListener('click', () => void loadSelectedRange());
chart.on('crosshair', ({ candle }) => setFocusStatus(candle));
window.addEventListener('blur', () => chart.clearCrosshair());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) chart.clearCrosshair();
});
window.addEventListener('beforeunload', () => {
  unbindSymbol();
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
    setPersistentStatus(`Sheet · ${candles.length.toLocaleString()} nến`);
  } catch (error) {
    setPersistentStatus(error instanceof Error ? error.message : excelStealthUi.genericError, true);
  } finally {
    loadButton.disabled = false;
  }
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
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'Indicator';
  const groups = new Map<string, HTMLOptGroupElement>();
  const labels: Record<string, string> = {
    overlay: 'Overlay',
    oscillator: 'Oscillator',
    volume: 'Volume',
  };

  for (const item of indicators.options()) {
    let group = groups.get(item.category);
    if (!group) {
      group = document.createElement('optgroup');
      group.label = labels[item.category] ?? item.category;
      groups.set(item.category, group);
    }
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.name;
    group.appendChild(option);
  }

  indicatorSelect.replaceChildren(none, ...groups.values());
}

function setFocusStatus(candle: Candle | null): void {
  if (!candle) {
    setStatus(statusMessage, statusIsError);
    return;
  }
  setStatus(
    `O ${formatPrice(candle.open)}  H ${formatPrice(candle.high)}  `
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

function timeframeLabel(value: JapanTimeframe): string {
  return JAPAN_TIMEFRAMES.find((item) => item.value === value)?.label ?? value;
}

function setStatus(message: string, error = false): void {
  statusElement.textContent = message;
  statusElement.dataset.state = error ? 'error' : 'ready';
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing Excel content add-in element: ${selector}`);
  return element;
}
