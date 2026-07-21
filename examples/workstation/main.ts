import {
  Brush,
  CalendarDays,
  ChartNoAxesCombined,
  Check,
  ChevronLeft,
  ChevronRight,
  CirclePlay,
  Columns2,
  Columns3,
  createElement as createLucideElement,
  Grid2X2,
  LayoutTemplate,
  MessageSquareText,
  Ellipsis,
  MousePointer2,
  Pause,
  Pencil,
  Play,
  Plus,
  Redo2,
  Rows2,
  RulerDimensionLine,
  Search,
  Settings2,
  Shapes,
  Square,
  Star,
  Trash2,
  TrendingUp,
  Type,
  Undo2,
  X,
} from 'lucide';
import {
  L2Chart,
  darkTheme,
  lightTheme,
  INTERVAL_SECONDS,
  type Datafeed,
  type Candle,
  type DrawingStyle,
  type DrawingTool,
  type HistoryRange,
  type IndicatorAppearance,
  type SerializedDrawing,
  type QuoteUpdate,
  type PriceSeriesMode,
  type SymbolSearchResult,
  type Theme,
} from '../../src/index';
import {
  DNSEDatafeed,
  normalizeDnseSymbol,
  type DnseCredentials,
  type DnseRealtimeState,
} from '../providers/dnse';
import { FiinQuantDatafeed, type FiinQuantHealth } from '../providers/fiinquant';
import { SampleDatafeed } from '../providers/sample';
import {
  MarketHub,
  PaperTradingEngine,
  type MarketQuote,
} from './trading/paper';
import { TradingWorkspace } from './trading/workspace';
import { searchInstruments } from '../providers/instruments';
import { getLocale, observeTranslations, setLocale, tr, translateDom } from './i18n';
import { registerAllIndicators } from '../../src/indicators/all';
import {
  defaultParams,
  getIndicator,
  getIndicators,
  type IndicatorDef,
  type IndicatorInstance,
  type Params,
} from '../../src/indicators/registry';

registerAllIndicators();
const indicatorCatalog = getIndicators();
translateDom();
observeTranslations();

type PriceProviderId = 'demo' | 'dnse' | 'fiinquant';
type ProviderCredentialMode = 'session' | 'server';

interface DnseStoredSettings {
  restBase?: string;
  wsBase?: string;
  marketType?: string;
  useProxyCredentials?: boolean;
  credentialMode?: ProviderCredentialMode;
}

interface FiinQuantStoredSettings {
  baseUrl: string;
  credentialMode: ProviderCredentialMode;
}

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'];
const HISTORY_PAGE_SIZE = 500;
const HISTORY_PAGE_TRIGGER_BARS = 30;
const MAX_HISTORY_RANGE_SECONDS: Record<string, number> = {
  '1m': 7 * 86400,
  '5m': 30 * 86400,
  '15m': 90 * 86400,
  '30m': 180 * 86400,
  '1h': 365 * 86400,
  '4h': 3 * 365 * 86400,
  '1d': 10 * 365 * 86400,
  '1w': 20 * 365 * 86400,
};
const DEFAULT_SYMBOLS = ['HPG', 'SSI', 'VNM', 'VN30F1M'];

function pricePrecisionForSymbol(symbol: string): number | null {
  return /^VN30F/i.test(symbol.trim()) ? 1 : null;
}
const LEGACY_DNSE_STORAGE_KEY = 'l2chart.dnse.credentials';
const DNSE_STORAGE_KEY = 'l2chart.dnse.settings.v1';
const LEGACY_FIINQUANT_STORAGE_KEY = 'l2chart.fiinquant.credentials';
const FIINQUANT_STORAGE_KEY = 'l2chart.fiinquant.settings.v1';
const ACTIVE_PROVIDER_KEY = 'l2chart.priceProvider';
const CHART_PREFERENCES_KEY = 'l2chart.chartPreferences.v1';
const CHART_TEMPLATES_KEY = 'l2chart.chartTemplates.v1';
const DEFAULT_CHART_TEMPLATE_KEY = 'l2chart.defaultChartTemplate.v1';
const DRAWINGS_STORAGE_KEY = 'l2chart.drawings.v1';
const DRAWINGS_STORAGE_PREFIX = 'l2chart.drawings.v2';
const DRAWING_RECENTS_KEY = 'l2chart.drawingRecents.v1';
const DRAWING_ESCAPE_HINT_KEY = 'l2chart.drawingEscapeHint.v1';
const UI_PREFERENCES_KEY = 'l2chart.uiPreferences.v1';
const INDICATOR_FAVORITES_KEY = 'l2chart.indicatorFavorites.v1';
const CHART_DEFAULTS_VERSION = 2;
const DNSE_OFFICIAL_REST = 'https://openapi.dnse.com.vn';
const DNSE_OFFICIAL_WS = 'wss://ws-openapi.dnse.com.vn';
const DNSE_REST_PROXY = '/dnse-api';
const FIINQUANT_DEFAULT_BASE = '/fiinquant-api';
const FIINQUANT_LEGACY_LOOPBACK_BASE = 'http://127.0.0.1:8720';

function isLegacyFiinQuantDefault(baseUrl: string): boolean {
  if (baseUrl === FIINQUANT_LEGACY_LOOPBACK_BASE) return true;
  try {
    const url = new URL(baseUrl);
    return url.port === '8720' && url.hostname === window.location.hostname;
  } catch {
    return false;
  }
}

function resolveFiinQuantBase(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/$/, '');
  if (!normalized) return FIINQUANT_DEFAULT_BASE;
  // Old defaults sent remote browsers directly to port 8720. Keep explicit
  // custom sidecars, but migrate the local/default route to the same-origin proxy.
  if (isLegacyFiinQuantDefault(normalized)) return FIINQUANT_DEFAULT_BASE;
  return normalized;
}

interface ChartPreferences {
  defaultsVersion: number;
  interval: string;
  mode: PriceSeriesMode;
  indicators: string[];
  indicatorParams: Record<string, Params>;
  sessions: boolean;
  candleColors?: CandleColors;
}

interface TileTemplate {
  symbol?: string;
  interval: string;
  mode: PriceSeriesMode;
  indicators: string[];
  indicatorParams?: Record<string, Params>;
  sessions: boolean;
  candleColors?: CandleColors;
  paneWeights?: number[];
}

interface ChartTemplate {
  id: string;
  name: string;
  layout?: LayoutId;
  tiles?: TileTemplate[];
  // Legacy single-chart templates are read in place and migrated on next save.
  interval?: string;
  mode?: PriceSeriesMode;
  indicators?: string[];
  indicatorParams?: Record<string, Params>;
  sessions?: boolean;
  candleColors?: CandleColors;
}

type CandleColors = Pick<Theme, 'up' | 'down' | 'wickUp' | 'wickDown'> & {
  line: string;
  area: string;
};

interface UiPreferences {
  watchlistVisible: boolean;
  rightPanelVisible: boolean;
  symbols: string[];
}

const marketHub = new MarketHub();
const paperEngine = new PaperTradingEngine(marketHub);
let tradingWorkspace: TradingWorkspace | null = null;

const toolIcon = (body: string): string =>
  `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const lucideIcon = (icon: Parameters<typeof createLucideElement>[0]): string =>
  createLucideElement(icon, {
    width: 24,
    height: 24,
    stroke: 'currentColor',
    'stroke-width': 1.8,
    'aria-hidden': 'true',
  }).outerHTML;

const DRAWING_ICONS: Record<DrawingTool | 'undo' | 'redo' | 'trash' | 'lines' | 'positions' | 'shapes' | 'annotations', string> = {
  cursor: lucideIcon(MousePointer2),
  lines: lucideIcon(TrendingUp),
  trendline: lucideIcon(TrendingUp),
  ray: lucideIcon(TrendingUp),
  arrow: toolIcon('<path d="m3 16 13-13M10 3h6v6"/>'),
  'horizontal-line': toolIcon('<path d="M2 10h16"/><circle cx="6" cy="10" r="1.5"/>'),
  'vertical-line': toolIcon('<path d="M10 2v16"/><circle cx="10" cy="7" r="1.5"/>'),
  'fib-retracement': lucideIcon(RulerDimensionLine),
  positions: lucideIcon(ChartNoAxesCombined),
  'long-position': lucideIcon(ChartNoAxesCombined),
  'short-position': lucideIcon(ChartNoAxesCombined),
  'price-range': lucideIcon(RulerDimensionLine),
  text: lucideIcon(Type),
  shapes: lucideIcon(Shapes),
  annotations: lucideIcon(MessageSquareText),
  brush: lucideIcon(Brush),
  highlighter: toolIcon('<path d="m4 13 7-9 4 3-7 9H4zM3 17h10"/>'),
  'arrow-up': toolIcon('<path d="M10 17V5M5 10l5-5 5 5"/>'),
  'arrow-down': toolIcon('<path d="M10 3v12M5 10l5 5 5-5"/>'),
  rectangle: toolIcon('<rect x="3" y="4" width="14" height="12" rx="1"/>'),
  'rotated-rectangle': toolIcon('<path d="m3 10 7-7 7 7-7 7z"/>'),
  path: toolIcon('<path d="M3 15c3-9 8 3 14-10"/><circle cx="3" cy="15" r="1.2"/><circle cx="17" cy="5" r="1.2"/>'),
  circle: toolIcon('<circle cx="10" cy="10" r="7"/>'),
  ellipse: toolIcon('<ellipse cx="10" cy="10" rx="8" ry="5"/>'),
  polyline: toolIcon('<path d="m2 15 5-8 5 6 6-10"/><circle cx="2" cy="15" r="1"/><circle cx="7" cy="7" r="1"/><circle cx="12" cy="13" r="1"/><circle cx="18" cy="3" r="1"/>'),
  triangle: toolIcon('<path d="m10 3 8 14H2z"/>'),
  arc: toolIcon('<path d="M3 15a9 9 0 0 1 14 0"/>'),
  curve: toolIcon('<path d="M2 15Q10 2 18 12"/>'),
  'double-curve': toolIcon('<path d="M2 12Q10 1 18 9M2 16Q10 5 18 13"/>'),
  note: toolIcon('<path d="M4 3h12v14H4zM7 7h6M7 10h6M7 13h4"/>'),
  'price-note': toolIcon('<path d="M3 4h14v10H9l-3 3v-3H3zM7 7h6M7 10h4"/>'),
  pin: toolIcon('<path d="M10 18s6-6 6-11a6 6 0 1 0-12 0c0 5 6 11 6 11z"/><circle cx="10" cy="7" r="2"/>'),
  table: toolIcon('<rect x="2" y="3" width="16" height="14"/><path d="M2 8h16M8 3v14"/>'),
  callout: toolIcon('<path d="M3 3h14v10H9l-5 4v-4H3z"/>'),
  comment: toolIcon('<path d="M3 4h14v10H8l-4 3v-3H3zM7 8h6M7 11h4"/>'),
  'price-label': toolIcon('<path d="M3 4h14v9H9l-4 4v-4H3z"/><path d="M7 8h6"/>'),
  signpost: toolIcon('<path d="M5 4h10l2 3-2 3H5zM10 10v7"/><path d="m10 5 .7 1.4 1.5.2-1.1 1 .3 1.5-1.4-.7-1.4.7.3-1.5-1.1-1 1.5-.2z"/>'),
  flag: toolIcon('<path d="M5 18V3M5 4h10l-2 4 2 4H5"/>'),
  image: toolIcon('<rect x="2" y="3" width="16" height="14" rx="1"/><circle cx="7" cy="8" r="1.5"/><path d="m3 15 4-4 3 3 3-4 4 5"/>'),
  post: toolIcon('<path d="M4 3h12v14H4zM7 7h6M7 10h6M7 13h3"/>'),
  idea: toolIcon('<path d="M6 8a4 4 0 1 1 8 0c0 2-2 3-2 5H8c0-2-2-3-2-5zM8 16h4"/>'),
  undo: lucideIcon(Undo2),
  redo: lucideIcon(Redo2),
  trash: lucideIcon(Trash2),
};

interface DrawingMenuItem {
  tool: DrawingTool;
  label: string;
}

interface ReplayState {
  candles: Candle[];
  cursor: number;
  speed: number;
  playing: boolean;
  timer: number | null;
}

interface ReplayInfo {
  phase: 'idle' | 'selecting' | 'paused' | 'playing';
  cursor: number;
  total: number;
  speed: number;
}

const LINE_TOOLS: DrawingMenuItem[] = [
  { tool: 'trendline', label: 'Đường xu hướng' },
  { tool: 'ray', label: 'Tia' },
  { tool: 'arrow', label: 'Mũi tên' },
  { tool: 'horizontal-line', label: 'Đường ngang' },
  { tool: 'vertical-line', label: 'Đường dọc' },
];

const POSITION_TOOLS: DrawingMenuItem[] = [
  { tool: 'long-position', label: 'Vị thế Long' },
  { tool: 'short-position', label: 'Vị thế Short' },
  { tool: 'price-range', label: 'Đo biên độ giá' },
];

const GEOMETRY_TOOLS: DrawingMenuItem[] = [
  { tool: 'brush', label: 'Bút vẽ' },
  { tool: 'highlighter', label: 'Bút đánh dấu' },
  { tool: 'arrow', label: 'Mũi tên marker' },
  { tool: 'arrow-up', label: 'Mũi tên lên' },
  { tool: 'arrow-down', label: 'Mũi tên xuống' },
  { tool: 'rectangle', label: 'Hình chữ nhật' },
  { tool: 'rotated-rectangle', label: 'Chữ nhật xoay' },
  { tool: 'path', label: 'Đường tự do' },
  { tool: 'circle', label: 'Hình tròn' },
  { tool: 'ellipse', label: 'Ellipse' },
  { tool: 'polyline', label: 'Polyline' },
  { tool: 'triangle', label: 'Tam giác' },
  { tool: 'arc', label: 'Cung tròn' },
  { tool: 'curve', label: 'Đường cong' },
  { tool: 'double-curve', label: 'Đường cong đôi' },
];

const ANNOTATION_TOOLS: DrawingMenuItem[] = [
  { tool: 'text', label: 'Văn bản' },
  { tool: 'note', label: 'Ghi chú' },
  { tool: 'price-note', label: 'Ghi chú giá' },
  { tool: 'pin', label: 'Ghim' },
  { tool: 'table', label: 'Bảng' },
  { tool: 'callout', label: 'Callout' },
  { tool: 'comment', label: 'Bình luận' },
  { tool: 'price-label', label: 'Nhãn giá' },
  { tool: 'signpost', label: 'Biển chỉ dẫn' },
  { tool: 'flag', label: 'Cờ đánh dấu' },
  { tool: 'image', label: 'Hình ảnh từ URL' },
  { tool: 'post', label: 'Bài viết' },
  { tool: 'idea', label: 'Ý tưởng' },
];

const DRAWING_PROMPTS: Partial<Record<DrawingTool, { message: string; initial: string }>> = {
  note: { message: 'Nội dung ghi chú', initial: 'Ghi chú' },
  'price-note': { message: 'Nội dung ghi chú giá', initial: 'Theo dõi tại đây' },
  table: { message: 'Dữ liệu bảng: dùng dấu phẩy cho cột, dấu chấm phẩy cho hàng', initial: 'Mức,Ghi chú;Hỗ trợ,--;Kháng cự,--' },
  callout: { message: 'Nội dung callout', initial: 'Điểm cần chú ý' },
  comment: { message: 'Nội dung bình luận', initial: 'Bình luận' },
  'price-label': { message: 'Tên nhãn giá', initial: 'Mốc giá' },
  signpost: { message: 'Nội dung biển chỉ dẫn', initial: 'Sự kiện' },
  image: { message: 'URL hình ảnh', initial: '' },
  post: { message: 'Nội dung bài viết ngắn', initial: 'Nhận định' },
  idea: { message: 'Nội dung ý tưởng', initial: 'Kịch bản giao dịch' },
};

const TEXT_EDITABLE_DRAWING_TOOLS = new Set<DrawingTool>([
  'text',
  'note',
  'price-note',
  'table',
  'callout',
  'comment',
  'price-label',
  'signpost',
  'image',
  'post',
  'idea',
]);

const PLAIN_TEXT_DRAWING_TOOLS = new Set<DrawingTool>(['text', 'note']);

let syncEnabled = true;
let dark = true;

const INDICATOR_STYLE_KEYS = {
  display: '__display',
  lineStyle: '__lineStyle',
  lineWidth: '__lineWidth',
  opacity: '__opacity',
  color1: '__color1',
  color2: '__color2',
  color3: '__color3',
} as const;

function indicatorStyleDefaults(id?: string): Params {
  const palette = dark ? darkTheme.palette : lightTheme.palette;
  const theme = dark ? darkTheme : lightTheme;
  return {
    [INDICATOR_STYLE_KEYS.display]: 'line',
    [INDICATOR_STYLE_KEYS.lineStyle]: 'solid',
    [INDICATOR_STYLE_KEYS.lineWidth]: 1.8,
    [INDICATOR_STYLE_KEYS.opacity]: 100,
    [INDICATOR_STYLE_KEYS.color1]: id === 'volume' ? theme.up : palette[0],
    [INDICATOR_STYLE_KEYS.color2]: id === 'volume' ? theme.down : palette[1],
    [INDICATOR_STYLE_KEYS.color3]: palette[2],
  };
}

function indicatorAppearanceFromParams(id: string, params: Params): IndicatorAppearance {
  const values = { ...indicatorStyleDefaults(id), ...params };
  const display = values[INDICATOR_STYLE_KEYS.display] === 'area' ? 'area' : 'line';
  const lineStyleValue = String(values[INDICATOR_STYLE_KEYS.lineStyle]);
  const lineStyle = lineStyleValue === 'dashed' || lineStyleValue === 'dotted' ? lineStyleValue : 'solid';
  return {
    display,
    lineStyle,
    lineWidth: Math.min(5, Math.max(0.5, Number(values[INDICATOR_STYLE_KEYS.lineWidth]) || 1.8)),
    opacity: Math.min(100, Math.max(0, Number(values[INDICATOR_STYLE_KEYS.opacity]) || 0)) / 100,
    colors: [
      String(values[INDICATOR_STYLE_KEYS.color1]),
      String(values[INDICATOR_STYLE_KEYS.color2]),
      String(values[INDICATOR_STYLE_KEYS.color3]),
    ],
  };
}

function readStoredJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredJson(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

const defaultUiPreferences: UiPreferences = {
  watchlistVisible: true,
  rightPanelVisible: false,
  symbols: [...DEFAULT_SYMBOLS],
};

let uiPreferences: UiPreferences = {
  ...defaultUiPreferences,
  ...readStoredJson<Partial<UiPreferences>>(UI_PREFERENCES_KEY, {}),
};
if (!Array.isArray(uiPreferences.symbols)) {
  uiPreferences.symbols = [...DEFAULT_SYMBOLS];
}

function saveUiPreferences(): void {
  writeStoredJson(UI_PREFERENCES_KEY, uiPreferences);
}

let globalDrawingToolbar: HTMLDivElement | null = null;
let drawingEscapeHintTimer = 0;
let scheduleToolbarOverflow: () => void = () => undefined;

function hideDrawingEscapeHint(): void {
  const hint = document.getElementById('drawing-escape-hint');
  if (!hint) return;
  hint.classList.remove('visible');
  window.clearTimeout(drawingEscapeHintTimer);
}

function showDrawingEscapeHint(): void {
  const count = readStoredJson<number>(DRAWING_ESCAPE_HINT_KEY, 0);
  if (count >= 5) return;
  try {
    writeStoredJson(DRAWING_ESCAPE_HINT_KEY, count + 1);
  } catch {
    // This guidance remains optional when browser storage is unavailable.
  }
  let hint = document.getElementById('drawing-escape-hint');
  if (!hint) {
    hint = document.createElement('div');
    hint.id = 'drawing-escape-hint';
    hint.setAttribute('role', 'status');
    document.body.appendChild(hint);
  }
  hint.textContent = getLocale() === 'vi'
    ? 'Nhấn Esc để trở về con trỏ'
    : 'Press Esc to return to the pointer';
  window.clearTimeout(drawingEscapeHintTimer);
  requestAnimationFrame(() => hint?.classList.add('visible'));
  drawingEscapeHintTimer = window.setTimeout(() => hint?.classList.remove('visible'), 3200);
}

function setupToolbarOverflow(): void {
  const toolbar = document.getElementById('toolbar');
  if (!toolbar) return;

  const wrap = document.createElement('div');
  wrap.id = 'toolbar-more-wrap';
  wrap.hidden = true;
  const button = document.createElement('button');
  button.id = 'toolbar-more-btn';
  button.type = 'button';
  button.innerHTML = lucideIcon(Ellipsis);
  button.title = getLocale() === 'vi' ? 'Thêm công cụ' : 'More tools';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  const menu = document.createElement('div');
  menu.id = 'toolbar-more-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  wrap.append(button, menu);
  toolbar.appendChild(wrap);

  const definitions = [
    ['chart-type-wrap', 'Chart type', 'Loại biểu đồ'],
    ['replay-wrap', 'Replay', 'Replay'],
    ['source-btn', 'Data source', 'Nguồn dữ liệu'],
    ['sync-toggle', 'Sync', 'Đồng bộ'],
    ['layouts', 'Layout', 'Bố cục'],
    ['template-wrap', 'Templates', 'Mẫu'],
    ['theme-toggle', 'Theme', 'Giao diện'],
    ['locale-switch', 'Language', 'Ngôn ngữ'],
  ] as const;
  const entries = definitions.flatMap(([id, en, vi]) => {
    const element = document.getElementById(id);
    if (!element) return [];
    const marker = document.createComment(`toolbar:${id}`);
    element.after(marker);
    return [{ id, element, marker, en, vi }];
  });
  const hideOrder = ['layouts', 'locale-switch', 'template-wrap', 'sync-toggle', 'source-btn', 'replay-wrap', 'chart-type-wrap', 'theme-toggle'];
  let updating = false;
  let raf = 0;

  const close = () => {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  };
  const restore = () => {
    for (const entry of entries) entry.marker.before(entry.element);
    menu.replaceChildren();
  };
  const update = () => {
    if (updating) return;
    updating = true;
    close();
    restore();
    wrap.hidden = true;

    const overflowed = new Set<string>();
    const isOverflowing = () => toolbar.scrollWidth > toolbar.clientWidth + 1;
    for (const id of hideOrder) {
      if (!isOverflowing()) break;
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry) continue;
      wrap.hidden = false;
      menu.appendChild(entry.element);
      overflowed.add(id);
    }

    menu.replaceChildren();
    for (const entry of entries) {
      if (!overflowed.has(entry.id)) continue;
      const row = document.createElement('div');
      row.className = 'toolbar-more-row';
      const label = document.createElement('span');
      label.className = 'toolbar-more-row-label';
      label.textContent = getLocale() === 'vi' ? entry.vi : entry.en;
      row.append(label, entry.element);
      menu.appendChild(row);
    }
    wrap.hidden = overflowed.size === 0;
    updating = false;
  };

  scheduleToolbarOverflow = () => {
    window.cancelAnimationFrame(raf);
    raf = window.requestAnimationFrame(update);
  };
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('pointerdown', (event) => {
    if (!(event.target as HTMLElement).closest('#toolbar-more-wrap')) close();
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  window.addEventListener('resize', scheduleToolbarOverflow, { passive: true });
  new ResizeObserver(scheduleToolbarOverflow).observe(toolbar);
  scheduleToolbarOverflow();
}

function defaultPreferences(): ChartPreferences {
  return {
    defaultsVersion: CHART_DEFAULTS_VERSION,
    interval: '1d',
    mode: 'candles',
    indicators: ['visible-range-extrema', 'volume', 'sma'],
    indicatorParams: {},
    sessions: false,
  };
}

function preferencesFromTemplate(template: TileTemplate): ChartPreferences {
  return {
    defaultsVersion: CHART_DEFAULTS_VERSION,
    interval: INTERVALS.includes(template.interval) ? template.interval : '1d',
    mode: template.mode,
    indicators: [...template.indicators],
    indicatorParams: Object.fromEntries(
      Object.entries(template.indicatorParams ?? {}).map(([id, params]) => [id, { ...params }]),
    ),
    sessions: template.sessions,
    candleColors: template.candleColors ? { ...template.candleColors } : undefined,
  };
}

function defaultTileTemplate(symbol = DEFAULT_SYMBOLS[0]): TileTemplate {
  const preferences = defaultPreferences();
  return {
    symbol,
    interval: preferences.interval,
    mode: preferences.mode,
    indicators: [...preferences.indicators],
    indicatorParams: Object.fromEntries(
      Object.entries(preferences.indicatorParams).map(([id, params]) => [id, { ...params }]),
    ),
    sessions: preferences.sessions,
    candleColors: preferences.candleColors ? { ...preferences.candleColors } : undefined,
  };
}

function intervalLabel(interval: string): string {
  return interval === '1d' ? '1D' : interval;
}

function defaultCandleColors(): CandleColors {
  const theme = dark ? darkTheme : lightTheme;
  return {
    up: theme.up,
    down: theme.down,
    wickUp: theme.wickUp,
    wickDown: theme.wickDown,
    line: theme.palette[0],
    area: theme.palette[0],
  };
}

function constrainHistoryRange(range: HistoryRange, interval: string): HistoryRange {
  const limit = MAX_HISTORY_RANGE_SECONDS[interval] ?? MAX_HISTORY_RANGE_SECONDS['1d'];
  return range.to - range.from > limit
    ? { from: range.to - limit, to: range.to }
    : range;
}

function historyRangeLimitText(interval: string): string {
  const days = (MAX_HISTORY_RANGE_SECONDS[interval] ?? MAX_HISTORY_RANGE_SECONDS['1d']) / 86400;
  if (days < 365) return `${days} ngày`;
  const years = Math.round(days / 365);
  return `${years} năm`;
}

function preferencesFor(symbol: string): ChartPreferences {
  const all = readStoredJson<Record<string, Partial<ChartPreferences>>>(CHART_PREFERENCES_KEY, {});
  const key = symbol.toUpperCase();
  const stored = all[key];
  const preferences = { ...defaultPreferences(), ...(stored ?? {}) };
  if ((stored?.defaultsVersion ?? 0) < CHART_DEFAULTS_VERSION) {
    preferences.defaultsVersion = CHART_DEFAULTS_VERSION;
    preferences.indicators = [...new Set(['visible-range-extrema', ...(preferences.indicators ?? [])])];
    preferences.sessions = false;
    all[key] = preferences;
    writeStoredJson(CHART_PREFERENCES_KEY, all);
  }
  return preferences;
}

function savePreferencesFor(symbol: string, preferences: ChartPreferences): void {
  const all = readStoredJson<Record<string, ChartPreferences>>(CHART_PREFERENCES_KEY, {});
  all[symbol.toUpperCase()] = preferences;
  writeStoredJson(CHART_PREFERENCES_KEY, all);
}

function drawingsKey(symbol: string, interval: string): string {
  return `${symbol.toUpperCase()}:${interval}`;
}

function drawingsStorageKey(symbol: string, interval: string): string {
  return `${DRAWINGS_STORAGE_PREFIX}:${encodeURIComponent(symbol.toUpperCase())}:${interval}`;
}

function readDrawings(symbol: string, interval: string): SerializedDrawing[] {
  const stored = readStoredJson<SerializedDrawing[] | null>(drawingsStorageKey(symbol, interval), null);
  if (Array.isArray(stored)) return stored;

  // Migrate the original all-symbols blob lazily so existing community users
  // keep their drawings while new writes stay isolated per chart.
  const all = readStoredJson<Record<string, SerializedDrawing[]>>(DRAWINGS_STORAGE_KEY, {});
  const legacy = all[drawingsKey(symbol, interval)];
  if (!Array.isArray(legacy)) return [];
  try {
    writeStoredJson(drawingsStorageKey(symbol, interval), legacy);
  } catch {
    // The legacy value is still returned even if storage quota is exhausted.
  }
  return legacy;
}

function saveDrawings(symbol: string, interval: string, drawings: SerializedDrawing[]): void {
  writeStoredJson(drawingsStorageKey(symbol, interval), drawings);
}

function quoteFromCandle(symbol: string, candle: Candle, reference: number, source: string): MarketQuote {
  const change = candle.close - reference;
  return {
    symbol: symbol.toUpperCase(),
    last: candle.close,
    bid: candle.close,
    ask: candle.close,
    hasBidAsk: false,
    change,
    changePct: reference ? (change / reference) * 100 : 0,
    time: candle.time,
    source,
  };
}

function quoteFromDepth(
  symbol: string,
  update: QuoteUpdate,
  source: string,
  base: MarketQuote | null,
): MarketQuote {
  const sameSourceBase = base?.source === source ? base : null;
  const bids = update.bids
    .filter((level) => Number.isFinite(level.price) && level.price > 0)
    .sort((a, b) => b.price - a.price)
    .slice(0, 10);
  const asks = update.asks
    .filter((level) => Number.isFinite(level.price) && level.price > 0)
    .sort((a, b) => a.price - b.price)
    .slice(0, 10);
  const last = sameSourceBase?.last ?? bids[0]?.price ?? asks[0]?.price ?? 0;
  const hasBidAsk = bids.length > 0 && asks.length > 0;
  const bid = bids[0]?.price ?? last;
  const ask = asks[0]?.price ?? last;
  return {
    symbol: symbol.toUpperCase(),
    last,
    bid,
    ask,
    hasBidAsk,
    change: sameSourceBase?.change ?? 0,
    changePct: sameSourceBase?.changePct ?? 0,
    time: update.time,
    source,
    bids,
    asks,
  };
}

function preserveDepth(quote: MarketQuote, previous: MarketQuote | null): MarketQuote {
  if (
    !previous?.hasBidAsk
    || previous.source !== quote.source
    || !previous.bids?.length
    || !previous.asks?.length
  ) return quote;
  return {
    ...quote,
    bid: previous.bid,
    ask: previous.ask,
    hasBidAsk: previous.hasBidAsk,
    bids: previous.bids,
    asks: previous.asks,
  };
}

function countdownText(candle: Candle | undefined, interval: string): string {
  if (!candle) return '--:--';
  const seconds = INTERVAL_SECONDS[interval] ?? 60;
  const remaining = Math.max(0, candle.time + seconds - Math.floor(Date.now() / 1000));
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const secs = remaining % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function readActiveProvider(): PriceProviderId {
  const stored = localStorage.getItem(ACTIVE_PROVIDER_KEY);
  return stored === 'demo' || stored === 'dnse' || stored === 'fiinquant' ? stored : 'demo';
}

function dnseWsProxyBase(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/dnse-ws`;
}

function localProxyPath(value: string): string {
  try {
    return new URL(value, window.location.origin).pathname.replace(/\/+$/, '');
  } catch {
    return value.replace(/\/+$/, '');
  }
}

function isDnseProxyRestBase(value: string): boolean {
  return localProxyPath(value) === '/dnse-api';
}

function isDnseProxyWsBase(value: string): boolean {
  return localProxyPath(value) === '/dnse-ws';
}

function normalizeDnseSettings(settings: DnseStoredSettings | null): DnseStoredSettings {
  const rawRestBase = settings?.restBase?.replace(/\/$/, '');
  const rawWsBase = settings?.wsBase?.replace(/\/$/, '');
  const restBase = !rawRestBase || rawRestBase === DNSE_OFFICIAL_REST || isDnseProxyRestBase(rawRestBase)
    ? DNSE_REST_PROXY
    : rawRestBase;
  const wsBase = !rawWsBase || rawWsBase === DNSE_OFFICIAL_WS || isDnseProxyWsBase(rawWsBase)
    ? dnseWsProxyBase()
    : rawWsBase;
  return {
    marketType: settings?.marketType,
    restBase,
    wsBase,
    useProxyCredentials: Boolean(settings?.useProxyCredentials),
    credentialMode: settings?.credentialMode === 'server' || settings?.useProxyCredentials ? 'server' : 'session',
  };
}

function normalizeDnseCredentials(credentials: DnseCredentials): DnseCredentials {
  return { ...credentials, ...normalizeDnseSettings(credentials) };
}

function sanitizeStoredDnseSettings(
  settings: (Partial<DnseCredentials> & { credentialMode?: ProviderCredentialMode }) | DnseStoredSettings | null,
): DnseStoredSettings {
  return normalizeDnseSettings({
    restBase: typeof settings?.restBase === 'string' ? settings.restBase : undefined,
    wsBase: typeof settings?.wsBase === 'string' ? settings.wsBase : undefined,
    marketType: typeof settings?.marketType === 'string' ? settings.marketType : undefined,
    useProxyCredentials: Boolean(settings?.useProxyCredentials),
    credentialMode: settings?.credentialMode === 'server' ? 'server' : 'session',
  });
}

function readDnseSettings(): DnseStoredSettings {
  const stored = readStoredJson<DnseStoredSettings | null>(DNSE_STORAGE_KEY, null);
  const legacy = readStoredJson<Partial<DnseCredentials> | null>(LEGACY_DNSE_STORAGE_KEY, null);
  localStorage.removeItem(LEGACY_DNSE_STORAGE_KEY);
  const settings = sanitizeStoredDnseSettings(stored ?? legacy);
  writeStoredJson(DNSE_STORAGE_KEY, settings);
  return settings;
}

function readFiinQuantSettings(): FiinQuantStoredSettings {
  const stored = readStoredJson<FiinQuantStoredSettings | null>(FIINQUANT_STORAGE_KEY, null);
  const legacy = readStoredJson<Partial<FiinQuantStoredSettings & { apiToken?: string }> | null>(
    LEGACY_FIINQUANT_STORAGE_KEY,
    null,
  );
  localStorage.removeItem(LEGACY_FIINQUANT_STORAGE_KEY);
  const settings = {
    baseUrl: resolveFiinQuantBase(stored?.baseUrl ?? legacy?.baseUrl ?? ''),
    credentialMode: stored?.credentialMode === 'server' ? 'server' as const : 'session' as const,
  };
  writeStoredJson(FIINQUANT_STORAGE_KEY, settings);
  return settings;
}

let activeProvider: PriceProviderId = readActiveProvider();
const dnseSettings = readDnseSettings();
let dnseCredentials: DnseCredentials | null = null;
let fiinQuantSettings = readFiinQuantSettings();
let fiinQuantSessionToken = '';
let dnseFeed: DNSEDatafeed | null = null;
let dnseRealtimeState: DnseRealtimeState = 'idle';
let dnseRealtimeDetail = '';
let unsubscribeDnseRealtimeStatus: (() => void) | null = null;
const demoFeed = new SampleDatafeed();

if (activeProvider === 'dnse' && !dnseFeed) {
  activeProvider = 'demo';
  localStorage.setItem(ACTIVE_PROVIDER_KEY, activeProvider);
}

function makeFiinQuantFeed(): FiinQuantDatafeed {
  return new FiinQuantDatafeed(
    resolveFiinQuantBase(fiinQuantSettings.baseUrl),
    fiinQuantSessionToken.trim(),
  );
}

let fiinQuantFeed: FiinQuantDatafeed = makeFiinQuantFeed();
type FiinQuantConnectionState = 'checking' | 'connected' | 'signed-out' | 'offline';
let fiinQuantConnectionState: FiinQuantConnectionState = 'checking';
let fiinQuantHealthSnapshot: FiinQuantHealth | null = null;
let fiinQuantHealthRequest = 0;
const FIINQUANT_HEALTH_POLL_MS = 10_000;

function usesLegacyFiinQuantSecurity(health: FiinQuantHealth): boolean {
  return health.tokenConfigured === undefined || health.authorized === undefined;
}

function fiinQuantAuthorizationMessage(): string {
  return fiinQuantSettings.credentialMode === 'server'
    ? tr('FIINQUANT_SIDECAR_TOKEN trong workstation .env thiếu hoặc không khớp SIDECAR_TOKEN của sidecar.')
    : tr('Phiên trình duyệt này không nhận token từ proxy loopback. Nhập SIDECAR_TOKEN trong Cài đặt nâng cao.');
}

/** Refresh the provider status from the FiinQuant sidecar health endpoint. */
async function reportFiinQuantHealth(showChecking = true): Promise<void> {
  const request = ++fiinQuantHealthRequest;
  if (showChecking) {
    fiinQuantConnectionState = 'checking';
    renderProviderSourceState();
  }
  try {
    const h = await fiinQuantFeed.health();
    if (request !== fiinQuantHealthRequest) return;
    fiinQuantHealthSnapshot = h;
    if (h.tokenConfigured === false) {
      fiinQuantConnectionState = 'signed-out';
      providerStatus.dataset.tone = 'error';
      providerStatus.textContent = tr('Sidecar thiếu SIDECAR_TOKEN. Tạo token trong .env rồi nhập token đó ở Cài đặt nâng cao.');
      return;
    }
    if (h.authorized === false) {
      fiinQuantConnectionState = 'signed-out';
      providerStatus.dataset.tone = 'error';
      providerStatus.textContent = fiinQuantAuthorizationMessage();
      return;
    }
    const legacySecurity = usesLegacyFiinQuantSecurity(h);
    fiinQuantConnectionState = h.loggedIn ? 'connected' : 'signed-out';
    providerStatus.dataset.tone = h.loggedIn ? (legacySecurity ? 'warning' : 'success') : 'error';
    if (!h.loggedIn) {
      providerStatus.textContent = tr('Sidecar đang chạy nhưng chưa có phiên FiinQuant. Hãy đăng nhập bên dưới hoặc cấu hình sidecar .env.');
    } else if (legacySecurity) {
      providerStatus.textContent = tr('FiinQuant đã kết nối qua sidecar cũ. Khởi động lại sidecar để áp dụng bảo vệ token mới.');
    } else if (h.stream?.lastTickAt) {
      providerStatus.textContent = `${tr('FiinQuant realtime đang nhận dữ liệu. Tick gần nhất')}: ${h.stream.lastTickSymbol ?? ''} · ${h.stream.lastMarketTickAt ?? h.stream.lastTickAt}`;
    } else if (h.stream?.upstreamActive) {
      providerStatus.textContent = tr('FiinQuant realtime đã đăng ký và đang chờ tick thị trường. Ngoài giờ giao dịch hoặc giờ nghỉ sẽ không có nến mới.');
    } else {
      providerStatus.textContent = tr('Sidecar FiinQuant sẵn sàng. Realtime sẽ mở khi chart hoặc watchlist đăng ký dữ liệu.');
    }
  } catch {
    if (request !== fiinQuantHealthRequest) return;
    fiinQuantHealthSnapshot = null;
    fiinQuantConnectionState = 'offline';
    providerStatus.dataset.tone = 'error';
    providerStatus.textContent = tr('Không gọi được sidecar. Hãy khởi động sidecar trong examples/sidecars/fiinquant rồi thử lại.');
  } finally {
    if (request === fiinQuantHealthRequest) renderProviderSourceState();
  }
}

function pollFiinQuantHealth(): void {
  if (activeProvider !== 'fiinquant' || document.hidden) return;
  void reportFiinQuantHealth(false);
}

function reportProviderLoadSuccess(provider: PriceProviderId): void {
  if (provider !== 'fiinquant' || activeProvider !== provider) return;
  fiinQuantConnectionState = 'connected';
  renderProviderSourceState();
}

function reportProviderLoadFailure(provider: PriceProviderId, message: string): void {
  if (provider !== 'fiinquant' || activeProvider !== provider) return;
  if (/cannot reach|failed to fetch|network|sidecar/i.test(message)) {
    fiinQuantHealthRequest += 1;
    fiinQuantConnectionState = 'offline';
    renderProviderSourceState();
    return;
  }
  void reportFiinQuantHealth();
}

function setActiveProvider(provider: PriceProviderId): void {
  if (provider === 'dnse' && !dnseFeed) provider = 'demo';
  activeProvider = provider;
  localStorage.setItem(ACTIVE_PROVIDER_KEY, provider);
  refreshProviderUi();
  reloadAllTiles();
  tradingWorkspace?.setSourceLabel(currentFeed().label);
  syncWatchlistFeeds();
}

function currentFeed(): { feed: Datafeed | null; label: string; unavailable: string | null } {
  if (activeProvider === 'demo') {
    return { feed: demoFeed, label: 'Demo', unavailable: null };
  }
  if (activeProvider === 'dnse') {
    return dnseFeed
      ? { feed: dnseFeed, label: 'DNSE', unavailable: null }
      : { feed: null, label: 'DNSE', unavailable: 'đăng nhập DNSE' };
  }
  return { feed: fiinQuantFeed, label: 'FiinQuant', unavailable: null };
}

let watchlistGeneration = 0;
let watchlistUnsubscribers: Array<() => void> = [];

function syncWatchlistFeeds(seedSymbols: string[] = []): void {
  watchlistGeneration += 1;
  const generation = watchlistGeneration;
  for (const unsubscribe of watchlistUnsubscribers) unsubscribe();
  watchlistUnsubscribers = [];

  const provider = currentFeed();
  if (!provider.feed || !tradingWorkspace) return;
  const requestedSeeds = new Set(seedSymbols.map((symbol) => symbol.trim().toUpperCase()));
  const watchlistSymbols = new Map<string, {
    symbols: string[];
    previousClose: number;
    lastTime: number;
  }>();
  for (const rawSymbol of tradingWorkspace.getWatchlist()) {
    const symbol = rawSymbol.trim().toUpperCase();
    const feedSymbol = activeProvider === 'dnse' ? normalizeDnseSymbol(symbol) : symbol;
    if (!feedSymbol) continue;
    const existingQuote = marketHub.get(symbol);
    const current = watchlistSymbols.get(feedSymbol);
    if (current) {
      current.symbols.push(symbol);
      continue;
    }
    watchlistSymbols.set(feedSymbol, {
      symbols: [symbol],
      previousClose: existingQuote?.source === provider.label
        ? existingQuote.last - existingQuote.change
        : 0,
      lastTime: 0,
    });
  }

  const publishWatchlistCandle = (feedSymbol: string, candle: Candle) => {
    const state = watchlistSymbols.get(feedSymbol.toUpperCase());
    if (!state || generation !== watchlistGeneration) return;
    state.lastTime = Math.max(state.lastTime, candle.time);
    for (const symbol of state.symbols) {
      marketHub.update(preserveDepth(
        quoteFromCandle(symbol, candle, state.previousClose || candle.open, provider.label),
        marketHub.get(symbol),
      ));
    }
  };

  const feedSymbols = [...watchlistSymbols.keys()];
  if (provider.feed.subscribeMany && feedSymbols.length > 0) {
    watchlistUnsubscribers.push(provider.feed.subscribeMany(
      feedSymbols,
      '1d',
      publishWatchlistCandle,
    ));
  } else {
    for (const feedSymbol of feedSymbols) {
      const unsubscribe = provider.feed.subscribe(feedSymbol, '1d', (candle) => {
        publishWatchlistCandle(feedSymbol, candle);
      });
      watchlistUnsubscribers.push(unsubscribe);
    }
  }

  // Seed every row even outside market hours. FiinQuant uses 500 daily bars so
  // selecting a watchlist symbol can reuse the sidecar cache immediately. The
  // sequential queue leaves the second historical slot free for an active chart.
  const seedQueue = [...watchlistSymbols.entries()].sort(([, a], [, b]) => {
    const aRequested = a.symbols.some((symbol) => requestedSeeds.has(symbol));
    const bRequested = b.symbols.some((symbol) => requestedSeeds.has(symbol));
    return Number(bRequested) - Number(aRequested);
  });
  void (async () => {
    for (const [feedSymbol, state] of seedQueue) {
      if (generation !== watchlistGeneration) return;
      try {
        const seedLimit = activeProvider === 'fiinquant' ? HISTORY_PAGE_SIZE : 2;
        const candles = await provider.feed!.getHistory(feedSymbol, '1d', seedLimit);
        if (generation !== watchlistGeneration) return;
        if (candles.length === 0) continue;
        const last = candles[candles.length - 1];
        state.previousClose = candles[candles.length - 2]?.close ?? last.open;
        if (state.lastTime > last.time) continue;
        state.lastTime = last.time;
        for (const symbol of state.symbols) {
          marketHub.update(preserveDepth(
            quoteFromCandle(symbol, last, state.previousClose, provider.label),
            marketHub.get(symbol),
          ));
        }
      } catch {
        // One unavailable watchlist symbol must not interrupt the remaining feeds.
      }
    }
  })();

  if (provider.feed.subscribeQuotes && watchlistSymbols.size > 0) {
    const unsubscribe = provider.feed.subscribeQuotes(feedSymbols, (update) => {
      if (generation !== watchlistGeneration) return;
      const state = watchlistSymbols.get(update.symbol.toUpperCase());
      if (!state) return;
      for (const symbol of state.symbols) {
        marketHub.update(quoteFromDepth(symbol, update, provider.label, marketHub.get(symbol)));
      }
    });
    watchlistUnsubscribers.push(unsubscribe);
  }
}

function reloadAllTiles(): void {
  for (const tile of tiles) void tile.load();
}

function closeTilePopovers(): void {
  document.querySelectorAll<HTMLElement>('.tile-popover').forEach((popover) => {
    popover.hidden = true;
    popover.closest('.drawing-tool-group')
      ?.querySelector<HTMLElement>('.drawing-menu-primary')
      ?.setAttribute('aria-expanded', 'false');
  });
}

interface SymbolAutocompleteOptions {
  extraSymbols: () => string[];
  onSelect: (symbol: string) => void;
}

let symbolAutocompleteId = 0;

function attachSymbolAutocomplete(
  input: HTMLInputElement,
  options: SymbolAutocompleteOptions,
): () => void {
  const host = input.parentElement;
  if (!host) return () => undefined;
  host.classList.add('symbol-autocomplete-host');
  input.autocomplete = 'off';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');

  const menu = document.createElement('div');
  menu.className = 'symbol-suggestions';
  menu.id = `symbol-suggestions-${++symbolAutocompleteId}`;
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  input.setAttribute('aria-controls', menu.id);
  host.appendChild(menu);

  let matches: SymbolSearchResult[] = searchInstruments(input.value, options.extraSymbols());
  let activeIndex = -1;
  let requestId = 0;
  let remoteTimer: number | null = null;
  let composing = false;

  const close = () => {
    menu.hidden = true;
    activeIndex = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };

  const commit = (symbol: string) => {
    input.value = symbol.trim().toUpperCase();
    close();
    options.onSelect(input.value);
  };

  const highlight = (index: number) => {
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>('.symbol-suggestion')];
    if (buttons.length === 0) return;
    activeIndex = (index + buttons.length) % buttons.length;
    buttons.forEach((button, buttonIndex) => button.classList.toggle('active', buttonIndex === activeIndex));
    input.setAttribute('aria-activedescendant', buttons[activeIndex].id);
    buttons[activeIndex].scrollIntoView({ block: 'nearest' });
  };

  const renderMatches = (nextMatches: SymbolSearchResult[]) => {
    matches = nextMatches;
    activeIndex = -1;
    menu.replaceChildren();
    for (const [index, instrument] of matches.entries()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'symbol-suggestion';
      button.id = `${menu.id}-option-${index}`;
      button.setAttribute('role', 'option');
      const symbol = document.createElement('strong');
      symbol.textContent = instrument.symbol;
      const name = document.createElement('span');
      name.textContent = instrument.name || 'Vietnam security';
      const exchange = document.createElement('small');
      exchange.textContent = instrument.exchange || '';
      button.append(symbol, name, exchange);
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        commit(instrument.symbol);
      });
      menu.appendChild(button);
    }
    menu.hidden = matches.length === 0;
    input.setAttribute('aria-expanded', String(matches.length > 0));
  };

  const render = () => {
    const query = normalizeCommandText(input.value);
    const localMatches = searchInstruments(query, options.extraSymbols(), 100)
      .filter((item) => item.symbol.includes(query))
      .slice(0, 20);
    const currentRequest = ++requestId;
    renderMatches(localMatches);
    if (remoteTimer !== null) window.clearTimeout(remoteTimer);
    const feed = currentFeed().feed;
    if (!query || !feed?.searchSymbols) return;
    remoteTimer = window.setTimeout(() => {
      remoteTimer = null;
      void feed.searchSymbols!(query, 30).then((remoteMatches) => {
        if (currentRequest !== requestId || document.activeElement !== input) return;
        const merged = new Map<string, SymbolSearchResult>();
        for (const item of [...localMatches, ...remoteMatches]) {
          if (!merged.has(item.symbol)) merged.set(item.symbol, item);
        }
        renderMatches([...merged.values()].slice(0, 30));
      }).catch(() => undefined);
    }, 120);
  };

  const normalizeInputValue = () => {
    const normalized = normalizeCommandText(input.value);
    if (input.value === normalized) return;
    input.value = normalized;
    try {
      input.setSelectionRange(normalized.length, normalized.length);
    } catch {
      // Some mobile browsers expose limited selection APIs during IME edits.
    }
  };
  const onCompositionStart = () => {
    composing = true;
  };
  const onCompositionEnd = () => {
    composing = false;
    normalizeInputValue();
    render();
  };
  const onInput = () => {
    if (!composing) normalizeInputValue();
    render();
  };
  const onFocus = () => render();
  const onBlur = () => window.setTimeout(close, 100);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (menu.hidden) render();
      highlight(activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (event.key === 'Escape') {
      close();
      return;
    }
    if (event.key !== 'Enter' || !input.value.trim()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    commit(matches[activeIndex >= 0 ? activeIndex : 0]?.symbol ?? input.value);
  };
  const onDocumentPointerDown = (event: PointerEvent) => {
    if (!host.contains(event.target as Node)) close();
  };

  input.addEventListener('compositionstart', onCompositionStart);
  input.addEventListener('compositionend', onCompositionEnd);
  input.addEventListener('input', onInput);
  input.addEventListener('focus', onFocus);
  input.addEventListener('blur', onBlur);
  input.addEventListener('keydown', onKeyDown);
  document.addEventListener('pointerdown', onDocumentPointerDown);

  return () => {
    requestId += 1;
    if (remoteTimer !== null) window.clearTimeout(remoteTimer);
    input.removeEventListener('compositionstart', onCompositionStart);
    input.removeEventListener('compositionend', onCompositionEnd);
    input.removeEventListener('input', onInput);
    input.removeEventListener('focus', onFocus);
    input.removeEventListener('blur', onBlur);
    input.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('pointerdown', onDocumentPointerDown);
    menu.remove();
  };
}

class Tile {
  readonly el: HTMLDivElement;
  readonly chart: L2Chart;
  symbol: string;
  interval: string;
  mode: PriceSeriesMode = 'candles';
  readonly active = new Map<string, IndicatorInstance>();
  /** Indicator parameters persist while an indicator is toggled off. */
  private readonly paramsById = new Map<string, Params>();

  private unsubscribe: (() => void) | null = null;
  private quoteUnsubscribe: (() => void) | null = null;
  private realtimeConnectionUnsubscribe: (() => void) | null = null;
  private realtimeGapLoading = false;
  private loadToken = 0;
  private loading = false;
  private historyPageLoading = false;
  private historyPageExhausted = false;
  private historyPageRetryAfter = 0;
  /** Full history stays private while the chart only receives replayed candles. */
  private history: Candle[] = [];
  private replay: ReplayState | null = null;
  private replaySelecting = false;
  private historyRange: HistoryRange | null = null;
  private readonly headerEl: HTMLDivElement;
  private readonly chartShellEl: HTMLDivElement;
  private readonly loadStateEl: HTMLDivElement;
  private feedEl: HTMLSpanElement;
  private symbolInput!: HTMLInputElement;
  private symbolAutocompleteCleanup: (() => void) | null = null;
  private intervalValueEl!: HTMLSpanElement;
  private readonly intervalButtons = new Map<string, HTMLButtonElement>();
  private drawingToolbar!: HTMLDivElement;
  private drawingContextToolbar!: HTMLDivElement;
  private selectedDrawingForToolbar: SerializedDrawing | null = null;
  private readonly knownDrawingIds = new Set<number>();
  private inlineTextEditor: HTMLTextAreaElement | null = null;
  private inlineTextDrawingId: number | null = null;
  private marketEl!: HTMLSpanElement;
  private countdownTimer: number | null = null;
  private latestQuote: MarketQuote | null = null;
  private pricePrecision: number | null = null;
  private candleColors: CandleColors | null;

  constructor(symbol: string, initialTemplate?: TileTemplate) {
    const initialPreferences = initialTemplate
      ? preferencesFromTemplate(initialTemplate)
      : preferencesFor(symbol);
    this.symbol = symbol;
    this.interval = INTERVALS.includes(initialPreferences.interval) ? initialPreferences.interval : '1d';
    this.mode = initialPreferences.mode;
    this.candleColors = initialPreferences.candleColors
      ? { ...defaultCandleColors(), ...initialPreferences.candleColors }
      : null;

    this.el = document.createElement('div');
    this.el.className = 'tile';

    const header = (this.headerEl = document.createElement('div'));
    header.className = 'tile-header';
    const symbolControl = document.createElement('div');
    symbolControl.className = 'symbol-control';
    const symbolIcon = document.createElement('span');
    symbolIcon.className = 'symbol-control-icon';
    symbolIcon.innerHTML = toolIcon('<circle cx="9" cy="9" r="5"/><path d="m13 13 4 4"/>');
    const symbolInput = (this.symbolInput = document.createElement('input'));
    symbolInput.className = 'tile-symbol';
    symbolInput.value = symbol;
    symbolInput.spellcheck = false;
    symbolInput.setAttribute('aria-label', 'Mã chứng khoán');
    symbolControl.append(symbolIcon, symbolInput);
    this.symbolAutocompleteCleanup = attachSymbolAutocomplete(symbolInput, {
      extraSymbols: () => [...DEFAULT_SYMBOLS, ...(tradingWorkspace?.getWatchlist() ?? [])],
      onSelect: (selectedSymbol) => {
        this.setSymbol(selectedSymbol);
        symbolInput.blur();
      },
    });

    const intervalPicker = document.createElement('div');
    intervalPicker.className = 'interval-picker';
    const intervalButton = document.createElement('button');
    intervalButton.type = 'button';
    intervalButton.className = 'interval-trigger';
    intervalButton.title = 'Chọn khung thời gian';
    const intervalValue = (this.intervalValueEl = document.createElement('span'));
    intervalValue.textContent = intervalLabel(this.interval);
    const intervalChevron = document.createElement('span');
    intervalChevron.className = 'interval-chevron';
    intervalChevron.innerHTML = toolIcon('<path d="m6 8 4 4 4-4"/>');
    intervalButton.append(intervalValue, intervalChevron);
    const intervalMenu = document.createElement('div');
    intervalMenu.className = 'tile-popover interval-menu';
    intervalMenu.hidden = true;
    for (const iv of INTERVALS) {
      const option = document.createElement('button');
      option.type = 'button';
      option.textContent = intervalLabel(iv);
      option.classList.toggle('active', iv === this.interval);
      option.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setIntervalCode(iv);
        intervalMenu.hidden = true;
      });
      intervalMenu.appendChild(option);
      this.intervalButtons.set(iv, option);
    }
    intervalButton.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = intervalMenu.hidden;
      closeTilePopovers();
      intervalMenu.hidden = !willOpen;
    });
    intervalPicker.append(intervalButton, intervalMenu);

    this.feedEl = document.createElement('span');
    this.feedEl.className = 'tile-feed';
    this.marketEl = document.createElement('span');
    this.marketEl.className = 'tile-market';
    this.marketEl.textContent = '-- / -- · --:--';
    header.append(symbolControl, intervalPicker);

    const chartShell = (this.chartShellEl = document.createElement('div'));
    chartShell.className = 'tile-chart-shell';
    const chartEl = document.createElement('div');
    chartEl.className = 'tile-chart';
    const loadState = (this.loadStateEl = document.createElement('div'));
    loadState.className = 'tile-load-state';
    loadState.hidden = true;
    loadState.setAttribute('role', 'status');
    loadState.setAttribute('aria-live', 'polite');
    chartShell.append(chartEl, loadState);
    this.el.appendChild(chartShell);
    this.chart = new L2Chart(chartEl, { theme: this.resolvedTheme() });
    this.applyPricePrecision();
    this.chart.setMode(this.mode);
    this.applyTheme();
    this.chart.setSessionsVisible(initialPreferences.sessions);
    this.drawingContextToolbar = this.createDrawingContextToolbar();
    chartShell.appendChild(this.drawingContextToolbar);
    if (!globalDrawingToolbar) {
      globalDrawingToolbar = this.createDrawingToolbar();
      this.drawingToolbar = globalDrawingToolbar;
      document.getElementById('global-drawing-toolbar-host')!.appendChild(globalDrawingToolbar);
      this.applyGlobalDrawingToolbarPreferences();
    } else {
      this.drawingToolbar = globalDrawingToolbar;
    }

    this.chart.on('data', () => {
      for (const ind of this.active.values()) ind.recompute();
    });
    this.chart.onVisibleRangeChange(({ from, dataLength }) => {
      if (dataLength > 0 && from <= HISTORY_PAGE_TRIGGER_BARS) void this.loadOlderHistory();
    });
    this.chart.on('crosshair', (e) => {
      if (!syncEnabled) return;
      for (const t of tiles) {
        if (t !== this) t.chart.setExternalCrosshair(e.candle?.time ?? null);
      }
    });
    this.chart.onBarClick((e) => {
      if (!this.replaySelecting || e.index === null) return;
      this.startReplay(e.index);
    });
    this.chart.onDrawingsChange((drawings, selectedId) => {
      const selectedDrawing = selectedId === null ? null : drawings.find((drawing) => drawing.id === selectedId) ?? null;
      const isNewDrawing = !!selectedDrawing && !this.knownDrawingIds.has(selectedDrawing.id);
      const isNewEditableDrawing = isNewDrawing && TEXT_EDITABLE_DRAWING_TOOLS.has(selectedDrawing.tool);
      this.knownDrawingIds.clear();
      drawings.forEach((drawing) => this.knownDrawingIds.add(drawing.id));
      saveDrawings(this.symbol, this.interval, drawings);
      this.renderDrawingContextToolbar(drawings, selectedId);
      if (isNewEditableDrawing && selectedDrawing) this.openInlineTextEditor(selectedDrawing);
      if (isNewDrawing && this.chart.getDrawingTool() !== 'cursor') {
        this.selectDrawingTool('cursor');
        hideDrawingEscapeHint();
      }
      if (activeTile === this) tradingWorkspace?.refreshObjects();
      if (activeTile === this) refreshDrawingHistoryButtons();
    });
    this.chart.onDrawingEditRequest((id) => {
      const drawing = this.chart.getDrawings().find((item) => item.id === id);
      if (!drawing || !TEXT_EDITABLE_DRAWING_TOOLS.has(drawing.tool)) return false;
      this.openInlineTextEditor(drawing);
      return true;
    });
    this.chart.onIndicatorRemove((id) => {
      if (!this.active.has(id)) return;
      setActiveTile(this);
      this.toggleIndicator(id);
      refreshToolbar();
    });
    this.chart.onIndicatorSettings((id) => {
      if (!this.active.has(id)) return;
      setActiveTile(this);
      openParamDialog(id);
    });
    this.el.addEventListener('pointerdown', () => setActiveTile(this));

    for (const [id, params] of Object.entries(initialPreferences.indicatorParams ?? {})) {
      this.paramsById.set(id, { ...params });
    }
    for (const id of initialPreferences.indicators) this.toggleIndicator(id, false);
    if (initialTemplate?.paneWeights) this.chart.setPaneWeights(initialTemplate.paneWeights);
    this.chart.setDrawings(readDrawings(this.symbol, this.interval));
    this.countdownTimer = window.setInterval(() => this.renderMarketStatus(), 1000);
    void this.load();
  }

  /** Change the symbol from the header or command palette. */
  setSymbol(raw: string, reload = true): void {
    const s = activeProvider === 'dnse' ? normalizeDnseSymbol(raw) : raw.trim().toUpperCase();
    if (!s) return;
    if (s === this.symbol) return;
    const currentPreferences = this.currentPreferences();
    this.persistPreferences();
    this.symbol = s;
    this.applyPricePrecision();
    this.symbolInput.value = s;
    persistTileSymbols();
    savePreferencesFor(this.symbol, currentPreferences);
    this.chart.setDrawings(readDrawings(this.symbol, this.interval));
    if (reload) void this.load();
    tradingWorkspace?.refreshActiveSymbol();
    tradingWorkspace?.refreshObjects();
  }

  /** Change the timeframe using an interval code such as `15m` or `1h`. */
  setIntervalCode(iv: string, reload = true): boolean {
    if (!INTERVAL_SECONDS[iv] || !INTERVALS.includes(iv)) return false;
    if (iv === this.interval) return true;
    this.interval = iv;
    if (this.historyRange) this.historyRange = constrainHistoryRange(this.historyRange, iv);
    this.intervalValueEl.textContent = intervalLabel(iv);
    for (const [value, button] of this.intervalButtons) button.classList.toggle('active', value === iv);
    this.chart.setDrawings(readDrawings(this.symbol, this.interval));
    this.persistPreferences();
    if (reload) void this.load();
    return true;
  }

  getTemplateSnapshot(): TileTemplate {
    return {
      symbol: this.symbol,
      interval: this.interval,
      mode: this.mode,
      indicators: [...this.active.keys()],
      indicatorParams: Object.fromEntries(
        [...this.active.keys()].map((id) => [id, this.getParams(id)]),
      ),
      sessions: this.chart.getSessionsVisible(),
      candleColors: this.candleColors ? { ...this.candleColors } : undefined,
      paneWeights: this.chart.getPaneWeights(),
    };
  }

  applyTemplate(template: TileTemplate): void {
    if (template.symbol) this.setSymbol(template.symbol, false);
    this.interval = INTERVALS.includes(template.interval) ? template.interval : this.interval;
    this.intervalValueEl.textContent = intervalLabel(this.interval);
    for (const [value, button] of this.intervalButtons) button.classList.toggle('active', value === this.interval);
    this.mode = template.mode;
    this.chart.setMode(template.mode);
    this.chart.setSessionsVisible(template.sessions);
    this.candleColors = template.candleColors
      ? { ...defaultCandleColors(), ...template.candleColors }
      : null;
    this.applyTheme();
    this.paramsById.clear();
    for (const [id, params] of Object.entries(template.indicatorParams ?? {})) {
      this.paramsById.set(id, { ...params });
    }
    this.replaceIndicators(template.indicators);
    if (template.paneWeights) this.chart.setPaneWeights(template.paneWeights);
    this.chart.setDrawings(readDrawings(this.symbol, this.interval));
    this.persistPreferences();
    void this.load();
    refreshToolbar();
  }

  toggleSessions(): void {
    this.chart.setSessionsVisible(!this.chart.getSessionsVisible());
    this.persistPreferences();
  }

  private currentPreferences(): ChartPreferences {
    return {
      defaultsVersion: CHART_DEFAULTS_VERSION,
      interval: this.interval,
      mode: this.mode,
      indicators: [...this.active.keys()],
      indicatorParams: Object.fromEntries(
        [...this.paramsById].map(([id, params]) => [id, { ...params }]),
      ),
      sessions: this.chart.getSessionsVisible(),
      candleColors: this.candleColors ? { ...this.candleColors } : undefined,
    };
  }

  private persistPreferences(): void {
    savePreferencesFor(this.symbol, this.currentPreferences());
  }

  private resolvedTheme(): Theme {
    const theme = dark ? darkTheme : lightTheme;
    return this.candleColors ? { ...theme, ...this.candleColors } : theme;
  }

  applyTheme(): void {
    this.chart.setTheme(this.resolvedTheme());
    const colors = this.getCandleColors();
    this.chart.setPriceSeriesColors({ line: colors.line, area: colors.area });
  }

  getCandleColors(): CandleColors {
    return this.candleColors
      ? { ...defaultCandleColors(), ...this.candleColors }
      : defaultCandleColors();
  }

  setCandleColors(colors: CandleColors | null): void {
    this.candleColors = colors ? { ...colors } : null;
    this.applyTheme();
    this.persistPreferences();
  }

  private replaceIndicators(ids: string[]): void {
    for (const instance of this.active.values()) instance.remove();
    this.active.clear();
    for (const id of ids) this.toggleIndicator(id, false);
    this.chart.invalidate();
  }

  private applyGlobalDrawingToolbarPreferences(): void {
    this.drawingToolbar.style.removeProperty('left');
    this.drawingToolbar.style.removeProperty('top');
    this.drawingToolbar.hidden = false;
  }

  private createDrawingToolbar(): HTMLDivElement {
    const toolbar = document.createElement('div');
    toolbar.className = 'drawing-toolbar';
    toolbar.setAttribute('aria-label', tr('Công cụ vẽ'));

    toolbar.appendChild(this.createDrawingButton('cursor', tr('Con trỏ')));
    toolbar.appendChild(this.createDrawingMenu('lines', tr('Công cụ đường'), LINE_TOOLS));
    toolbar.appendChild(this.createDrawingButton('fib-retracement', 'Fibonacci retracement'));
    toolbar.appendChild(this.createDrawingMenu('positions', tr('Vị thế và đo lường'), POSITION_TOOLS));
    toolbar.appendChild(this.createDrawingMenu('shapes', tr('Hình học và bút vẽ'), GEOMETRY_TOOLS));
    toolbar.appendChild(this.createDrawingMenu('annotations', 'Annotation', ANNOTATION_TOOLS));

    const divider = document.createElement('span');
    divider.className = 'drawing-divider';
    toolbar.appendChild(divider);

    const undoButton = document.createElement('button');
    undoButton.type = 'button';
    undoButton.className = 'drawing-tool-button';
    undoButton.title = 'Hoàn tác nét vẽ gần nhất';
    undoButton.setAttribute('aria-label', undoButton.title);
    undoButton.dataset.drawingAction = 'undo';
    undoButton.innerHTML = DRAWING_ICONS.undo;
    undoButton.addEventListener('click', (e) => {
      e.stopPropagation();
      activeTile?.chart.undoDrawing();
    });
    toolbar.appendChild(undoButton);

    const redoButton = document.createElement('button');
    redoButton.type = 'button';
    redoButton.className = 'drawing-tool-button';
    redoButton.title = 'Làm lại thao tác vừa hoàn tác';
    redoButton.setAttribute('aria-label', redoButton.title);
    redoButton.dataset.drawingAction = 'redo';
    redoButton.innerHTML = DRAWING_ICONS.redo;
    redoButton.addEventListener('click', (e) => {
      e.stopPropagation();
      activeTile?.chart.redoDrawing();
    });
    toolbar.appendChild(redoButton);

    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.className = 'drawing-tool-button danger';
    clearButton.title = 'Xóa đối tượng hoặc chỉ báo đã chọn';
    clearButton.setAttribute('aria-label', clearButton.title);
    clearButton.innerHTML = DRAWING_ICONS.trash;
    clearButton.addEventListener('click', (e) => {
      e.stopPropagation();
      if (activeTile?.chart.deleteSelectedDrawing()) return;
      if (activeTile?.chart.deleteSelectedIndicator()) return;
      if (activeTile && window.confirm('Xóa toàn bộ annotation trên chart đang chọn?')) {
        activeTile.chart.clearDrawings();
      }
    });
    toolbar.appendChild(clearButton);

    queueMicrotask(() => (activeTile ?? this).selectDrawingTool('cursor'));
    return toolbar;
  }

  private createDrawingButton(tool: DrawingTool, label: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'drawing-tool-button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.dataset.drawingTool = tool;
    button.innerHTML = DRAWING_ICONS[tool];
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      this.activateDrawingTool(tool);
    });
    return button;
  }

  private createDrawingMenu(
    icon: 'lines' | 'positions' | 'shapes' | 'annotations',
    label: string,
    items: DrawingMenuItem[],
  ): HTMLDivElement {
    const group = document.createElement('div');
    group.className = 'drawing-tool-group';
    const storedRecents = readStoredJson<Partial<Record<typeof icon, DrawingTool>>>(DRAWING_RECENTS_KEY, {});
    let recentTool = items.some((item) => item.tool === storedRecents[icon])
      ? storedRecents[icon]!
      : items[0].tool;

    const primary = document.createElement('button');
    primary.type = 'button';
    primary.className = 'drawing-tool-button drawing-menu-primary';
    primary.dataset.drawingTools = items.map((item) => item.tool).join(',');

    const updatePrimary = () => {
      const item = items.find((candidate) => candidate.tool === recentTool) ?? items[0];
      primary.innerHTML = DRAWING_ICONS[item.tool];
      primary.dataset.recentDrawingTool = item.tool;
      primary.title = `${label}: ${tr(item.label)}`;
      primary.setAttribute('aria-label', `${tr('Dùng')} ${tr(item.label)}`);
      menu.querySelectorAll<HTMLButtonElement>('[data-drawing-tool]').forEach((option) => {
        option.classList.toggle('selected', option.dataset.drawingTool === item.tool);
      });
    };
    const remember = (tool: DrawingTool) => {
      recentTool = tool;
      updatePrimary();
      const latestRecents = readStoredJson<Partial<Record<typeof icon, DrawingTool>>>(DRAWING_RECENTS_KEY, {});
      writeStoredJson(DRAWING_RECENTS_KEY, { ...latestRecents, [icon]: tool });
    };
    const menu = document.createElement('div');
    menu.className = 'tile-popover drawing-menu';
    menu.id = `drawing-menu-${icon}`;
    menu.hidden = true;
    primary.setAttribute('aria-haspopup', 'menu');
    primary.setAttribute('aria-controls', menu.id);
    primary.setAttribute('aria-expanded', 'false');
    const heading = document.createElement('div');
    heading.className = 'drawing-menu-heading';
    heading.textContent = tr(label);
    menu.appendChild(heading);
    for (const item of items) {
      const option = document.createElement('button');
      option.type = 'button';
      option.dataset.drawingTool = item.tool;
      option.innerHTML = `${DRAWING_ICONS[item.tool]}<span>${tr(item.label)}</span>`;
      option.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.activateDrawingTool(item.tool)) remember(item.tool);
      });
      menu.appendChild(option);
    }
    updatePrimary();
    primary.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!primary.classList.contains('active')) {
        this.activateDrawingTool(recentTool);
        return;
      }
      const willOpen = menu.hidden;
      closeTilePopovers();
      menu.hidden = !willOpen;
      primary.setAttribute('aria-expanded', String(willOpen));
    });
    primary.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const willOpen = menu.hidden;
      closeTilePopovers();
      menu.hidden = !willOpen;
      primary.setAttribute('aria-expanded', String(willOpen));
    });
    primary.title += ` · ${tr('Nhấp lại để mở nhóm')}`;
    group.append(primary, menu);
    return group;
  }

  private activateDrawingTool(tool: DrawingTool): boolean {
    const text = DRAWING_PROMPTS[tool]?.initial ?? (tool === 'text' ? 'Ghi chú' : '');
    (activeTile ?? this).selectDrawingTool(tool, text);
    if (tool !== 'cursor') showDrawingEscapeHint();
    return true;
  }

  selectDrawingTool(tool: DrawingTool, text = ''): void {
    this.chart.setDrawingTool(tool, text);
    this.drawingToolbar.querySelectorAll<HTMLElement>('[data-drawing-tool]').forEach((button) => {
      button.classList.toggle('active', button.dataset.drawingTool === tool);
    });
    this.drawingToolbar.querySelectorAll<HTMLElement>('[data-drawing-tools]').forEach((button) => {
      const tools = button.dataset.drawingTools?.split(',') ?? [];
      button.classList.toggle('active', tools.includes(tool));
    });
    closeTilePopovers();
  }

  private openInlineTextEditor(drawing: SerializedDrawing): void {
    if (!TEXT_EDITABLE_DRAWING_TOOLS.has(drawing.tool)) return;
    this.closeInlineTextEditor();

    const editor = document.createElement('textarea');
    editor.className = 'drawing-inline-text-editor';
    editor.rows = 1;
    editor.value = drawing.text ?? '';
    editor.placeholder = DRAWING_PROMPTS[drawing.tool]?.message ?? 'Nhập nội dung';
    editor.setAttribute('aria-label', 'Nhập nội dung đối tượng vẽ');
    editor.spellcheck = false;

    const syncText = () => {
      if (this.inlineTextDrawingId !== drawing.id) return;
      this.chart.updateDrawingObject(drawing.id, { text: editor.value });
      this.sizeInlineTextEditor(editor);
      this.positionInlineTextEditor();
    };
    editor.addEventListener('input', syncText);
    editor.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        this.closeInlineTextEditor();
      }
    });
    editor.addEventListener('pointerdown', (event) => event.stopPropagation());
    editor.addEventListener('click', (event) => event.stopPropagation());
    editor.addEventListener('blur', () => this.closeInlineTextEditor());

    this.inlineTextEditor = editor;
    this.inlineTextDrawingId = drawing.id;
    this.chartShellEl.appendChild(editor);
    this.sizeInlineTextEditor(editor);
    this.positionInlineTextEditor();
    window.requestAnimationFrame(() => {
      if (this.inlineTextEditor !== editor) return;
      editor.focus({ preventScroll: true });
      editor.select();
    });
  }

  private closeInlineTextEditor(): void {
    this.inlineTextDrawingId = null;
    const editor = this.inlineTextEditor;
    this.inlineTextEditor = null;
    editor?.remove();
  }

  private sizeInlineTextEditor(editor: HTMLTextAreaElement): void {
    const shellHeight = this.chartShellEl.getBoundingClientRect().height;
    const maxHeight = Math.max(72, Math.min(180, shellHeight - 16));
    editor.style.height = 'auto';
    editor.style.height = `${Math.min(maxHeight, Math.max(40, editor.scrollHeight))}px`;
  }

  private positionInlineTextEditor(): void {
    const editor = this.inlineTextEditor;
    const drawingId = this.inlineTextDrawingId;
    if (!editor || drawingId === null) return;
    const point = this.chart.getDrawingAnchorClientPoint(drawingId);
    if (!point) {
      this.closeInlineTextEditor();
      return;
    }
    const shell = this.chartShellEl.getBoundingClientRect();
    const width = editor.offsetWidth || Math.min(280, Math.max(160, shell.width - 16));
    const height = editor.offsetHeight || 40;
    const x = point.x - shell.left;
    const y = point.y - shell.top;
    const maxLeft = Math.max(8, shell.width - width - 8);
    const maxTop = Math.max(8, shell.height - height - 8);
    editor.style.left = `${Math.max(8, Math.min(maxLeft, x))}px`;
    editor.style.top = `${Math.max(8, Math.min(maxTop, y - 4))}px`;
  }

  private createDrawingContextToolbar(): HTMLDivElement {
    const toolbar = document.createElement('div');
    toolbar.className = 'drawing-context-toolbar';
    toolbar.hidden = true;
    toolbar.setAttribute('aria-label', 'Định dạng đối tượng vẽ');
    toolbar.innerHTML = `
      <button type="button" class="drawing-context-handle" data-action="drag" title="Di chuyển thanh định dạng" aria-label="Di chuyển thanh định dạng">
        ${toolIcon('<circle cx="7" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="13" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="7" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="13" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="7" cy="14" r="1" fill="currentColor" stroke="none"/><circle cx="13" cy="14" r="1" fill="currentColor" stroke="none"/>')}
      </button>
      <label class="drawing-context-color" title="Màu đường">
        <input type="color" data-field="color" aria-label="Màu đường" />
        <span aria-hidden="true"></span>
      </label>
      <select class="drawing-context-select drawing-context-width" data-field="width" title="Độ dày" aria-label="Độ dày đường">
        <option value="1">1 px</option>
        <option value="1.5">1.5 px</option>
        <option value="2">2 px</option>
        <option value="3">3 px</option>
        <option value="4">4 px</option>
        <option value="5">5 px</option>
      </select>
      <select class="drawing-context-select drawing-context-line-style" data-field="lineStyle" title="Kiểu nét" aria-label="Kiểu nét">
        <option value="solid">Liền</option>
        <option value="dashed">Gạch</option>
        <option value="dotted">Chấm</option>
      </select>
      <select class="drawing-context-select drawing-context-font-size" data-field="fontSize" title="Cỡ chữ" aria-label="Cỡ chữ" hidden>
        <option value="18">18 px</option>
        <option value="24">24 px</option>
        <option value="28">28 px</option>
        <option value="36">36 px</option>
        <option value="48">48 px</option>
        <option value="60">60 px</option>
        <option value="72">72 px</option>
      </select>
      <button type="button" class="drawing-context-button drawing-context-text-button" data-action="text" title="Nhãn và nội dung" aria-label="Nhãn và nội dung">T</button>
      <span class="drawing-context-divider" aria-hidden="true"></span>
      <button type="button" class="drawing-context-button" data-action="visibility" title="Ẩn đối tượng" aria-label="Ẩn đối tượng">
        ${toolIcon('<path d="M2.5 10s2.7-5 7.5-5 7.5 5 7.5 5-2.7 5-7.5 5-7.5-5-7.5-5z"/><circle cx="10" cy="10" r="2.2"/>')}
      </button>
      <button type="button" class="drawing-context-button" data-action="lock" title="Khóa đối tượng" aria-label="Khóa đối tượng">
        ${toolIcon('<rect x="4.5" y="9" width="11" height="8" rx="1.5"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/>')}
      </button>
      <button type="button" class="drawing-context-button danger" data-action="delete" title="Xóa đối tượng" aria-label="Xóa đối tượng">
        ${DRAWING_ICONS.trash}
      </button>
      <div class="drawing-context-text-popover" data-popover="text" hidden>
        <div class="drawing-context-text-head">
          <strong>Nội dung ghi chú</strong>
          <button type="button" data-action="text-close" title="Đóng trình soạn thảo" aria-label="Đóng trình soạn thảo">
            ${lucideIcon(X)}
          </button>
        </div>
        <div class="drawing-context-text-format">
          <label>
            <span>Màu chữ</span>
            <input type="color" data-field="textColor" aria-label="Màu chữ" />
          </label>
          <label>
            <span>Cỡ chữ</span>
            <select data-field="textFontSize" aria-label="Cỡ chữ">
              <option value="18">18 px</option>
              <option value="24">24 px</option>
              <option value="28">28 px</option>
              <option value="36">36 px</option>
              <option value="48">48 px</option>
              <option value="60">60 px</option>
              <option value="72">72 px</option>
            </select>
          </label>
        </div>
        <input type="text" class="drawing-context-label-field" data-field="label" placeholder="Nhãn phụ (tùy chọn)" aria-label="Nhãn đối tượng" />
        <textarea data-field="text" rows="4" placeholder="Nhập nội dung ghi chú" aria-label="Nội dung đối tượng"></textarea>
        <button type="button" class="drawing-context-text-done" data-action="text-done">Hoàn tất</button>
      </div>
    `;

    const color = toolbar.querySelector<HTMLInputElement>('[data-field="color"]')!;
    const width = toolbar.querySelector<HTMLSelectElement>('[data-field="width"]')!;
    const lineStyle = toolbar.querySelector<HTMLSelectElement>('[data-field="lineStyle"]')!;
    const fontSize = toolbar.querySelector<HTMLSelectElement>('[data-field="fontSize"]')!;
    const textColor = toolbar.querySelector<HTMLInputElement>('[data-field="textColor"]')!;
    const textFontSize = toolbar.querySelector<HTMLSelectElement>('[data-field="textFontSize"]')!;
    const label = toolbar.querySelector<HTMLInputElement>('[data-field="label"]')!;
    const textInput = toolbar.querySelector<HTMLTextAreaElement>('[data-field="text"]')!;
    const textPopover = toolbar.querySelector<HTMLDivElement>('[data-popover="text"]')!;
    const textButton = toolbar.querySelector<HTMLButtonElement>('[data-action="text"]')!;
    const textCloseButton = toolbar.querySelector<HTMLButtonElement>('[data-action="text-close"]')!;
    const textDoneButton = toolbar.querySelector<HTMLButtonElement>('[data-action="text-done"]')!;
    const lockButton = toolbar.querySelector<HTMLButtonElement>('[data-action="lock"]')!;
    const visibilityButton = toolbar.querySelector<HTMLButtonElement>('[data-action="visibility"]')!;
    const deleteButton = toolbar.querySelector<HTMLButtonElement>('[data-action="delete"]')!;
    const dragHandle = toolbar.querySelector<HTMLButtonElement>('[data-action="drag"]')!;

    const updateStyle = (patch: Partial<DrawingStyle>) => {
      const drawing = this.selectedDrawingForToolbar;
      if (drawing) this.chart.updateDrawingObject(drawing.id, { style: patch });
    };
    color.addEventListener('input', () => {
      textColor.value = color.value;
      updateStyle({ color: color.value });
    });
    width.addEventListener('change', () => updateStyle({ width: Number(width.value) }));
    lineStyle.addEventListener('change', () => updateStyle({ lineStyle: lineStyle.value as DrawingStyle['lineStyle'] }));
    fontSize.addEventListener('change', () => {
      textFontSize.value = fontSize.value;
      updateStyle({ fontSize: Number(fontSize.value) });
    });
    textColor.addEventListener('input', () => {
      color.value = textColor.value;
      updateStyle({ color: textColor.value });
    });
    textFontSize.addEventListener('change', () => {
      fontSize.value = textFontSize.value;
      updateStyle({ fontSize: Number(textFontSize.value) });
    });
    label.addEventListener('input', () => updateStyle({ label: label.value }));
    textInput.addEventListener('input', () => {
      const drawing = this.selectedDrawingForToolbar;
      if (drawing) this.chart.updateDrawingObject(drawing.id, { text: textInput.value });
    });
    textButton.addEventListener('click', () => {
      const drawing = this.selectedDrawingForToolbar;
      if (drawing && PLAIN_TEXT_DRAWING_TOOLS.has(drawing.tool)) {
        textPopover.hidden = true;
        textButton.classList.remove('active');
        this.openInlineTextEditor(drawing);
        return;
      }
      textPopover.hidden = !textPopover.hidden;
      textButton.classList.toggle('active', !textPopover.hidden);
      if (!textPopover.hidden) textInput.focus({ preventScroll: true });
    });
    const closeTextEditor = () => {
      textPopover.hidden = true;
      textButton.classList.remove('active');
    };
    textCloseButton.addEventListener('click', closeTextEditor);
    textDoneButton.addEventListener('click', closeTextEditor);
    textInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' || ((event.metaKey || event.ctrlKey) && event.key === 'Enter')) {
        event.preventDefault();
        closeTextEditor();
      }
    });
    lockButton.addEventListener('click', () => updateStyle({ locked: !this.selectedDrawingForToolbar?.style?.locked }));
    visibilityButton.addEventListener('click', () => updateStyle({ visible: this.selectedDrawingForToolbar?.style?.visible === false }));
    deleteButton.addEventListener('click', () => {
      const drawing = this.selectedDrawingForToolbar;
      if (drawing) this.chart.deleteDrawing(drawing.id);
    });

    let dragOffset: { x: number; y: number } | null = null;
    dragHandle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = toolbar.getBoundingClientRect();
      dragOffset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      dragHandle.setPointerCapture(event.pointerId);
    });
    dragHandle.addEventListener('pointermove', (event) => {
      if (!dragOffset) return;
      const shell = toolbar.parentElement?.getBoundingClientRect();
      if (!shell) return;
      const left = Math.max(8, Math.min(shell.width - toolbar.offsetWidth - 8, event.clientX - shell.left - dragOffset.x));
      const top = Math.max(8, Math.min(shell.height - toolbar.offsetHeight - 8, event.clientY - shell.top - dragOffset.y));
      toolbar.style.left = `${left}px`;
      toolbar.style.top = `${top}px`;
      toolbar.style.transform = 'none';
    });
    const stopDragging = () => { dragOffset = null; };
    dragHandle.addEventListener('pointerup', stopDragging);
    dragHandle.addEventListener('pointercancel', stopDragging);
    toolbar.addEventListener('pointerdown', (event) => event.stopPropagation());
    return toolbar;
  }

  private renderDrawingContextToolbar(drawings: SerializedDrawing[], selectedId: number | null): void {
    const drawing = selectedId === null ? null : drawings.find((item) => item.id === selectedId) ?? null;
    const selectionChanged = drawing?.id !== this.selectedDrawingForToolbar?.id;
    this.selectedDrawingForToolbar = drawing;
    this.drawingContextToolbar.hidden = !drawing;
    if (!drawing) {
      this.closeInlineTextEditor();
      return;
    }
    if (selectionChanged && this.inlineTextDrawingId !== drawing.id) this.closeInlineTextEditor();

    const style = drawing.style ?? {};
    const color = this.drawingContextToolbar.querySelector<HTMLInputElement>('[data-field="color"]')!;
    color.value = style.color || (dark ? darkTheme.palette[0] : lightTheme.palette[0]);
    const plainText = PLAIN_TEXT_DRAWING_TOOLS.has(drawing.tool);
    const width = this.drawingContextToolbar.querySelector<HTMLSelectElement>('[data-field="width"]')!;
    const lineStyle = this.drawingContextToolbar.querySelector<HTMLSelectElement>('[data-field="lineStyle"]')!;
    const fontSize = this.drawingContextToolbar.querySelector<HTMLSelectElement>('[data-field="fontSize"]')!;
    width.value = String(style.width ?? 1.5);
    width.hidden = plainText;
    lineStyle.value = style.lineStyle ?? 'solid';
    lineStyle.hidden = plainText;
    fontSize.value = String(style.fontSize ?? 28);
    fontSize.hidden = !plainText;
    const labelInput = this.drawingContextToolbar.querySelector<HTMLInputElement>('[data-field="label"]')!;
    labelInput.value = style.label ?? '';
    labelInput.hidden = plainText;
    const textColor = this.drawingContextToolbar.querySelector<HTMLInputElement>('[data-field="textColor"]')!;
    textColor.value = color.value;
    this.drawingContextToolbar.querySelector<HTMLSelectElement>('[data-field="textFontSize"]')!.value = String(style.fontSize ?? 28);
    const textInput = this.drawingContextToolbar.querySelector<HTMLTextAreaElement>('[data-field="text"]')!;
    textInput.value = drawing.text ?? '';

    const textPopover = this.drawingContextToolbar.querySelector<HTMLDivElement>('[data-popover="text"]')!;
    const textButton = this.drawingContextToolbar.querySelector<HTMLButtonElement>('[data-action="text"]')!;
    const textButtonLabel = plainText ? 'Sửa nội dung' : 'Nhãn và nội dung';
    textButton.title = textButtonLabel;
    textButton.setAttribute('aria-label', textButtonLabel);
    if (selectionChanged || plainText || !TEXT_EDITABLE_DRAWING_TOOLS.has(drawing.tool)) {
      textPopover.hidden = true;
      textButton.classList.remove('active');
    }

    const lockButton = this.drawingContextToolbar.querySelector<HTMLButtonElement>('[data-action="lock"]')!;
    lockButton.classList.toggle('active', style.locked === true);
    lockButton.setAttribute('aria-pressed', String(style.locked === true));
    lockButton.title = style.locked ? 'Mở khóa đối tượng' : 'Khóa đối tượng';
    lockButton.setAttribute('aria-label', lockButton.title);
    const visibilityButton = this.drawingContextToolbar.querySelector<HTMLButtonElement>('[data-action="visibility"]')!;
    visibilityButton.classList.toggle('active', style.visible === false);
    visibilityButton.setAttribute('aria-pressed', String(style.visible === false));
    visibilityButton.title = style.visible === false ? 'Hiện đối tượng' : 'Ẩn đối tượng';
    visibilityButton.setAttribute('aria-label', visibilityButton.title);
  }

  private setFeedStatus(kind: 'live' | 'sample' | 'replay' | 'error' | 'loading', label: string): void {
    this.feedEl.className = `tile-feed ${kind}`;
    this.feedEl.textContent = label;
  }

  private setLoadState(kind: 'loading' | 'error' | null, detail = ''): void {
    if (kind === null) {
      this.loadStateEl.hidden = true;
      this.loadStateEl.replaceChildren();
      return;
    }
    const title = document.createElement('strong');
    title.textContent = kind === 'loading'
      ? (getLocale() === 'vi' ? 'Đang tải dữ liệu' : 'Loading market data')
      : (getLocale() === 'vi' ? 'Không thể tải biểu đồ' : 'Unable to load chart');
    this.loadStateEl.className = `tile-load-state ${kind}`;
    this.loadStateEl.replaceChildren(title);
    if (detail) {
      const message = document.createElement('span');
      message.textContent = detail;
      this.loadStateEl.appendChild(message);
    }
    this.loadStateEl.hidden = false;
  }

  private publishCandle(candle: Candle, source: string): void {
    const candles = this.chart.getCandles();
    const reference = candles[candles.length - 2]?.close ?? candle.open;
    const quote = preserveDepth(quoteFromCandle(this.symbol, candle, reference, source), this.latestQuote);
    this.latestQuote = quote;
    this.chart.setMarketQuote({
      bid: quote.hasBidAsk ? quote.bid : null,
      ask: quote.hasBidAsk ? quote.ask : null,
      last: quote.last,
      time: quote.time,
    });
    marketHub.update(quote);
    this.renderMarketStatus();
  }

  private publishDepth(update: QuoteUpdate, source: string): void {
    const quote = quoteFromDepth(this.symbol, update, source, this.latestQuote);
    this.latestQuote = quote;
    this.chart.setMarketQuote({
      bid: quote.hasBidAsk ? quote.bid : null,
      ask: quote.hasBidAsk ? quote.ask : null,
      last: quote.last,
      time: quote.time,
    });
    marketHub.update(quote);
    this.renderMarketStatus();
  }

  private renderMarketStatus(): void {
    const quote = this.latestQuote;
    const lastCandle = this.chart.getCandles()[this.chart.getCandles().length - 1];
    if (!quote) {
      this.marketEl.textContent = `-- / -- · ${countdownText(lastCandle, this.interval)}`;
      return;
    }
    const decimals = this.pricePrecision ?? (quote.last < 10 ? 3 : 2);
    const matched = `Khớp ${quote.last.toFixed(decimals)}`;
    const book = quote.hasBidAsk
      ? ` · B ${quote.bid.toFixed(decimals)}  A ${quote.ask.toFixed(decimals)}`
      : '';
    this.marketEl.textContent = `${matched}${book} · ${countdownText(lastCandle, this.interval)}`;
  }

  private applyPricePrecision(): void {
    this.pricePrecision = pricePrecisionForSymbol(this.symbol);
    this.chart?.setPricePrecision(this.pricePrecision);
  }

  getReplayInfo(): ReplayInfo {
    if (this.replaySelecting) return { phase: 'selecting', cursor: 0, total: this.history.length, speed: 1 };
    if (!this.replay) return { phase: 'idle', cursor: 0, total: this.history.length, speed: 1 };
    return {
      phase: this.replay.playing ? 'playing' : 'paused',
      cursor: this.replay.cursor,
      total: this.replay.candles.length,
      speed: this.replay.speed,
    };
  }

  getHistoryRange(): HistoryRange | null {
    return this.historyRange ? { ...this.historyRange } : null;
  }

  getHistorySummary(): { from: number; to: number; count: number } | null {
    if (this.history.length === 0) return null;
    return {
      from: this.history[0].time,
      to: this.history[this.history.length - 1].time,
      count: this.history.length,
    };
  }

  setHistoryRange(range: HistoryRange, interval?: string): HistoryRange | null {
    const from = Math.floor(range.from);
    const to = Math.floor(range.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return null;
    if (interval) this.setIntervalCode(interval, false);
    this.historyRange = constrainHistoryRange({ from, to }, this.interval);
    void this.load();
    return { ...this.historyRange };
  }

  mountControls(host: HTMLElement): void {
    host.replaceChildren(this.headerEl);
  }

  clearHistoryRange(): void {
    if (!this.historyRange) return;
    this.historyRange = null;
    void this.load();
  }

  toggleReplay(): void {
    if (this.replay || this.replaySelecting) {
      this.stopReplay();
      return;
    }
    this.startReplaySelection();
  }

  toggleReplayPlayback(): void {
    const replay = this.replay;
    if (!replay) return;
    if (replay.playing) {
      this.pauseReplay();
    } else {
      this.playReplay();
    }
  }

  stepReplay(): void {
    const replay = this.replay;
    if (!replay || replay.cursor >= replay.candles.length - 1) {
      this.pauseReplay();
      this.updateReplayStatus();
      return;
    }
    replay.cursor += 1;
    const candle = { ...replay.candles[replay.cursor] };
    this.chart.updateCandle(candle);
    this.publishCandle(candle, 'Replay');
    if (replay.cursor >= replay.candles.length - 1) this.pauseReplay();
    this.updateReplayStatus();
  }

  cycleReplaySpeed(): void {
    const replay = this.replay;
    if (!replay) return;
    const speeds = [1, 2, 5, 10];
    replay.speed = speeds[(speeds.indexOf(replay.speed) + 1) % speeds.length];
    if (replay.playing) {
      this.pauseReplay();
      this.playReplay();
    }
    refreshReplayUi();
  }

  stopReplay(): void {
    const hadReplay = this.replay !== null || this.replaySelecting;
    this.clearReplayState();
    refreshReplayUi();
    if (hadReplay) void this.load();
  }

  private startReplaySelection(): void {
    if (this.history.length < 2) return;
    this.replaySelecting = true;
    this.selectDrawingTool('cursor');
    this.chart.setReplaySelectionMode(true);
    this.setFeedStatus('replay', 'chọn nến bắt đầu');
    refreshReplayUi();
  }

  private startReplay(index: number): void {
    if (this.history.length < 2) return;
    const cursor = Math.min(Math.max(0, index), this.history.length - 2);
    this.replaySelecting = false;
    this.chart.setReplaySelectionMode(false);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.quoteUnsubscribe?.();
    this.quoteUnsubscribe = null;
    this.replay = {
      candles: this.history.map((candle) => ({ ...candle })),
      cursor,
      speed: 1,
      playing: false,
      timer: null,
    };
    this.chart.setData(this.replay.candles.slice(0, cursor + 1).map((candle) => ({ ...candle })));
    this.chart.fitContent();
    this.publishCandle(this.replay.candles[cursor], 'Replay');
    this.updateReplayStatus();
  }

  private playReplay(): void {
    const replay = this.replay;
    if (!replay || replay.cursor >= replay.candles.length - 1) return;
    replay.playing = true;
    replay.timer = window.setInterval(() => this.stepReplay(), Math.max(100, 1000 / replay.speed));
    this.updateReplayStatus();
  }

  private pauseReplay(): void {
    const replay = this.replay;
    if (!replay) return;
    if (replay.timer !== null) window.clearInterval(replay.timer);
    replay.timer = null;
    replay.playing = false;
  }

  private clearReplayState(): void {
    this.pauseReplay();
    this.replay = null;
    this.replaySelecting = false;
    this.chart.setReplaySelectionMode(false);
    refreshReplayUi();
  }

  private updateReplayStatus(): void {
    const replay = this.replay;
    if (!replay) return;
    const suffix = replay.cursor >= replay.candles.length - 1 ? 'kết thúc' : `${replay.cursor + 1}/${replay.candles.length}`;
    this.setFeedStatus('replay', `replay · ${suffix}`);
    refreshReplayUi();
  }

  private updateHistory(candle: Candle): void {
    const last = this.history[this.history.length - 1];
    if (last && candle.time === last.time) this.history[this.history.length - 1] = { ...candle };
    else if (!last || candle.time > last.time) this.history.push({ ...candle });
  }

  async recoverRealtimeGap(): Promise<void> {
    if (this.realtimeGapLoading || this.historyRange || this.replay || this.history.length === 0) return;

    const providerId = activeProvider;
    const provider = currentFeed();
    if (!provider.feed) return;

    const token = this.loadToken;
    const symbol = this.symbol;
    const interval = this.interval;
    const step = INTERVAL_SECONDS[interval] ?? 60;
    const lastTime = this.history[this.history.length - 1].time;
    const to = Math.floor(Date.now() / 1000);
    if (to < lastTime + step) return;

    this.realtimeGapLoading = true;
    try {
      const limit = Math.min(2000, Math.max(4, Math.ceil((to - lastTime) / step) + 2));
      const missing = await provider.feed.getHistory(symbol, interval, limit, { from: lastTime, to });
      if (
        token !== this.loadToken
        || providerId !== activeProvider
        || currentFeed().feed !== provider.feed
        || symbol !== this.symbol
        || interval !== this.interval
        || this.historyRange
        || this.replay
      ) return;

      const byTime = new Map<number, Candle>();
      for (const candle of missing) byTime.set(candle.time, { ...candle });
      // Realtime candles win when a historical response overlaps the active bar.
      for (const candle of this.history) byTime.set(candle.time, { ...candle });
      const merged = [...byTime.values()].sort((a, b) => a.time - b.time);
      const changed = merged.length !== this.history.length || merged.some((candle, index) => {
        const previous = this.history[index];
        return !previous
          || candle.time !== previous.time
          || candle.open !== previous.open
          || candle.high !== previous.high
          || candle.low !== previous.low
          || candle.close !== previous.close
          || candle.volume !== previous.volume;
      });
      if (!changed) return;

      const wasAtEnd = this.chart.timeScale.isAtEnd();
      this.history = merged;
      this.chart.setData(this.history.map((candle) => ({ ...candle })));
      if (wasAtEnd) this.chart.scrollToLatest();
      const latest = this.history[this.history.length - 1];
      if (latest) this.publishCandle(latest, provider.label);
      if (activeTile === this) syncRangeUi();
    } catch (error) {
      console.warn(`Unable to backfill realtime gap for ${symbol} ${interval}`, error);
    } finally {
      this.realtimeGapLoading = false;
    }
  }

  async load(): Promise<void> {
    const token = ++this.loadToken;
    this.loading = true;
    this.historyPageLoading = false;
    this.historyPageExhausted = false;
    this.historyPageRetryAfter = 0;
    this.clearReplayState();
    const hadRenderableData = this.history.length > 0;
    this.latestQuote = null;
    this.chart.setMarketQuote(null);
    this.renderMarketStatus();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.quoteUnsubscribe?.();
    this.quoteUnsubscribe = null;
    this.realtimeConnectionUnsubscribe?.();
    this.realtimeConnectionUnsubscribe = null;

    const providerId = activeProvider;
    const provider = currentFeed();
    this.chart.setLegendTitle(`${this.symbol} · ${intervalLabel(this.interval)}`);
    this.chart.setWatermark(this.symbol);
    if (!provider.feed) {
      this.history = [];
      this.chart.setData([]);
      this.loading = false;
      const message = provider.unavailable ?? 'chưa có nguồn giá';
      this.setFeedStatus('error', message);
      this.setLoadState('error', message);
      return;
    }

    this.setFeedStatus('loading', this.historyRange ? 'đang tải lịch sử...' : 'đang tải...');
    this.setLoadState('loading', `${this.symbol} · ${this.interval}`);
    try {
      const step = INTERVAL_SECONDS[this.interval] ?? 60;
      const range = this.historyRange ? { ...this.historyRange } : undefined;
      const requestedBars = range ? Math.ceil((range.to - range.from) / step) + 2 : HISTORY_PAGE_SIZE;
      const limit = range ? Math.min(20000, Math.max(50, requestedBars)) : HISTORY_PAGE_SIZE;
      const loaded = await provider.feed.getHistory(this.symbol, this.interval, limit, range);
      if (token !== this.loadToken) return;
      const candles = range
        ? loaded.filter((candle) => candle.time >= range.from && candle.time <= range.to)
        : loaded;
      if (candles.length === 0) {
        if (!hadRenderableData) this.history = [];
        const message = `không có dữ liệu ${this.symbol}`;
        this.setFeedStatus('error', message);
        this.setLoadState('error', message);
        return;
      }
      reportProviderLoadSuccess(providerId);
      this.setLoadState(null);
      this.chart.setIntervalSec(step);
      this.history = candles.map((candle) => ({ ...candle }));
      this.chart.setData(this.history.map((candle) => ({ ...candle })));
      this.chart.fitContent();
      this.publishCandle(this.history[this.history.length - 1], provider.label);
      if (range) {
        this.setFeedStatus('sample', `${provider.label} · lịch sử`);
        if (activeTile === this) syncRangeUi();
        return;
      }
      this.setFeedStatus('live', `${provider.label} · chờ tick`);
      this.realtimeConnectionUnsubscribe = provider.feed.onRealtimeConnected?.(() => {
        if (token === this.loadToken) void this.recoverRealtimeGap();
      }) ?? null;
      this.unsubscribe = provider.feed.subscribe(this.symbol, this.interval, (c) => {
        if (token !== this.loadToken || this.replay) return;
        const last = this.history[this.history.length - 1];
        const step = INTERVAL_SECONDS[this.interval] ?? 60;
        if (last && c.time > last.time + step) void this.recoverRealtimeGap();
        this.updateHistory(c);
        this.chart.updateCandle(c);
        this.publishCandle(c, provider.label);
        this.setFeedStatus('live', `${provider.label} · ${new Date(c.time * 1000).toLocaleTimeString()}`);
      });
      this.quoteUnsubscribe = provider.feed.subscribeQuotes?.([this.symbol], (quote) => {
        if (token !== this.loadToken || this.replay) return;
        this.publishDepth(quote, provider.label);
      }) ?? null;
      void this.recoverRealtimeGap();
    } catch (err) {
      if (token !== this.loadToken) return;
      console.error(err);
      if (!hadRenderableData) {
        this.history = [];
        this.chart.setData([]);
      }
      const message = err instanceof Error ? err.message : 'lỗi nguồn giá';
      reportProviderLoadFailure(providerId, message);
      this.setFeedStatus('error', message);
      this.setLoadState('error', message);
    } finally {
      if (token === this.loadToken) {
        this.loading = false;
        if (activeTile === this) syncRangeUi();
      }
    }
  }

  private async loadOlderHistory(): Promise<void> {
    if (
      this.loading
      || this.realtimeGapLoading
      || this.historyPageLoading
      || this.historyPageExhausted
      || this.historyRange
      || this.replay
      || this.history.length === 0
      || Date.now() < this.historyPageRetryAfter
    ) return;

    const providerId = activeProvider;
    const provider = currentFeed();
    if (!provider.feed) return;
    const loadToken = this.loadToken;
    const oldestTime = this.history[0].time;
    const step = INTERVAL_SECONDS[this.interval] ?? 60;
    const to = oldestTime - 1;
    const lookback = step < 86400
      ? Math.max(HISTORY_PAGE_SIZE * step * 8, 10 * 86400)
      : Math.max(HISTORY_PAGE_SIZE * step * 2, 365 * 86400);
    const range = { from: Math.max(0, to - lookback), to };

    this.historyPageLoading = true;
    try {
      const loaded = await provider.feed.getHistory(
        this.symbol,
        this.interval,
        HISTORY_PAGE_SIZE,
        range,
      );
      if (loadToken !== this.loadToken || providerId !== activeProvider) return;

      const existingTimes = new Set(this.history.map((candle) => candle.time));
      const older = loaded
        .filter((candle) => candle.time < oldestTime && !existingTimes.has(candle.time))
        .sort((a, b) => a.time - b.time);
      if (older.length === 0) {
        this.historyPageExhausted = true;
        return;
      }

      this.history = [...older.map((candle) => ({ ...candle })), ...this.history];
      this.chart.prependData(older.map((candle) => ({ ...candle })));
    } catch (error) {
      this.historyPageRetryAfter = Date.now() + 5000;
      console.warn(`Unable to load older ${provider.label} history`, error);
    } finally {
      if (loadToken === this.loadToken) this.historyPageLoading = false;
    }
  }

  getParams(id: string): Params {
    const def = getIndicator(id);
    return { ...(def ? defaultParams(def) : {}), ...(this.paramsById.get(id) ?? {}) };
  }

  toggleIndicator(id: string, persist = true): void {
    const existing = this.active.get(id);
    if (existing) {
      existing.remove();
      this.active.delete(id);
      if (persist) this.persistPreferences();
      return;
    }
    const def = getIndicator(id);
    if (!def) return;
    const params = this.getParams(id);
    const inst = this.chart.withIndicatorOwner(
      id,
      () => def.create(this.chart, params),
      indicatorAppearanceFromParams(id, params),
    );
    inst.recompute();
    this.active.set(id, inst);
    this.chart.invalidate();
    if (persist) this.persistPreferences();
  }

  /** Apply new parameters and recreate the indicator when active. */
  setIndicatorParams(id: string, params: Params): void {
    const def = getIndicator(id);
    if (!def) return;
    this.paramsById.set(id, params);
    this.active.get(id)?.remove();
    const mergedParams = this.getParams(id);
    const inst = this.chart.withIndicatorOwner(
      id,
      () => def.create(this.chart, mergedParams),
      indicatorAppearanceFromParams(id, mergedParams),
    );
    inst.recompute();
    this.active.set(id, inst);
    this.chart.invalidate();
    this.persistPreferences();
  }

  setMode(mode: PriceSeriesMode): void {
    this.mode = mode;
    this.chart.setMode(mode);
    this.persistPreferences();
  }

  destroy(): void {
    this.clearReplayState();
    if (this.countdownTimer !== null) window.clearInterval(this.countdownTimer);
    this.unsubscribe?.();
    this.quoteUnsubscribe?.();
    this.realtimeConnectionUnsubscribe?.();
    this.symbolAutocompleteCleanup?.();
    this.headerEl.remove();
    this.chart.destroy();
    this.el.remove();
  }
}

const chartsEl = document.getElementById('charts')!;
const tiles: Tile[] = [];
let activeTile: Tile | null = null;

function setActiveTile(tile: Tile): void {
  tile.mountControls(document.getElementById('active-tile-controls')!);
  if (activeTile === tile) return;
  activeTile?.chart.setDrawingTool('cursor');
  activeTile = tile;
  tile.selectDrawingTool('cursor');
  const visibleCount = tiles.filter((item) => !item.el.hidden).length || tiles.length;
  for (const t of tiles) {
    t.el.classList.toggle('active', t === tile && visibleCount > 1);
    if (t !== tile) {
      t.chart.clearDrawingSelection();
      t.chart.clearIndicatorSelection();
    }
  }
  refreshToolbar();
  syncRangeUi();
  tradingWorkspace?.refreshActiveSymbol();
  tradingWorkspace?.refreshObjects();
  refreshDrawingHistoryButtons();
}

function refreshDrawingHistoryButtons(): void {
  const undo = globalDrawingToolbar?.querySelector<HTMLButtonElement>('[data-drawing-action="undo"]');
  const redo = globalDrawingToolbar?.querySelector<HTMLButtonElement>('[data-drawing-action="redo"]');
  if (undo) undo.disabled = !activeTile?.chart.canUndoDrawing();
  if (redo) redo.disabled = !activeTile?.chart.canRedoDrawing();
}

type LayoutId = '1' | '2v' | '2h' | '3' | '4' | '6';

const LAYOUT_COUNTS: Record<LayoutId, number> = { '1': 1, '2v': 2, '2h': 2, '3': 3, '4': 4, '6': 6 };
let activeLayout: LayoutId = '1';

function visibleTilesForLayout(layout: LayoutId): Tile[] {
  const count = LAYOUT_COUNTS[layout];
  if (count === 1) {
    const selected = activeTile && tiles.includes(activeTile) ? activeTile : tiles[0];
    return selected ? [selected] : [];
  }
  return tiles.slice(0, count);
}

function createTileForSlot(index: number, template?: TileTemplate): Tile {
  const savedSymbol = uiPreferences.symbols[index]?.trim().toUpperCase();
  const symbol = template?.symbol?.trim().toUpperCase()
    || savedSymbol
    || DEFAULT_SYMBOLS[index % DEFAULT_SYMBOLS.length];
  const tile = new Tile(symbol, template);
  tiles.push(tile);
  chartsEl.appendChild(tile.el);
  return tile;
}

function applyTemplateSnapshots(layout: LayoutId, templateSnapshots: TileTemplate[]): void {
  const desiredCount = Math.max(LAYOUT_COUNTS[layout], templateSnapshots.length);
  while (tiles.length > desiredCount) {
    const t = tiles.pop()!;
    if (activeTile === t) activeTile = null;
    t.destroy();
  }
  const reusableCount = Math.min(tiles.length, templateSnapshots.length);
  while (tiles.length < desiredCount) {
    createTileForSlot(tiles.length, templateSnapshots[tiles.length]);
  }
  templateSnapshots.forEach((snapshot, index) => {
    const tile = tiles[index];
    if (tile && index < reusableCount) tile.applyTemplate(snapshot);
  });
}

function refreshLayoutVisibility(): void {
  const visible = visibleTilesForLayout(activeLayout);
  const visibleSet = new Set(visible);
  tiles.forEach((tile, index) => {
    tile.el.hidden = !visibleSet.has(tile);
    tile.el.style.order = visibleSet.has(tile) ? String(visible.indexOf(tile)) : String(index);
    tile.el.classList.toggle('active', tile === activeTile && visible.length > 1);
  });
  if (activeTile && !visibleSet.has(activeTile)) {
    setActiveTile(visible[0] ?? tiles[0]);
    return;
  }
  if (!activeTile && visible[0]) setActiveTile(visible[0]);
}

function setLayout(layout: LayoutId, templateSnapshots: TileTemplate[] = []): void {
  activeLayout = layout;
  const count = LAYOUT_COUNTS[layout];
  chartsEl.className = `layout-${layout}`;
  if (templateSnapshots.length > 0) {
    applyTemplateSnapshots(layout, templateSnapshots);
  } else {
    while (tiles.length < count) createTileForSlot(tiles.length);
  }
  refreshLayoutVisibility();
  document.querySelectorAll<HTMLButtonElement>('#layouts button[data-layout]').forEach((button) => {
    button.classList.toggle('active', button.dataset.layout === layout);
  });
  persistTileSymbols(templateSnapshots.length === 0);
  scheduleToolbarOverflow();
}

function persistTileSymbols(preserveTail = true): void {
  if (tiles.length === 0) return;
  const nextSymbols = tiles.map((tile) => tile.symbol);
  if (preserveTail) {
    for (let index = tiles.length; index < uiPreferences.symbols.length; index++) {
      const symbol = uiPreferences.symbols[index]?.trim().toUpperCase();
      if (symbol) nextSymbols[index] = symbol;
    }
  }
  uiPreferences.symbols = nextSymbols;
  saveUiPreferences();
}

const workspaceEl = document.getElementById('workspace')!;
const centerWorkspaceEl = document.getElementById('center-workspace')!;
const watchlistPanel = document.getElementById('watchlist-panel')!;
const rightPanel = document.getElementById('right-panel')!;
const tradeBlotter = document.getElementById('trade-blotter')!;
const watchlistToggle = document.getElementById('watchlist-toggle') as HTMLButtonElement;
const rightPanelToggle = document.getElementById('right-panel-toggle') as HTMLButtonElement;

function applyWatchlistVisibility(visible: boolean): void {
  watchlistPanel.hidden = !visible;
  workspaceEl.classList.toggle('watchlist-collapsed', !visible);
  watchlistToggle.classList.toggle('active', visible);
  watchlistToggle.setAttribute('aria-pressed', String(visible));
  uiPreferences.watchlistVisible = visible;
}

function applyTradeVisibility(visible: boolean): void {
  rightPanel.hidden = !visible;
  tradeBlotter.hidden = !visible;
  workspaceEl.classList.toggle('right-collapsed', !visible);
  centerWorkspaceEl.classList.toggle('blotter-collapsed', !visible);
  rightPanelToggle.classList.toggle('active', visible);
  rightPanelToggle.setAttribute('aria-pressed', String(visible));
  uiPreferences.rightPanelVisible = visible;
}

function setWatchlistVisible(visible: boolean, persist = true): void {
  if (visible) applyTradeVisibility(false);
  applyWatchlistVisibility(visible);
  if (persist) saveUiPreferences();
}

function setRightPanelVisible(visible: boolean, persist = true): void {
  if (visible) applyWatchlistVisibility(false);
  applyTradeVisibility(visible);
  if (persist) saveUiPreferences();
}

watchlistToggle.addEventListener('click', () => setWatchlistVisible(!uiPreferences.watchlistVisible));
rightPanelToggle.addEventListener('click', () => setRightPanelVisible(!uiPreferences.rightPanelVisible));
document.getElementById('watchlist-close')!.addEventListener('click', () => setWatchlistVisible(false));
document.getElementById('right-panel-close')!.addEventListener('click', () => setRightPanelVisible(false));

const rangeFromInput = document.getElementById('range-from') as HTMLInputElement;
const rangeToInput = document.getElementById('range-to') as HTMLInputElement;
const rangeLive = document.getElementById('range-live') as HTMLButtonElement;
const rangeStatus = document.getElementById('range-status')!;

function toLocalDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function readRangeInput(input: HTMLInputElement, endOfDay = false): number | null {
  const parts = input.value.split('-').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;
  const date = new Date(parts[0], parts[1] - 1, parts[2], endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0);
  return Math.floor(date.getTime() / 1000);
}

function mountRangeDatePicker(input: HTMLInputElement): void {
  const label = input.closest('label')!;
  label.classList.add('range-date-field');
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'range-calendar-trigger';
  trigger.innerHTML = lucideIcon(CalendarDays);
  trigger.title = input.getAttribute('aria-label') ?? 'Chọn ngày';
  trigger.setAttribute('aria-label', trigger.title);
  label.appendChild(trigger);

  const popover = document.createElement('div');
  popover.className = 'range-calendar-popover';
  popover.hidden = true;
  document.body.appendChild(popover);
  let view = new Date();

  const close = () => { popover.hidden = true; };
  const parseSelected = () => {
    const [year, month, day] = input.value.split('-').map(Number);
    return year && month && day ? new Date(year, month - 1, day) : new Date();
  };
  const render = () => {
    const year = view.getFullYear();
    const month = view.getMonth();
    const selected = parseSelected();
    const firstOffset = (new Date(year, month, 1).getDay() + 6) % 7;
    const days = new Date(year, month + 1, 0).getDate();
    popover.innerHTML = `
      <div class="range-calendar-head">
        <button type="button" data-calendar-nav="prev" aria-label="Tháng trước">${lucideIcon(ChevronLeft)}</button>
        <strong>Tháng ${month + 1}, ${year}</strong>
        <button type="button" data-calendar-nav="next" aria-label="Tháng sau">${lucideIcon(ChevronRight)}</button>
      </div>
      <div class="range-calendar-weekdays">${['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'].map((day) => `<span>${day}</span>`).join('')}</div>
      <div class="range-calendar-grid"></div>`;
    popover.querySelector<HTMLButtonElement>('[data-calendar-nav="prev"]')!.onclick = () => {
      view = new Date(year, month - 1, 1);
      render();
    };
    popover.querySelector<HTMLButtonElement>('[data-calendar-nav="next"]')!.onclick = () => {
      view = new Date(year, month + 1, 1);
      render();
    };
    const grid = popover.querySelector<HTMLDivElement>('.range-calendar-grid')!;
    for (let slot = 0; slot < 42; slot++) {
      const day = slot - firstOffset + 1;
      const button = document.createElement('button');
      button.type = 'button';
      if (day < 1 || day > days) {
        button.className = 'empty';
        button.tabIndex = -1;
      } else {
        const date = new Date(year, month, day);
        button.textContent = String(day);
        button.classList.toggle('selected', date.toDateString() === selected.toDateString());
        button.classList.toggle('today', date.toDateString() === new Date().toDateString());
        button.onclick = () => {
          input.value = toLocalDate(Math.floor(date.getTime() / 1000));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          close();
        };
      }
      grid.appendChild(button);
    }
  };
  const open = (event: Event) => {
    event.stopPropagation();
    document.querySelectorAll<HTMLElement>('.range-calendar-popover').forEach((item) => { item.hidden = true; });
    view = parseSelected();
    render();
    popover.hidden = false;
    const rect = input.getBoundingClientRect();
    const width = 286;
    const top = rect.top > 340 ? rect.top - popover.offsetHeight - 8 : rect.bottom + 8;
    popover.style.left = `${Math.min(window.innerWidth - width - 10, Math.max(10, rect.left))}px`;
    popover.style.top = `${Math.max(10, top)}px`;
  };
  input.addEventListener('click', open);
  trigger.addEventListener('click', open);
  popover.addEventListener('click', (event) => event.stopPropagation());
  window.addEventListener('click', close);
  window.addEventListener('resize', close);
}

mountRangeDatePicker(rangeFromInput);
mountRangeDatePicker(rangeToInput);

const RANGE_PRESET_SELECTOR = '[data-range-days], [data-range-preset], [data-range-years]';

function rangeForPreset(button: HTMLButtonElement, end: number): HistoryRange | null {
  const days = Number(button.dataset.rangeDays);
  if (Number.isFinite(days) && days > 0) return { from: end - days * 86400, to: end };

  const endDate = new Date(end * 1000);
  const fromDate = new Date(endDate);
  if (button.dataset.rangePreset === 'ytd') {
    fromDate.setMonth(0, 1);
    fromDate.setHours(0, 0, 0, 0);
  } else {
    const years = Number(button.dataset.rangeYears);
    if (!Number.isFinite(years) || years <= 0) return null;
    fromDate.setFullYear(fromDate.getFullYear() - years);
  }
  return { from: Math.floor(fromDate.getTime() / 1000), to: end };
}

function intervalForPreset(button: HTMLButtonElement): string | undefined {
  if (button.dataset.rangePreset === 'ytd' || button.dataset.rangeYears) return '1d';
  const days = Number(button.dataset.rangeDays);
  if (days >= 90) return '1h';
  if (days >= 30) return '15m';
  return undefined;
}

function syncRangeUi(): void {
  const range = activeTile?.getHistoryRange() ?? null;
  const summary = activeTile?.getHistorySummary() ?? null;
  const shown = range ?? summary;
  if (shown) {
    rangeFromInput.value = toLocalDate(shown.from);
    rangeToInput.value = toLocalDate(shown.to);
  }
  rangeLive.classList.toggle('active', !range);
  document.querySelectorAll<HTMLButtonElement>(RANGE_PRESET_SELECTOR).forEach((button) => {
    const expected = range ? rangeForPreset(button, range.to) : null;
    button.classList.toggle('active', !!range && !!expected && Math.abs(range.from - expected.from) < 3600);
  });
  if (!activeTile) {
    rangeStatus.textContent = 'Chưa chọn chart';
  } else if (summary) {
    rangeStatus.textContent = `${activeTile.symbol} · ${summary.count.toLocaleString('vi-VN')} nến${range ? ` · ${activeTile.interval} tối đa ${historyRangeLimitText(activeTile.interval)}` : ''}`;
  } else {
    rangeStatus.textContent = range ? 'Đang tải khoảng lịch sử' : 'Dữ liệu trực tiếp';
  }
}

function applyRangeInputs(): void {
  const from = readRangeInput(rangeFromInput);
  const to = readRangeInput(rangeToInput, true);
  if (!activeTile || from === null || to === null || from >= to) {
    rangeStatus.textContent = 'Khoảng thời gian không hợp lệ';
    rangeStatus.classList.add('error');
    return;
  }
  rangeStatus.classList.remove('error');
  const requested = { from, to };
  const normalized = activeTile.setHistoryRange(requested);
  if (!normalized) return;
  rangeFromInput.value = toLocalDate(normalized.from);
  rangeToInput.value = toLocalDate(normalized.to);
  const constrained = normalized.from !== requested.from;
  rangeStatus.textContent = constrained
    ? `${activeTile.interval} chỉ tải tối đa ${historyRangeLimitText(activeTile.interval)} · đang tải...`
    : 'Đang tải khoảng lịch sử...';
}

rangeFromInput.addEventListener('change', applyRangeInputs);
rangeToInput.addEventListener('change', applyRangeInputs);
rangeLive.addEventListener('click', () => {
  rangeStatus.classList.remove('error');
  activeTile?.clearHistoryRange();
  syncRangeUi();
});
document.querySelectorAll<HTMLButtonElement>(RANGE_PRESET_SELECTOR).forEach((button) => {
  button.addEventListener('click', () => {
    if (!activeTile) return;
    const end = activeTile.getHistoryRange()?.to ?? activeTile.getHistorySummary()?.to ?? Math.floor(Date.now() / 1000);
    const range = rangeForPreset(button, end);
    if (!range) return;
    rangeStatus.classList.remove('error');
    rangeStatus.textContent = 'Đang tải khoảng lịch sử...';
    rangeFromInput.value = toLocalDate(range.from);
    rangeToInput.value = toLocalDate(range.to);
    activeTile.setHistoryRange(range, intervalForPreset(button));
    syncRangeUi();
  });
});

const modeBtns = new Map<PriceSeriesMode, HTMLButtonElement>();
const indItemBtns = new Map<string, HTMLElement>();
const indCount = document.getElementById('ind-count')!;

function refreshToolbar(): void {
  if (!activeTile) {
    refreshReplayUi();
    return;
  }
  const tile = activeTile;
  for (const [mode, btn] of modeBtns) {
    btn.classList.toggle('active', tile.mode === mode);
  }
  const currentMode = MODE_OPTIONS.find(([mode]) => mode === tile.mode) ?? MODE_OPTIONS[0];
  chartTypeIcon.innerHTML = currentMode[2];
  chartTypeButton.title = `Loại biểu đồ: ${currentMode[1]}`;
  chartTypeButton.setAttribute('aria-label', `Loại biểu đồ: ${currentMode[1]}`);
  for (const [id, item] of indItemBtns) {
    item.classList.toggle('active', tile.active.has(id));
  }
  indCount.textContent = tile.active.size ? String(tile.active.size) : '';
  refreshIndicatorLibrary();
  refreshReplayUi();
  if (!templateMenu.hidden) renderTemplateMenu();
  scheduleToolbarOverflow();
}

const replayBtn = document.getElementById('replay-btn') as HTMLButtonElement;
const replayLabel = document.getElementById('replay-label')!;
const replayControls = document.getElementById('replay-controls')!;
const replayStatus = document.getElementById('replay-status')!;
const replayPlay = document.getElementById('replay-play') as HTMLButtonElement;
const replayStep = document.getElementById('replay-step') as HTMLButtonElement;
const replaySpeed = document.getElementById('replay-speed') as HTMLButtonElement;
const replayStop = document.getElementById('replay-stop') as HTMLButtonElement;

const REPLAY_PLAY_ICON = lucideIcon(Play);
const REPLAY_PAUSE_ICON = lucideIcon(Pause);
document.getElementById('replay-icon')!.innerHTML = lucideIcon(CirclePlay);

function refreshReplayUi(): void {
  const replay = activeTile?.getReplayInfo();
  const active = replay && replay.phase !== 'idle';
  const selecting = replay?.phase === 'selecting';
  const playing = replay?.phase === 'playing';

  replayBtn.disabled = !activeTile;
  replayBtn.classList.toggle('active', !!active);
  replayLabel.textContent = selecting ? 'Chọn nến' : active ? 'Trực tiếp' : 'Replay';
  replayBtn.title = active ? 'Dừng replay và quay lại dữ liệu thời gian thực' : 'Mở Bar Replay cho chart đang chọn';

  replayControls.hidden = !active;
  if (!active || !replay) {
    scheduleToolbarOverflow();
    return;
  }
  replayStatus.textContent = selecting
    ? 'Chọn nến'
    : `${replay.cursor + 1}/${replay.total}`;
  replayPlay.innerHTML = `<span class="replay-play-icon ${playing ? 'pause' : 'play'}">${playing ? REPLAY_PAUSE_ICON : REPLAY_PLAY_ICON}</span>`;
  replayPlay.title = playing ? 'Dừng replay' : 'Phát replay';
  replayPlay.disabled = selecting || replay.cursor >= replay.total - 1;
  replayStep.disabled = selecting || replay.cursor >= replay.total - 1;
  replaySpeed.disabled = selecting;
  replaySpeed.textContent = `${replay.speed}×`;
  scheduleToolbarOverflow();
}

replayBtn.addEventListener('click', () => activeTile?.toggleReplay());
replayPlay.addEventListener('click', () => activeTile?.toggleReplayPlayback());
replayStep.addEventListener('click', () => activeTile?.stepReplay());
replaySpeed.addEventListener('click', () => activeTile?.cycleReplaySpeed());
replayStop.addEventListener('click', () => activeTile?.stopReplay());

const templateButton = document.getElementById('template-btn') as HTMLButtonElement;
const templateMenu = document.getElementById('template-menu')!;
document.getElementById('template-icon')!.innerHTML = lucideIcon(LayoutTemplate);

function readTemplates(): ChartTemplate[] {
  const templates = readStoredJson<ChartTemplate[]>(CHART_TEMPLATES_KEY, []);
  return Array.isArray(templates) ? templates : [];
}

function readDefaultTemplateId(): string | null {
  return localStorage.getItem(DEFAULT_CHART_TEMPLATE_KEY);
}

function setDefaultTemplateId(id: string | null): void {
  if (id) localStorage.setItem(DEFAULT_CHART_TEMPLATE_KEY, id);
  else localStorage.removeItem(DEFAULT_CHART_TEMPLATE_KEY);
}

function readDefaultTemplate(): ChartTemplate | null {
  const id = readDefaultTemplateId();
  if (!id) return null;
  return readTemplates().find((template) => template.id === id) ?? null;
}

function saveTemplates(templates: ChartTemplate[]): void {
  const defaultTemplateId = readDefaultTemplateId();
  if (defaultTemplateId && !templates.some((template) => template.id === defaultTemplateId)) {
    setDefaultTemplateId(null);
  }
  writeStoredJson(CHART_TEMPLATES_KEY, templates);
  renderTemplateMenu();
}

function templateTiles(template: ChartTemplate): TileTemplate[] {
  if (Array.isArray(template.tiles) && template.tiles.length > 0) return template.tiles;
  if (!template.interval || !template.mode || !Array.isArray(template.indicators)) return [];
  return [{
    symbol: undefined,
    interval: template.interval,
    mode: template.mode,
    indicators: template.indicators,
    indicatorParams: template.indicatorParams,
    sessions: template.sessions ?? false,
    candleColors: template.candleColors,
  }];
}

function workspaceTemplateTiles(): TileTemplate[] {
  const visibleSlots = activeLayout === '1'
    ? visibleTilesForLayout(activeLayout)
    : tiles.slice(0, LAYOUT_COUNTS[activeLayout]);
  return visibleSlots.map((tile) => tile.getTemplateSnapshot());
}

function workspaceTemplateSnapshot(name: string): ChartTemplate {
  return {
    id: `template-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    layout: activeLayout,
    tiles: workspaceTemplateTiles(),
  };
}

function createNewTemplateWorkspace(): void {
  templateMenu.hidden = true;
  setLayout('1', [defaultTileTemplate()]);
}

function applyWorkspaceTemplate(template: ChartTemplate): void {
  const snapshots = templateTiles(template);
  if (snapshots.length === 0) return;
  if (!template.layout || !template.tiles) {
    activeTile?.applyTemplate(snapshots[0]);
    return;
  }
  setLayout(template.layout, snapshots);
}

function templateMenuButton(label: string, className = ''): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  return button;
}

function renderTemplateMenu(): void {
  templateMenu.replaceChildren();
  const saveForm = document.createElement('form');
  saveForm.className = 'template-save-row';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = tr('Tên mẫu');
  const templateSlotCount = workspaceTemplateTiles().length;
  nameInput.value = activeTile
    ? `${getLocale() === 'vi' ? 'Bố cục' : 'Layout'} ${templateSlotCount} ${getLocale() === 'vi' ? 'biểu đồ' : templateSlotCount === 1 ? 'chart' : 'charts'}`
    : '';
  nameInput.autocomplete = 'off';
  nameInput.setAttribute('aria-label', tr('Tên mẫu'));
  const saveButton = templateMenuButton(tr('Lưu'));
  saveButton.type = 'submit';
  saveButton.disabled = !activeTile;
  saveForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!activeTile) return;
    const name = nameInput.value.trim();
    if (!name) return;
    saveTemplates([workspaceTemplateSnapshot(name), ...readTemplates()]);
  });
  saveForm.append(nameInput, saveButton);
  const sessionsButton = templateMenuButton(
    `${activeTile?.chart.getSessionsVisible() ? '✓' : '○'} ${tr('Phiên giao dịch')}`,
    'template-command',
  );
  sessionsButton.addEventListener('click', () => {
    activeTile?.toggleSessions();
    renderTemplateMenu();
  });
  const createButton = templateMenuButton(tr('Create New Template'), 'template-command template-create');
  createButton.addEventListener('click', createNewTemplateWorkspace);
  templateMenu.append(saveForm, createButton, sessionsButton);

  const templates = readTemplates();
  const defaultTemplateId = readDefaultTemplateId();
  const heading = document.createElement('span');
  heading.className = 'template-heading';
  heading.textContent = tr(templates.length ? 'Mẫu đã lưu' : 'Chưa có mẫu đã lưu');
  templateMenu.appendChild(heading);
  for (const template of templates) {
    const snapshots = templateTiles(template);
    const isDefault = template.id === defaultTemplateId;
    const row = document.createElement('div');
    row.className = 'template-row';
    const apply = templateMenuButton(template.name);
    apply.title = `Áp dụng mẫu ${template.name}`;
    const detail = document.createElement('small');
    const layoutLabel = template.layout ?? '1';
    detail.textContent = `${layoutLabel} · ${snapshots.length} ${getLocale() === 'vi' ? 'biểu đồ' : snapshots.length === 1 ? 'chart' : 'charts'}${isDefault ? ` · ${tr('Mặc định')}` : ''}`;
    apply.appendChild(detail);
    apply.addEventListener('click', () => {
      applyWorkspaceTemplate(template);
      templateMenu.hidden = true;
    });
    const makeDefault = templateMenuButton('', 'template-default');
    makeDefault.innerHTML = lucideIcon(Star);
    makeDefault.classList.toggle('active', isDefault);
    makeDefault.title = tr(isDefault ? 'Bỏ mẫu mặc định' : 'Đặt làm mẫu mặc định');
    makeDefault.setAttribute('aria-label', `${makeDefault.title}: ${template.name}`);
    makeDefault.setAttribute('aria-pressed', String(isDefault));
    makeDefault.addEventListener('click', () => {
      setDefaultTemplateId(isDefault ? null : template.id);
      renderTemplateMenu();
    });
    const edit = templateMenuButton('', 'template-edit');
    edit.innerHTML = lucideIcon(Pencil);
    edit.title = tr('Đổi tên mẫu');
    edit.setAttribute('aria-label', `${tr('Đổi tên mẫu')} ${template.name}`);
    edit.onclick = () => {
      const input = document.createElement('input');
      input.className = 'template-name-input';
      input.value = template.name;
      input.setAttribute('aria-label', 'Tên mẫu mới');
      apply.replaceWith(input);
      edit.innerHTML = lucideIcon(Check);
      edit.title = tr('Lưu tên mẫu');
      let finished = false;
      const finish = (save: boolean) => {
        if (finished) return;
        finished = true;
        const name = input.value.trim();
        if (save && name && name !== template.name) {
          saveTemplates(readTemplates().map((item) => item.id === template.id ? { ...item, name } : item));
        } else {
          renderTemplateMenu();
        }
      };
      edit.onclick = () => finish(true);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') finish(true);
        if (event.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(true));
      input.focus();
      input.select();
    };
    const remove = templateMenuButton('', 'template-delete');
    remove.innerHTML = lucideIcon(X);
    remove.title = tr('Xóa mẫu');
    remove.setAttribute('aria-label', `${tr('Xóa mẫu')} ${template.name}`);
    remove.addEventListener('click', () => saveTemplates(readTemplates().filter((item) => item.id !== template.id)));
    row.append(apply, makeDefault, edit, remove);
    templateMenu.appendChild(row);
  }
}

templateButton.addEventListener('click', (event) => {
  event.stopPropagation();
  const opening = templateMenu.hidden;
  templateMenu.hidden = !opening;
  if (opening) renderTemplateMenu();
});

const LAYOUT_OPTIONS: { id: LayoutId; label: string; icon: string }[] = [
  { id: '1', label: tr('1 chart'), icon: lucideIcon(Square) },
  { id: '2v', label: tr('2 chart dọc'), icon: lucideIcon(Columns2) },
  { id: '2h', label: tr('2 chart ngang'), icon: lucideIcon(Rows2) },
  { id: '3', label: tr('3 chart'), icon: lucideIcon(Columns3) },
  { id: '4', label: tr('4 chart'), icon: lucideIcon(Grid2X2) },
  { id: '6', label: tr('6 chart'), icon: lucideIcon(Columns3) },
];

const layoutsEl = document.getElementById('layouts')!;
for (const option of LAYOUT_OPTIONS) {
  const btn = document.createElement('button');
  btn.dataset.layout = option.id;
  btn.innerHTML = option.icon;
  btn.title = option.label;
  btn.setAttribute('aria-label', option.label);
  if (option.id === '1') btn.classList.add('active');
  btn.onclick = () => {
    layoutsEl.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    setLayout(option.id);
  };
  layoutsEl.appendChild(btn);
}

const CHART_TYPE_ICONS: Record<PriceSeriesMode, string> = {
  candles: toolIcon('<path d="M5 3v14M3 7h4v6H3zM15 2v16M13 5h4v8h-4z"/>'),
  bars: toolIcon('<path d="M5 3v14M2 7h3M5 12h3M14 2v16M11 6h3M14 13h4"/>'),
  line: toolIcon('<path d="m2 15 5-6 4 3 7-8"/>'),
  area: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m2 15 5-6 4 3 7-8v13H2z" fill="currentColor" opacity=".18"/><path d="m2 15 5-6 4 3 7-8" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const MODE_OPTIONS: [PriceSeriesMode, string, string][] = [
  ['candles', 'Nến', CHART_TYPE_ICONS.candles],
  ['bars', 'Bar', CHART_TYPE_ICONS.bars],
  ['line', 'Line', CHART_TYPE_ICONS.line],
  ['area', 'Area', CHART_TYPE_ICONS.area],
];
const chartTypeButton = document.getElementById('chart-type-btn') as HTMLButtonElement;
const chartTypeIcon = document.getElementById('chart-type-icon')!;
const chartTypeMenu = document.getElementById('chart-type-menu')!;
chartTypeIcon.innerHTML = CHART_TYPE_ICONS.candles;
for (const [mode, label, icon] of MODE_OPTIONS) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chart-type-option';
  btn.innerHTML = `${icon}<span>${label}</span>`;
  if (mode === 'candles') btn.classList.add('active');
  btn.onclick = (event) => {
    event.stopPropagation();
    activeTile?.setMode(mode);
    chartTypeMenu.hidden = true;
    chartTypeButton.setAttribute('aria-expanded', 'false');
    refreshToolbar();
  };
  chartTypeMenu.appendChild(btn);
  modeBtns.set(mode, btn);
}
const candleStyleButton = document.createElement('button');
candleStyleButton.type = 'button';
candleStyleButton.className = 'chart-type-option chart-type-settings';
candleStyleButton.innerHTML = `${lucideIcon(Settings2)}<span>Màu biểu đồ</span>`;
candleStyleButton.onclick = (event) => {
  event.stopPropagation();
  chartTypeMenu.hidden = true;
  chartTypeButton.setAttribute('aria-expanded', 'false');
  openCandleStyleDialog();
};
chartTypeMenu.appendChild(candleStyleButton);
chartTypeButton.addEventListener('click', (event) => {
  event.stopPropagation();
  const opening = chartTypeMenu.hidden;
  chartTypeMenu.hidden = !opening;
  chartTypeButton.setAttribute('aria-expanded', String(opening));
});

const indMenu = document.getElementById('ind-menu')!;
const indBtn = document.getElementById('ind-btn')!;
const indicatorOverlay = document.getElementById('indicator-overlay')!;
const indicatorSearchInput = document.getElementById('indicator-search') as HTMLInputElement;
const indicatorDetailCategory = document.getElementById('indicator-detail-category')!;
const indicatorDetailName = document.getElementById('indicator-detail-name')!;
const indicatorDetailDescription = document.getElementById('indicator-detail-description')!;
const indicatorDetailParams = document.getElementById('indicator-detail-params')!;
const indicatorDetailFavorite = document.getElementById('indicator-detail-favorite') as HTMLButtonElement;
const indicatorDetailSettings = document.getElementById('indicator-detail-settings') as HTMLButtonElement;
const indicatorDetailToggle = document.getElementById('indicator-detail-toggle') as HTMLButtonElement;
const indicatorFavoriteCount = document.getElementById('indicator-favorite-count')!;
document.getElementById('indicator-search-icon')!.innerHTML = lucideIcon(Search);
document.getElementById('indicator-library-close')!.innerHTML = lucideIcon(X);

const CATEGORY_LABELS: Record<string, string> = {
  overlay: tr('Biểu đồ giá'),
  volume: tr('Khối lượng'),
  oscillator: tr('Dao động'),
  custom: tr('Tùy chỉnh'),
};

const INDICATOR_DESCRIPTIONS: Record<string, string> = {
  'visible-range-extrema': 'Đánh dấu mức giá cao nhất và thấp nhất trong đúng vùng nến đang hiển thị; tự cập nhật khi kéo hoặc thu phóng chart.',
  sma: 'Đường trung bình động đơn giản giúp nhận diện hướng xu hướng và vùng giá cân bằng trong một chu kỳ.',
  ema: 'Đường trung bình lũy thừa ưu tiên dữ liệu mới, phản ứng nhanh hơn SMA khi xu hướng thay đổi.',
  bollinger: 'Dải biến động quanh đường trung bình, dùng để quan sát độ co giãn biến động và các vùng giá cực trị tương đối.',
  rsi: 'Đo động lượng tăng và giảm trên thang 0–100, thường dùng để đánh giá quá mua, quá bán và phân kỳ.',
  macd: 'So sánh hai EMA để theo dõi xu hướng và động lượng, kèm đường tín hiệu và histogram hội tụ/phân kỳ.',
  adx: 'Đo sức mạnh xu hướng độc lập với chiều tăng giảm; +DI và -DI thể hiện ưu thế của hai phía.',
  atr: 'Đo biên độ dao động thực trung bình, phù hợp để hiệu chỉnh stop loss, position sizing và bộ lọc biến động.',
  volume: 'Hiển thị khối lượng giao dịch theo từng nến để xác nhận mức độ tham gia phía sau biến động giá.',
  'stoch-rsi': 'Chuẩn hóa RSI trong vùng cao-thấp gần nhất để phát hiện thay đổi động lượng nhạy hơn RSI thông thường.',
  obv: 'Cộng dồn khối lượng theo chiều biến động giá để đánh giá dòng tiền đang xác nhận hay phân kỳ với xu hướng.',
  vwap: 'Giá trung bình có trọng số khối lượng, thường được dùng làm mốc tham chiếu giá thực hiện trong phiên.',
};

let indicatorFavorites = new Set(readStoredJson<string[]>(INDICATOR_FAVORITES_KEY, []));
let indicatorFilter = 'all';
let selectedIndicatorId = indicatorCatalog[0]?.id ?? '';

function indicatorDescription(def: IndicatorDef): string {
  if (getLocale() === 'en') {
    const descriptions: Record<string, string> = {
      'visible-range-extrema': 'Marks the highest and lowest prices in the visible bars and updates while you pan or zoom.',
      sma: 'A simple moving average for identifying trend direction and the average price over a selected period.',
      ema: 'An exponential moving average that weights recent prices more heavily and reacts faster than SMA.',
      bollinger: 'Volatility bands around a moving average for observing contraction, expansion, and relative price extremes.',
      rsi: 'Measures bullish and bearish momentum on a 0-100 scale to assess overbought, oversold, and divergence conditions.',
      macd: 'Compares two EMAs to track trend and momentum with a signal line and convergence/divergence histogram.',
      adx: 'Measures trend strength independently of direction while +DI and -DI show directional dominance.',
      atr: 'Measures average true range for volatility filters, stop placement, and position sizing.',
      volume: 'Displays traded volume for each bar to confirm participation behind price movement.',
      'stoch-rsi': 'Normalizes RSI within its recent high-low range for more sensitive momentum signals.',
      obv: 'Accumulates volume by price direction to assess whether money flow confirms or diverges from trend.',
      vwap: 'Volume-weighted average price, commonly used as an intraday execution benchmark.',
    };
    return descriptions[def.id]
      ?? `${def.name} is a ${CATEGORY_LABELS[def.category].toLocaleLowerCase('en-US')} indicator that adds a quantitative view of price and volume data.`;
  }
  return INDICATOR_DESCRIPTIONS[def.id]
    ?? `${def.name} là chỉ báo thuộc nhóm ${CATEGORY_LABELS[def.category].toLocaleLowerCase('vi-VN')}, dùng để bổ sung góc nhìn định lượng cho dữ liệu giá và khối lượng.`;
}

function saveIndicatorFavorites(): void {
  writeStoredJson(INDICATOR_FAVORITES_KEY, [...indicatorFavorites]);
}

function toggleIndicatorFavorite(id: string): void {
  if (indicatorFavorites.has(id)) indicatorFavorites.delete(id);
  else indicatorFavorites.add(id);
  saveIndicatorFavorites();
  refreshIndicatorLibrary();
}

function selectIndicator(id: string): void {
  selectedIndicatorId = id;
  refreshIndicatorLibrary();
}

for (const def of indicatorCatalog) {
  const row = document.createElement('div');
  row.className = 'ind-menu-item';
  row.dataset.indicatorId = def.id;
  row.dataset.indicatorCategory = def.category;
  row.dataset.indicatorSearch = `${def.name} ${CATEGORY_LABELS[def.category]} ${(def.params ?? []).map((param) => param.label).join(' ')} ${indicatorDescription(def)}`.toLocaleLowerCase('vi-VN');

  const favorite = document.createElement('button');
  favorite.type = 'button';
  favorite.className = 'ind-favorite';
  favorite.innerHTML = lucideIcon(Star);
  favorite.addEventListener('click', () => toggleIndicatorFavorite(def.id));

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'ind-item-main';
  main.innerHTML = `<strong>${def.name}</strong><small>${CATEGORY_LABELS[def.category]}</small>`;
  main.addEventListener('click', () => selectIndicator(def.id));
  main.addEventListener('dblclick', () => {
    activeTile?.toggleIndicator(def.id);
    refreshToolbar();
  });

  const settings = document.createElement('button');
  settings.type = 'button';
  settings.className = 'ind-gear';
  settings.innerHTML = lucideIcon(Settings2);
  settings.title = `Cấu hình ${def.name}`;
  settings.setAttribute('aria-label', settings.title);
  settings.addEventListener('click', () => openParamDialog(def.id));

  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'ind-add';
  action.addEventListener('click', () => {
    activeTile?.toggleIndicator(def.id);
    refreshToolbar();
  });
  row.append(favorite, main, settings, action);
  indMenu.appendChild(row);
  indItemBtns.set(def.id, row);
}

function refreshIndicatorLibrary(): void {
  const query = indicatorSearchInput?.value.trim().toLocaleLowerCase('vi-VN') ?? '';
  const rows = [...indMenu.querySelectorAll<HTMLElement>('.ind-menu-item')];
  for (const row of rows) {
    const id = row.dataset.indicatorId ?? '';
    const category = row.dataset.indicatorCategory ?? '';
    const matchesFilter = indicatorFilter === 'all'
      || (indicatorFilter === 'favorites' ? indicatorFavorites.has(id) : category === indicatorFilter);
    row.hidden = !matchesFilter || (!!query && !(row.dataset.indicatorSearch ?? '').includes(query));
    row.classList.toggle('selected', id === selectedIndicatorId);
    row.classList.toggle('favorite', indicatorFavorites.has(id));
    row.classList.toggle('active', !!activeTile?.active.has(id));
    const favoriteButton = row.querySelector<HTMLButtonElement>('.ind-favorite')!;
    const indicatorName = getIndicator(id)?.name ?? id;
    favoriteButton.title = `${indicatorFavorites.has(id) ? 'Bỏ yêu thích' : 'Thêm vào yêu thích'}: ${indicatorName}`;
    favoriteButton.setAttribute('aria-label', favoriteButton.title);
    const action = row.querySelector<HTMLButtonElement>('.ind-add')!;
    const isActive = !!activeTile?.active.has(id);
    action.innerHTML = lucideIcon(isActive ? Check : Plus);
    action.title = isActive ? 'Xóa khỏi chart' : 'Thêm vào chart';
    action.setAttribute('aria-label', `${action.title}: ${indicatorName}`);
  }
  indicatorFavoriteCount.textContent = String(indicatorFavorites.size);

  const visibleRows = rows.filter((row) => !row.hidden);
  if (!visibleRows.length) {
    selectedIndicatorId = '';
    rows.forEach((row) => row.classList.remove('selected'));
    indicatorDetailCategory.textContent = 'Kết quả';
    indicatorDetailName.textContent = 'Không tìm thấy chỉ báo';
    indicatorDetailDescription.textContent = query
      ? `Không có chỉ báo phù hợp với “${indicatorSearchInput.value.trim()}” trong nhóm đang chọn.`
      : 'Nhóm này chưa có chỉ báo.';
    indicatorDetailParams.replaceChildren();
    indicatorDetailFavorite.disabled = true;
    indicatorDetailSettings.disabled = true;
    indicatorDetailToggle.disabled = true;
    return;
  }
  if (!visibleRows.some((row) => row.dataset.indicatorId === selectedIndicatorId)) {
    selectedIndicatorId = visibleRows[0].dataset.indicatorId ?? selectedIndicatorId;
  }
  rows.forEach((row) => row.classList.toggle('selected', row.dataset.indicatorId === selectedIndicatorId));
  const def = getIndicator(selectedIndicatorId);
  if (!def) return;
  indicatorDetailFavorite.disabled = false;
  indicatorDetailSettings.disabled = false;
  indicatorDetailToggle.disabled = false;
  indicatorDetailCategory.textContent = CATEGORY_LABELS[def.category];
  indicatorDetailName.textContent = def.name;
  indicatorDetailDescription.textContent = indicatorDescription(def);
  indicatorDetailParams.replaceChildren();
  const paramTitle = document.createElement('strong');
  paramTitle.textContent = 'Thông số';
  const paramList = document.createElement('div');
  paramList.className = 'indicator-param-chips';
  for (const param of def.params ?? []) {
    const chip = document.createElement('span');
    chip.textContent = `${param.label}: ${param.default}`;
    paramList.appendChild(chip);
  }
  if (!def.params?.length) {
    const chip = document.createElement('span');
    chip.textContent = 'Không có tham số tính toán';
    paramList.appendChild(chip);
  }
  indicatorDetailParams.append(paramTitle, paramList);
  const isFavorite = indicatorFavorites.has(def.id);
  indicatorDetailFavorite.innerHTML = `${lucideIcon(Star)}<span>${isFavorite ? 'Đã yêu thích' : 'Yêu thích'}</span>`;
  indicatorDetailFavorite.classList.toggle('active', isFavorite);
  const isActive = !!activeTile?.active.has(def.id);
  indicatorDetailToggle.innerHTML = `${lucideIcon(isActive ? Check : Plus)}<span>${isActive ? 'Đang dùng' : 'Thêm vào chart'}</span>`;
  indicatorDetailToggle.classList.toggle('active', isActive);
}

document.querySelectorAll<HTMLButtonElement>('[data-indicator-filter]').forEach((button) => {
  button.addEventListener('click', () => {
    indicatorFilter = button.dataset.indicatorFilter ?? 'all';
    document.querySelectorAll('[data-indicator-filter]').forEach((item) => item.classList.toggle('active', item === button));
    refreshIndicatorLibrary();
  });
});
document.querySelector<HTMLElement>('[data-indicator-filter="all"] span')!.textContent = String(indicatorCatalog.length);
indicatorSearchInput.addEventListener('input', refreshIndicatorLibrary);
indicatorDetailFavorite.addEventListener('click', () => toggleIndicatorFavorite(selectedIndicatorId));
indicatorDetailSettings.addEventListener('click', () => openParamDialog(selectedIndicatorId));
indicatorDetailToggle.addEventListener('click', () => {
  activeTile?.toggleIndicator(selectedIndicatorId);
  refreshToolbar();
});

const sourceBtn = document.getElementById('source-btn') as HTMLButtonElement;
const sourcePrefix = document.getElementById('source-prefix')!;
const sourceProvider = document.getElementById('source-provider')!;
const sourceState = document.getElementById('source-state')!;
const providerOverlay = document.getElementById('provider-overlay')!;
const dnseApiKeyInput = document.getElementById('dnse-api-key') as HTMLInputElement;
const dnseApiSecretInput = document.getElementById('dnse-api-secret') as HTMLInputElement;
const dnseRestBaseInput = document.getElementById('dnse-rest-base') as HTMLInputElement;
const dnseWsBaseInput = document.getElementById('dnse-ws-base') as HTMLInputElement;
const providerStatus = document.getElementById('provider-status')!;
const providerSourceSummary = document.getElementById('provider-source-summary')!;
const fiinQuantTokenInput = document.getElementById('fiinquant-token') as HTMLInputElement;
const fiinQuantBaseInput = document.getElementById('fiinquant-base') as HTMLInputElement;
const fiinQuantUsernameInput = document.getElementById('fiinquant-username') as HTMLInputElement;
const fiinQuantPasswordInput = document.getElementById('fiinquant-password') as HTMLInputElement;
const fiinQuantAdvanced = document.getElementById('fiinquant-advanced') as HTMLDetailsElement;
const dnseSaveButton = document.getElementById('dnse-save') as HTMLButtonElement;
const fiinQuantTestButton = document.getElementById('fiinquant-test') as HTMLButtonElement;
const fiinQuantUseButton = document.getElementById('fiinquant-use') as HTMLButtonElement;
const fiinQuantLoginButton = document.getElementById('fiinquant-login') as HTMLButtonElement;
const fiinQuantConnectionNote = document.getElementById('fiinquant-connection-note')!;
let dnseCredentialMode: ProviderCredentialMode = dnseSettings.credentialMode ?? 'session';
let fiinQuantCredentialMode: ProviderCredentialMode = fiinQuantSettings.credentialMode;
let selectedProviderPanel: PriceProviderId = activeProvider;

function renderProviderCredentialModes(): void {
  providerOverlay.querySelectorAll<HTMLButtonElement>('[data-credential-provider]').forEach((button) => {
    const provider = button.dataset.credentialProvider;
    const mode = provider === 'dnse' ? dnseCredentialMode : fiinQuantCredentialMode;
    const active = button.dataset.credentialMode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  providerOverlay.querySelectorAll<HTMLElement>('[data-credential-fields]').forEach((fields) => {
    const [provider, mode] = (fields.dataset.credentialFields ?? '').split(':');
    fields.hidden = mode !== (provider === 'dnse' ? dnseCredentialMode : fiinQuantCredentialMode);
  });
  dnseSaveButton.textContent = dnseCredentialMode === 'server'
    ? tr('Dùng cấu hình server')
    : tr('Dùng cho phiên này');
  const fiinQuantServerMode = fiinQuantCredentialMode === 'server';
  providerOverlay.querySelectorAll<HTMLElement>('[data-session-only="fiinquant"]').forEach((field) => {
    field.hidden = fiinQuantServerMode;
  });
  if (fiinQuantServerMode) fiinQuantBaseInput.value = FIINQUANT_DEFAULT_BASE;
  fiinQuantBaseInput.disabled = fiinQuantServerMode;
  fiinQuantTestButton.hidden = fiinQuantServerMode;
  fiinQuantLoginButton.hidden = fiinQuantServerMode;
  fiinQuantUseButton.hidden = !fiinQuantServerMode;
  fiinQuantConnectionNote.textContent = fiinQuantServerMode
    ? tr('Credential được lấy từ server .env; browser chỉ lưu lựa chọn chế độ.')
    : tr('Phiên trình duyệt chỉ giữ thông tin đăng nhập và sidecar token trong bộ nhớ tab. Khi truy cập qua LAN/Tailscale, cần nhập SIDECAR_TOKEN trong Cài đặt nâng cao.');
}

function setProviderCredentialMode(provider: Exclude<PriceProviderId, 'demo'>, mode: ProviderCredentialMode): void {
  if (provider === 'dnse') {
    dnseCredentialMode = mode;
    dnseSettings.credentialMode = mode;
    dnseSettings.useProxyCredentials = mode === 'server';
    writeStoredJson(DNSE_STORAGE_KEY, sanitizeStoredDnseSettings(dnseSettings));
  } else {
    fiinQuantCredentialMode = mode;
    fiinQuantSettings = { ...fiinQuantSettings, credentialMode: mode };
  }
  renderProviderCredentialModes();
  if (provider === 'fiinquant') saveFiinQuantConnectionSettings();
  if (selectedProviderPanel === provider) {
    if (provider === 'dnse') renderDnseProviderStatus();
    else void reportFiinQuantHealth();
  }
}

function dnseStateLabel(): string {
  if (!dnseFeed) return tr('cần đăng nhập');
  if (dnseRealtimeState === 'connected') return tr('realtime');
  if (dnseRealtimeState === 'error') return tr('lỗi realtime');
  if (dnseRealtimeState === 'connecting'
    || dnseRealtimeState === 'authenticating'
    || dnseRealtimeState === 'reconnecting') return tr('đang kết nối');
  return tr('sẵn sàng');
}

function renderDnseProviderStatus(): void {
  delete providerStatus.dataset.tone;
  if (!dnseFeed) {
    providerStatus.textContent = dnseCredentialMode === 'server'
      ? tr('Dùng cấu hình DNSE từ server .env trên chính máy đang chạy workstation.')
      : tr('Nhập API Key/Secret DNSE để dùng cho phiên trình duyệt này.');
  } else if (dnseRealtimeState === 'error') {
    providerStatus.dataset.tone = 'error';
    providerStatus.textContent = `${tr('Kết nối realtime DNSE thất bại')}${dnseRealtimeDetail ? `: ${tr(dnseRealtimeDetail)}` : ''}`;
  } else if (dnseRealtimeState === 'connected') {
    providerStatus.dataset.tone = 'success';
    providerStatus.textContent = tr('DNSE đang là nguồn giá realtime.');
  } else if (dnseRealtimeState === 'connecting'
    || dnseRealtimeState === 'authenticating'
    || dnseRealtimeState === 'reconnecting') {
    providerStatus.textContent = tr('Đang kết nối realtime DNSE...');
  } else {
    providerStatus.textContent = tr('DNSE đã sẵn sàng. Realtime sẽ mở khi chart hoặc watchlist đăng ký dữ liệu.');
  }
}

function bindDnseRealtimeStatus(): void {
  unsubscribeDnseRealtimeStatus?.();
  unsubscribeDnseRealtimeStatus = null;
  dnseRealtimeState = dnseFeed?.getRealtimeState() ?? 'idle';
  dnseRealtimeDetail = '';
  if (dnseFeed) {
    unsubscribeDnseRealtimeStatus = dnseFeed.onRealtimeStatus((state, detail) => {
      dnseRealtimeState = state;
      dnseRealtimeDetail = detail ?? '';
      renderProviderSourceState();
      if (!providerOverlay.hidden
        && providerOverlay.querySelector<HTMLButtonElement>('[data-provider-tab="dnse"]')?.classList.contains('active')) {
        renderDnseProviderStatus();
      }
    });
  }
}

type ProviderTone = 'success' | 'warning' | 'error' | 'idle';

interface ProviderConnectionSummary {
  service: string;
  realtime: string;
  serviceTone: ProviderTone;
  realtimeTone: ProviderTone;
}

function providerConnectionSummary(provider: PriceProviderId): ProviderConnectionSummary {
  if (provider === 'demo') {
    return {
      service: tr('Khả dụng'),
      realtime: tr('Mô phỏng cục bộ'),
      serviceTone: 'success',
      realtimeTone: 'idle',
    };
  }
  if (provider === 'dnse') {
    const connecting = dnseRealtimeState === 'connecting'
      || dnseRealtimeState === 'authenticating'
      || dnseRealtimeState === 'reconnecting';
    return {
      service: dnseFeed ? tr('Đã cấu hình') : tr('Chưa cấu hình'),
      realtime: dnseRealtimeState === 'connected'
        ? tr('Đang phát dữ liệu')
        : connecting
          ? tr('Đang kết nối')
          : dnseRealtimeState === 'error'
            ? tr('Lỗi kết nối')
            : tr('Chưa mở kết nối'),
      serviceTone: dnseFeed ? 'success' : 'warning',
      realtimeTone: dnseRealtimeState === 'connected'
        ? 'success'
        : dnseRealtimeState === 'error'
          ? 'error'
          : connecting
            ? 'warning'
            : 'idle',
    };
  }

  const stream = fiinQuantHealthSnapshot?.stream;
  if (fiinQuantHealthSnapshot?.tokenConfigured === false) {
    return {
      service: tr('Thiếu sidecar token'),
      realtime: tr('Không khả dụng'),
      serviceTone: 'error',
      realtimeTone: 'error',
    };
  }
  if (fiinQuantHealthSnapshot?.authorized === false) {
    return {
      service: tr('Token không đúng'),
      realtime: tr('Không khả dụng'),
      serviceTone: 'error',
      realtimeTone: 'error',
    };
  }
  const legacySecurity = fiinQuantHealthSnapshot
    ? usesLegacyFiinQuantSecurity(fiinQuantHealthSnapshot)
    : false;
  const tickDetail = stream?.lastTickAt
    ? `${tr('Đang phát dữ liệu')} · ${stream.lastTickSymbol ?? ''} · ${stream.lastMarketTickAt ?? stream.lastTickAt}`
    : stream?.upstreamActive
      ? tr('Đã kết nối, đang chờ tick')
      : tr('Chưa mở kết nối');
  return {
    service: fiinQuantConnectionState === 'connected'
      ? legacySecurity ? `${tr('Trực tuyến')} · ${tr('Sidecar cũ')}` : tr('Trực tuyến')
      : fiinQuantConnectionState === 'checking'
        ? tr('Đang kiểm tra')
        : fiinQuantConnectionState === 'signed-out'
          ? tr('Cần đăng nhập')
          : tr('Không khả dụng'),
    realtime: fiinQuantConnectionState === 'connected' ? tickDetail : tr('Không khả dụng'),
    serviceTone: fiinQuantConnectionState === 'connected'
      ? legacySecurity ? 'warning' : 'success'
      : fiinQuantConnectionState === 'checking'
        ? 'warning'
        : 'error',
    realtimeTone: stream?.lastTickAt
      ? 'success'
      : stream?.upstreamActive
        ? 'warning'
        : 'idle',
  };
}

function renderProviderConnectionSummary(): void {
  providerSourceSummary.replaceChildren();
  const names: Record<PriceProviderId, string> = { demo: 'Demo', dnse: 'DNSE', fiinquant: 'FiinQuant' };
  for (const provider of ['demo', 'dnse', 'fiinquant'] as PriceProviderId[]) {
    const state = providerConnectionSummary(provider);
    const row = document.createElement('div');
    row.className = 'provider-source-row';
    row.classList.toggle('active', provider === activeProvider);
    row.classList.toggle('selected', provider === selectedProviderPanel);
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `${names[provider]} · ${state.service} · ${state.realtime}`);
    row.addEventListener('click', () => setProviderPanel(provider));
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      setProviderPanel(provider);
    });

    const name = document.createElement('strong');
    name.className = 'provider-source-name';
    name.dataset.tone = state.serviceTone;
    name.textContent = names[provider];

    const role = document.createElement('span');
    role.className = 'provider-source-role';
    role.textContent = provider === activeProvider ? tr('Đang dùng') : tr('Dự phòng');

    const service = document.createElement('span');
    service.className = 'provider-source-state';
    service.dataset.tone = state.serviceTone;
    service.textContent = `${tr('Dịch vụ')}: ${state.service}`;

    const realtime = document.createElement('span');
    realtime.className = 'provider-source-state provider-source-realtime';
    realtime.dataset.tone = state.realtimeTone;
    realtime.textContent = `Realtime: ${state.realtime}`;
    realtime.title = realtime.textContent;

    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'provider-source-action';
    if (provider === activeProvider) {
      action.textContent = tr('Đang dùng');
      action.disabled = true;
      action.classList.add('current');
    } else if (provider === 'demo') {
      action.textContent = tr('Dùng');
      action.classList.add('primary');
    } else if (provider === 'dnse') {
      action.textContent = dnseFeed ? tr('Dùng') : tr('Cấu hình');
      action.classList.toggle('primary', !!dnseFeed);
    } else {
      action.textContent = fiinQuantConnectionState === 'signed-out' ? tr('Đăng nhập') : tr('Dùng');
      action.classList.toggle('primary', fiinQuantConnectionState !== 'offline');
    }
    action.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void activateProviderFromSwitcher(provider);
    });

    row.append(name, role, service, realtime, action);
    providerSourceSummary.appendChild(row);
  }
}

function renderProviderSourceState(): void {
  const providerName = activeProvider === 'demo' ? 'Demo' : activeProvider === 'dnse' ? 'DNSE' : 'FiinQuant';
  const fiinState = fiinQuantConnectionState === 'connected'
    ? tr('đã kết nối')
    : fiinQuantConnectionState === 'checking'
      ? tr('đang kiểm tra')
      : fiinQuantConnectionState === 'offline'
        ? tr('ngoại tuyến')
        : tr('cần đăng nhập');
  sourcePrefix.textContent = `${tr('Dữ liệu')} · `;
  sourceProvider.textContent = providerName;
  sourceBtn.setAttribute('aria-label', `${tr('Cấu hình nguồn giá')}: ${providerName}`);
  sourceState.textContent = activeProvider === 'demo'
    ? tr('mô phỏng')
    : activeProvider === 'dnse'
      ? dnseStateLabel()
      : fiinState;
  sourceBtn.classList.toggle(
    'active',
    (activeProvider === 'fiinquant' && fiinQuantConnectionState === 'connected')
      || (activeProvider === 'dnse' && dnseRealtimeState === 'connected'),
  );
  sourceBtn.classList.toggle(
    'error',
    (activeProvider === 'fiinquant' && (fiinQuantConnectionState === 'offline' || fiinQuantConnectionState === 'signed-out'))
      || (activeProvider === 'dnse' && dnseRealtimeState === 'error'),
  );
  sourceBtn.classList.toggle('demo', activeProvider === 'demo');
  const activeSummary = providerConnectionSummary(activeProvider);
  sourceBtn.title = `${tr('Nguồn đang dùng')}: ${providerName} · ${tr('Dịch vụ')}: ${activeSummary.service} · Realtime: ${activeSummary.realtime}`;
  renderProviderConnectionSummary();
}

function refreshProviderUi(): void {
  renderProviderSourceState();
  delete providerStatus.dataset.tone;
  if (activeProvider === 'demo') {
    providerStatus.textContent = tr('Đang dùng dữ liệu mô phỏng. Không cần tài khoản hay API credential.');
  } else if (activeProvider === 'dnse') {
    renderDnseProviderStatus();
  } else {
    void reportFiinQuantHealth();
  }
}

function fillProviderFields(): void {
  dnseApiKeyInput.value = '';
  dnseApiSecretInput.value = '';
  dnseRestBaseInput.value = dnseCredentials?.restBase ?? dnseSettings.restBase ?? DNSE_REST_PROXY;
  dnseWsBaseInput.value = dnseCredentials?.wsBase ?? dnseSettings.wsBase ?? dnseWsProxyBase();
  fiinQuantTokenInput.value = '';
  fiinQuantBaseInput.value = resolveFiinQuantBase(fiinQuantSettings.baseUrl);
  renderProviderCredentialModes();
}

function setProviderPanel(provider: PriceProviderId): void {
  selectedProviderPanel = provider;
  delete providerStatus.dataset.tone;
  providerOverlay.querySelectorAll<HTMLButtonElement>('[data-provider-tab]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.providerTab === provider);
  });
  providerOverlay.querySelectorAll<HTMLElement>('[data-provider-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.providerPanel !== provider;
  });
  if (provider === 'demo') {
    providerStatus.textContent = tr('Đang dùng dữ liệu mô phỏng. Không cần tài khoản hay API credential.');
  } else if (provider === 'dnse') {
    renderDnseProviderStatus();
  } else {
    void reportFiinQuantHealth();
  }
  renderProviderConnectionSummary();
}

function openProviderDialog(provider: PriceProviderId = activeProvider): void {
  fillProviderFields();
  refreshProviderUi();
  setProviderPanel(provider);
  providerOverlay.hidden = false;
}

function closeProviderDialog(): void {
  providerOverlay.hidden = true;
}

function focusProviderField(provider: PriceProviderId): void {
  window.setTimeout(() => {
    if (provider === 'dnse') {
      if (dnseCredentialMode === 'server') dnseSaveButton.focus();
      else ((dnseApiKeyInput.value.trim() || dnseCredentials?.apiKey) ? dnseApiSecretInput : dnseApiKeyInput).focus();
    } else if (provider === 'fiinquant') {
      if (fiinQuantCredentialMode === 'server') {
        (fiinQuantSessionToken ? fiinQuantUseButton : fiinQuantTokenInput).focus();
      } else {
        (fiinQuantUsernameInput.value.trim() ? fiinQuantPasswordInput : fiinQuantUsernameInput).focus();
      }
    }
  }, 0);
}

function looksLikeDnseApiKey(value: string): boolean {
  try {
    const payload = JSON.parse(atob(value.trim())) as unknown;
    if (!payload || typeof payload !== 'object') return false;
    const record = payload as Record<string, unknown>;
    return record.org === 'dnse' && typeof record.id === 'string' && typeof record.h === 'string';
  } catch {
    return false;
  }
}

async function activateProviderFromSwitcher(provider: PriceProviderId): Promise<void> {
  setProviderPanel(provider);
  if (provider === 'demo') {
    setActiveProvider('demo');
    return;
  }
  if (provider === 'dnse') {
    if (dnseFeed) {
      setActiveProvider('dnse');
    } else {
      providerStatus.dataset.tone = 'error';
      renderDnseProviderStatus();
      focusProviderField('dnse');
    }
    return;
  }
  if (fiinQuantCredentialMode === 'session') {
    await loginFiinQuant();
  } else {
    await useConfiguredFiinQuantSession();
  }
  if (fiinQuantConnectionState !== 'connected') {
    focusProviderField('fiinquant');
  }
}

function saveDnseCredentials(): void {
  const useProxyCredentials = dnseCredentialMode === 'server';
  const previousSessionCredentials = dnseCredentials && !dnseCredentials.useProxyCredentials
    ? dnseCredentials
    : null;
  const apiKey = useProxyCredentials
    ? ''
    : dnseApiKeyInput.value.trim() || previousSessionCredentials?.apiKey || '';
  const apiSecret = useProxyCredentials
    ? ''
    : dnseApiSecretInput.value.trim() || previousSessionCredentials?.apiSecret || '';
  if (
    !useProxyCredentials
    && apiKey
    && apiSecret
    && !looksLikeDnseApiKey(apiKey)
    && looksLikeDnseApiKey(apiSecret)
  ) {
    providerStatus.dataset.tone = 'error';
    providerStatus.textContent = tr('API Key và API Secret DNSE đang bị nhập ngược. Chuỗi bắt đầu bằng eyJ... phải nằm ở ô API Key.');
    dnseApiKeyInput.focus();
    return;
  }
  const next: DnseCredentials = {
    apiKey,
    apiSecret,
    restBase: dnseRestBaseInput.value.trim() || undefined,
    wsBase: dnseWsBaseInput.value.trim() || undefined,
    marketType: dnseCredentials?.marketType,
    useProxyCredentials,
  };
  const normalized = normalizeDnseCredentials(next);
  dnseCredentials = normalized;
  if (DNSEDatafeed.hasCredentials(normalized)) {
    const storedSettings = sanitizeStoredDnseSettings({
      ...normalized,
      credentialMode: dnseCredentialMode,
    });
    Object.assign(dnseSettings, storedSettings);
    writeStoredJson(DNSE_STORAGE_KEY, storedSettings);
    dnseApiKeyInput.value = '';
    dnseApiSecretInput.value = '';
    dnseFeed?.dispose();
    dnseFeed = new DNSEDatafeed(normalized);
    bindDnseRealtimeStatus();
    setActiveProvider('dnse');
    providerStatus.textContent = normalized.useProxyCredentials
      ? tr('Đang dùng DNSE qua dev proxy. API Secret không đi qua browser.')
      : tr('Đã dùng DNSE cho phiên này. API Secret chỉ được giữ trong bộ nhớ.');
  } else {
    providerStatus.textContent = tr('Thiếu API Key hoặc API Secret DNSE.');
  }
  refreshProviderUi();
}

function disconnectDnse(): void {
  localStorage.removeItem(DNSE_STORAGE_KEY);
  dnseCredentials = null;
  dnseFeed?.dispose();
  dnseFeed = null;
  bindDnseRealtimeStatus();
  setActiveProvider('demo');
}

function saveFiinQuantConnectionSettings(): void {
  const nextSettings = {
    baseUrl: fiinQuantCredentialMode === 'server'
      ? FIINQUANT_DEFAULT_BASE
      : resolveFiinQuantBase(fiinQuantBaseInput.value),
    credentialMode: fiinQuantCredentialMode,
  };
  const nextToken = fiinQuantCredentialMode === 'server'
    ? ''
    : fiinQuantTokenInput.value.trim() || fiinQuantSessionToken;
  const changed = nextToken !== fiinQuantSessionToken
    || nextSettings.baseUrl !== fiinQuantSettings.baseUrl;
  fiinQuantSessionToken = nextToken;
  fiinQuantSettings = nextSettings;
  writeStoredJson(FIINQUANT_STORAGE_KEY, fiinQuantSettings);
  fiinQuantTokenInput.value = '';
  if (!changed) return;
  fiinQuantHealthSnapshot = null;
  fiinQuantHealthRequest += 1;
  fiinQuantFeed.dispose();
  fiinQuantFeed = makeFiinQuantFeed();
}

function showFiinQuantAuthorizationError(message: string, focusToken: boolean): void {
  fiinQuantConnectionState = 'signed-out';
  renderProviderSourceState();
  providerStatus.dataset.tone = 'error';
  providerStatus.textContent = message;
  if (!focusToken || fiinQuantCredentialMode !== 'session') return;
  fiinQuantAdvanced.open = true;
  window.setTimeout(() => fiinQuantTokenInput.focus(), 0);
}

async function getAuthorizedFiinQuantHealth(): Promise<FiinQuantHealth | null> {
  fiinQuantHealthRequest += 1;
  try {
    const health = await fiinQuantFeed.health();
    fiinQuantHealthSnapshot = health;
    if (health.tokenConfigured === false) {
      showFiinQuantAuthorizationError(
        tr('Sidecar thiếu SIDECAR_TOKEN. Tạo token trong .env rồi nhập token đó ở Cài đặt nâng cao.'),
        false,
      );
      return null;
    }
    if (health.authorized === false) {
      showFiinQuantAuthorizationError(fiinQuantAuthorizationMessage(), true);
      return null;
    }
    return health;
  } catch {
    fiinQuantHealthSnapshot = null;
    fiinQuantConnectionState = 'offline';
    renderProviderSourceState();
    providerStatus.dataset.tone = 'error';
    providerStatus.textContent = tr('Không gọi được sidecar. Hãy khởi động sidecar trong examples/sidecars/fiinquant rồi thử lại.');
    return null;
  }
}

async function testFiinQuantConnection(): Promise<void> {
  const username = fiinQuantUsernameInput.value.trim();
  const password = fiinQuantPasswordInput.value;
  if (!username || !password) {
    providerStatus.dataset.tone = 'error';
    providerStatus.textContent = tr('Vui lòng nhập tên đăng nhập và mật khẩu FiinQuant.');
    return;
  }
  saveFiinQuantConnectionSettings();
  delete providerStatus.dataset.tone;
  providerStatus.textContent = tr('Đang kiểm tra kết nối FiinQuant...');
  if (!await getAuthorizedFiinQuantHealth()) return;
  try {
    await fiinQuantFeed.login(username, password);
    fiinQuantConnectionState = 'connected';
    renderProviderSourceState();
    fiinQuantPasswordInput.value = '';
    if (activeProvider === 'fiinquant') reloadAllTiles();
    providerStatus.dataset.tone = 'success';
    providerStatus.textContent = tr('Kết nối FiinQuant thành công. Phiên đã sẵn sàng để sử dụng.');
  } catch (error) {
    providerStatus.dataset.tone = 'error';
    providerStatus.textContent = `${tr('Không thể đăng nhập FiinQuant')}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function loginFiinQuant(): Promise<void> {
  const username = fiinQuantUsernameInput.value.trim();
  const password = fiinQuantPasswordInput.value;
  saveFiinQuantConnectionSettings();
  delete providerStatus.dataset.tone;
  providerStatus.textContent = tr('Đang kiểm tra kết nối FiinQuant...');
  const health = await getAuthorizedFiinQuantHealth();
  if (!health) return;
  if (!username || !password) {
    if (health.loggedIn) {
      fiinQuantConnectionState = 'connected';
      setActiveProvider('fiinquant');
      providerStatus.dataset.tone = 'success';
      providerStatus.textContent = tr('Đăng nhập FiinQuant thành công. Chart đang tải dữ liệu.');
      return;
    }
    providerStatus.dataset.tone = 'error';
    providerStatus.textContent = tr('Vui lòng nhập tên đăng nhập và mật khẩu FiinQuant.');
    return;
  }
  providerStatus.textContent = tr('Đang đăng nhập FiinQuant...');
  try {
    await fiinQuantFeed.login(username, password);
    fiinQuantConnectionState = 'connected';
    fiinQuantPasswordInput.value = '';
    setActiveProvider('fiinquant');
    providerStatus.dataset.tone = 'success';
    providerStatus.textContent = tr('Đăng nhập FiinQuant thành công. Chart đang tải dữ liệu.');
  } catch (error) {
    providerStatus.dataset.tone = 'error';
    providerStatus.textContent = `${tr('Không thể đăng nhập FiinQuant')}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function useConfiguredFiinQuantSession(): Promise<void> {
  saveFiinQuantConnectionSettings();
  const health = await getAuthorizedFiinQuantHealth();
  if (!health) return;
  if (!health.loggedIn) {
    fiinQuantConnectionState = 'signed-out';
    renderProviderSourceState();
    providerStatus.textContent = tr('Không thể dùng phiên sidecar vì chưa đăng nhập FiinQuant.');
    return;
  }
  fiinQuantConnectionState = 'connected';
  setActiveProvider('fiinquant');
}

sourceBtn.addEventListener('click', () => openProviderDialog());
document.getElementById('provider-close')!.addEventListener('click', closeProviderDialog);
document.getElementById('provider-done')!.addEventListener('click', closeProviderDialog);
document.getElementById('dnse-credential-form')!.addEventListener('submit', (event) => {
  event.preventDefault();
  saveDnseCredentials();
});
document.getElementById('dnse-disconnect')!.addEventListener('click', disconnectDnse);
fiinQuantTestButton.addEventListener('click', () => void testFiinQuantConnection());
document.getElementById('fiinquant-credential-form')!.addEventListener('submit', (event) => {
  event.preventDefault();
  void loginFiinQuant();
});
providerOverlay.addEventListener('pointerdown', (e) => {
  if (e.target === providerOverlay) closeProviderDialog();
});
providerOverlay.querySelectorAll<HTMLButtonElement>('[data-provider-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const provider = btn.dataset.providerTab === 'fiinquant'
      ? 'fiinquant'
      : btn.dataset.providerTab === 'dnse'
        ? 'dnse'
        : 'demo';
    setProviderPanel(provider);
  });
});
document.getElementById('demo-use')!.addEventListener('click', () => setActiveProvider('demo'));
fiinQuantUseButton.addEventListener('click', () => {
  void useConfiguredFiinQuantSession();
});
providerOverlay.querySelectorAll<HTMLButtonElement>('[data-credential-provider]').forEach((button) => {
  button.addEventListener('click', () => {
    const provider = button.dataset.credentialProvider === 'fiinquant' ? 'fiinquant' : 'dnse';
    const mode = button.dataset.credentialMode === 'server' ? 'server' : 'session';
    setProviderCredentialMode(provider, mode);
  });
});

const paramOverlay = document.getElementById('param-overlay')!;
const paramTitle = document.getElementById('param-title')!;
const paramFields = document.getElementById('param-fields')!;
let paramDefId: string | null = null;
let paramDialogMode: 'indicator' | 'candles' = 'indicator';

const CANDLE_COLOR_FIELDS: { key: keyof CandleColors; label: string }[] = [
  { key: 'up', label: 'Thân tăng' },
  { key: 'down', label: 'Thân giảm' },
  { key: 'wickUp', label: 'Râu tăng' },
  { key: 'wickDown', label: 'Râu giảm' },
  { key: 'line', label: 'Đường Line' },
  { key: 'area', label: 'Đường và vùng Area' },
];

function fillCandleStyleFields(colors: CandleColors): void {
  paramFields.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'param-section-title';
  title.innerHTML = '<strong>Màu biểu đồ giá</strong><span>Lưu riêng cho mã chứng khoán đang chọn</span>';
  const grid = document.createElement('div');
  grid.className = 'param-colors candle-color-grid';
  for (const field of CANDLE_COLOR_FIELDS) {
    const label = document.createElement('label');
    const name = document.createElement('span');
    name.textContent = field.label;
    const input = document.createElement('input');
    input.type = 'color';
    input.value = colors[field.key];
    input.dataset.candleColor = field.key;
    label.append(name, input);
    grid.appendChild(label);
  }
  paramFields.append(title, grid);
}

function collectCandleColors(): CandleColors {
  const colors = defaultCandleColors();
  for (const input of paramFields.querySelectorAll<HTMLInputElement>('[data-candle-color]')) {
    const key = input.dataset.candleColor as keyof CandleColors | undefined;
    if (key) colors[key] = input.value;
  }
  return colors;
}

function fillParamFields(def: IndicatorDef, values: Params): void {
  paramFields.innerHTML = '';
  const mergedValues = { ...defaultParams(def), ...indicatorStyleDefaults(def.id), ...values };
  const inputTitle = document.createElement('div');
  inputTitle.className = 'param-section-title';
  inputTitle.innerHTML = '<strong>Thông số tính toán</strong><span>Thay đổi cách chỉ báo được tính</span>';
  paramFields.appendChild(inputTitle);
  for (const p of def.params ?? []) {
    const row = document.createElement('label');
    row.className = 'param-row';
    const name = document.createElement('span');
    name.textContent = p.label;
    let input: HTMLInputElement | HTMLSelectElement;
    if (p.type === 'select') {
      input = document.createElement('select');
      for (const opt of p.options ?? []) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        input.appendChild(o);
      }
      input.value = String(mergedValues[p.key]);
    } else {
      input = document.createElement('input');
      input.type = 'number';
      if (p.min !== undefined) input.min = String(p.min);
      if (p.max !== undefined) input.max = String(p.max);
      input.step = String(p.step ?? (p.type === 'int' ? 1 : 0.1));
      input.value = String(mergedValues[p.key]);
    }
    input.dataset.key = p.key;
    row.append(name, input);
    paramFields.appendChild(row);
  }
  if (!def.params?.length) {
    const empty = document.createElement('div');
    empty.className = 'param-empty';
    empty.textContent = 'Chỉ báo này không có tham số tính toán riêng.';
    paramFields.appendChild(empty);
  }

  const styleTitle = document.createElement('div');
  styleTitle.className = 'param-section-title param-style-title';
  styleTitle.innerHTML = '<strong>Hiển thị</strong><span>Áp dụng cho các series của chỉ báo</span>';
  paramFields.appendChild(styleTitle);

  const appendStyleSelect = (label: string, key: string, options: [string, string][]) => {
    const row = document.createElement('label');
    row.className = 'param-row';
    const name = document.createElement('span');
    name.textContent = label;
    const select = document.createElement('select');
    select.dataset.styleKey = key;
    for (const [value, optionLabel] of options) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = optionLabel;
      select.appendChild(option);
    }
    select.value = String(mergedValues[key]);
    row.append(name, select);
    paramFields.appendChild(row);
  };
  appendStyleSelect('Kiểu hiển thị', INDICATOR_STYLE_KEYS.display, [['line', 'Đường'], ['area', 'Vùng (Area)']]);
  appendStyleSelect('Kiểu nét', INDICATOR_STYLE_KEYS.lineStyle, [['solid', 'Liền'], ['dashed', 'Gạch'], ['dotted', 'Chấm']]);

  const widthRow = document.createElement('label');
  widthRow.className = 'param-row';
  const widthName = document.createElement('span');
  widthName.textContent = 'Độ dày';
  const widthInput = document.createElement('input');
  widthInput.type = 'number';
  widthInput.min = '0.5';
  widthInput.max = '5';
  widthInput.step = '0.5';
  widthInput.value = String(mergedValues[INDICATOR_STYLE_KEYS.lineWidth]);
  widthInput.dataset.styleKey = INDICATOR_STYLE_KEYS.lineWidth;
  widthRow.append(widthName, widthInput);
  paramFields.appendChild(widthRow);

  const opacityRow = document.createElement('label');
  opacityRow.className = 'param-row';
  const opacityName = document.createElement('span');
  opacityName.textContent = 'Độ hiển thị';
  const opacityControl = document.createElement('span');
  opacityControl.className = 'param-opacity-control';
  const opacityInput = document.createElement('input');
  opacityInput.type = 'range';
  opacityInput.min = '0';
  opacityInput.max = '100';
  opacityInput.step = '1';
  opacityInput.value = String(mergedValues[INDICATOR_STYLE_KEYS.opacity]);
  opacityInput.dataset.styleKey = INDICATOR_STYLE_KEYS.opacity;
  opacityInput.setAttribute('aria-label', 'Độ hiển thị');
  const opacityValue = document.createElement('output');
  opacityValue.textContent = `${opacityInput.value}%`;
  opacityInput.addEventListener('input', () => {
    opacityValue.textContent = `${opacityInput.value}%`;
  });
  opacityControl.append(opacityInput, opacityValue);
  opacityRow.append(opacityName, opacityControl);
  paramFields.appendChild(opacityRow);

  const colors = document.createElement('div');
  colors.className = 'param-colors';
  const palette = [INDICATOR_STYLE_KEYS.color1, INDICATOR_STYLE_KEYS.color2, INDICATOR_STYLE_KEYS.color3];
  palette.forEach((key, index) => {
    const label = document.createElement('label');
    label.innerHTML = `<span>Màu ${index + 1}</span>`;
    const input = document.createElement('input');
    input.type = 'color';
    input.value = String(mergedValues[key]);
    input.dataset.styleKey = key;
    label.appendChild(input);
    colors.appendChild(label);
  });
  paramFields.appendChild(colors);
}

function collectParams(def: IndicatorDef): Params {
  const out: Params = {};
  for (const el of paramFields.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')) {
    const p = def.params?.find((d) => d.key === el.dataset.key);
    if (!p) continue;
    if (p.type === 'select') {
      out[p.key] = el.value;
    } else {
      let v = Number(el.value);
      if (!isFinite(v)) v = Number(p.default);
      if (p.min !== undefined) v = Math.max(p.min, v);
      if (p.max !== undefined) v = Math.min(p.max, v);
      out[p.key] = p.type === 'int' ? Math.round(v) : v;
    }
  }
  for (const el of paramFields.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-style-key]')) {
    const key = el.dataset.styleKey;
    if (!key) continue;
    out[key] = key === INDICATOR_STYLE_KEYS.lineWidth || key === INDICATOR_STYLE_KEYS.opacity
      ? Number(el.value)
      : el.value;
  }
  return out;
}

function openParamDialog(id: string): void {
  const def = getIndicator(id);
  if (!def || !activeTile) return;
  paramDialogMode = 'indicator';
  paramDefId = id;
  paramTitle.textContent = def.name;
  fillParamFields(def, activeTile.getParams(id));
  indicatorOverlay.hidden = true;
  paramOverlay.hidden = false;
}

function openCandleStyleDialog(): void {
  if (!activeTile) return;
  paramDialogMode = 'candles';
  paramDefId = null;
  paramTitle.textContent = 'Màu biểu đồ';
  fillCandleStyleFields(activeTile.getCandleColors());
  paramOverlay.hidden = false;
}

function closeParamDialog(): void {
  paramDefId = null;
  paramDialogMode = 'indicator';
  paramOverlay.hidden = true;
}

function applyParamDialog(): void {
  if (paramDialogMode === 'candles' && activeTile) {
    activeTile.setCandleColors(collectCandleColors());
    closeParamDialog();
    return;
  }
  const def = paramDefId ? getIndicator(paramDefId) : null;
  if (def && activeTile) {
    activeTile.setIndicatorParams(def.id, collectParams(def));
    refreshToolbar();
  }
  closeParamDialog();
}

document.getElementById('param-ok')!.addEventListener('click', applyParamDialog);
document.getElementById('param-cancel')!.addEventListener('click', closeParamDialog);
document.getElementById('param-close')!.addEventListener('click', closeParamDialog);
document.getElementById('param-reset')!.addEventListener('click', () => {
  if (paramDialogMode === 'candles') {
    fillCandleStyleFields(defaultCandleColors());
    return;
  }
  const def = paramDefId ? getIndicator(paramDefId) : null;
  if (def) fillParamFields(def, { ...defaultParams(def), ...indicatorStyleDefaults(def.id) });
});
paramOverlay.addEventListener('pointerdown', (e) => {
  if (e.target === paramOverlay) closeParamDialog();
});
paramOverlay.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') applyParamDialog();
});

function openIndicatorLibrary(): void {
  indicatorFilter = 'all';
  indicatorSearchInput.value = '';
  selectedIndicatorId = activeTile?.active.keys().next().value ?? indicatorCatalog[0]?.id ?? '';
  document.querySelectorAll<HTMLElement>('[data-indicator-filter]').forEach((item) => {
    item.classList.toggle('active', item.dataset.indicatorFilter === 'all');
  });
  indicatorOverlay.hidden = false;
  refreshIndicatorLibrary();
  window.setTimeout(() => indicatorSearchInput.focus(), 0);
}

function closeIndicatorLibrary(): void {
  indicatorOverlay.hidden = true;
}

indBtn.addEventListener('click', openIndicatorLibrary);
document.getElementById('indicator-library-close')!.addEventListener('click', closeIndicatorLibrary);
indicatorOverlay.addEventListener('pointerdown', (event) => {
  if (event.target === indicatorOverlay) closeIndicatorLibrary();
});
indicatorOverlay.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeIndicatorLibrary();
});
document.addEventListener('pointerdown', (e) => {
  if (!chartTypeMenu.hidden && !(e.target as HTMLElement).closest('#chart-type-wrap')) {
    chartTypeMenu.hidden = true;
    chartTypeButton.setAttribute('aria-expanded', 'false');
  }
  if (!templateMenu.hidden && !(e.target as HTMLElement).closest('#template-wrap')) {
    templateMenu.hidden = true;
  }
  if (!(e.target as HTMLElement).closest('.interval-picker, .drawing-tool-group')) {
    closeTilePopovers();
  }
});

const syncBtn = document.getElementById('sync-toggle') as HTMLButtonElement;
syncBtn.onclick = () => {
  syncEnabled = !syncEnabled;
  syncBtn.classList.toggle('active', syncEnabled);
  if (!syncEnabled) {
    for (const t of tiles) t.chart.setExternalCrosshair(null);
  }
};

const themeBtn = document.getElementById('theme-toggle') as HTMLButtonElement;
const MOON_ICON = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
const SUN_ICON = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/></svg>';
themeBtn.onclick = () => {
  dark = !dark;
  document.body.classList.toggle('light', !dark);
  themeBtn.innerHTML = dark ? MOON_ICON : SUN_ICON;
  const themeLabel = dark ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối';
  themeBtn.title = themeLabel;
  themeBtn.setAttribute('aria-label', themeLabel);
  for (const t of tiles) t.applyTheme();
};

document.querySelectorAll<HTMLButtonElement>('[data-locale]').forEach((button) => {
  const buttonLocale = button.dataset.locale === 'vi' ? 'vi' : 'en';
  button.classList.toggle('active', buttonLocale === getLocale());
  button.setAttribute('aria-pressed', String(buttonLocale === getLocale()));
  button.addEventListener('click', () => setLocale(buttonLocale));
});

type Command =
  | { type: 'interval'; value: string }
  | { type: 'symbol'; value: string }
  | null;

function normalizeCommandText(raw: string): string {
  return raw
    .replace(/[ưừứửữự]/gi, 'W')
    .replace(/[ơờớởỡợôồốổỗộ]/gi, 'O')
    .replace(/[ăằắẳẵặâầấẩẫậ]/gi, 'A')
    .replace(/[êềếểễệ]/gi, 'E')
    .replace(/đ/gi, 'D')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase();
}

function parseCommand(raw: string): Command {
  const s = normalizeCommandText(raw.trim());
  if (!s) return null;
  const digits = /^(\d+)$/.exec(s);
  if (digits) {
    const minuteMap: Record<string, string> = {
      '1': '1m',
      '4': '4h',
      '5': '5m',
      '15': '15m',
      '60': '1h',
    };
    const iv = minuteMap[digits[1]];
    return iv ? { type: 'interval', value: iv } : null;
  }
  const unit = /^(\d+)([MHDW])$/.exec(s);
  if (unit) {
    const iv = unit[1] + unit[2].toLowerCase();
    return INTERVAL_SECONDS[iv] && INTERVALS.includes(iv) ? { type: 'interval', value: iv } : null;
  }
  return { type: 'symbol', value: s };
}

const cmdOverlay = document.getElementById('cmd-overlay')!;
const cmdText = document.getElementById('cmd-text') as HTMLInputElement;
const cmdAction = document.getElementById('cmd-action')!;
const cmdActionLabel = document.getElementById('cmd-action-label')!;
const cmdActionValue = document.getElementById('cmd-action-value')!;
const cmdSuggestions = document.getElementById('cmd-suggestions')!;
let cmdBuffer = '';
let cmdSuggestionItems: SymbolSearchResult[] = [];
let cmdSuggestionIndex = -1;
let cmdSuggestionRequest = 0;
let cmdSuggestionTimer: number | null = null;
let cmdComposing = false;

function renderCmdSuggestions(items: SymbolSearchResult[]): void {
  cmdSuggestionItems = items;
  cmdSuggestionIndex = -1;
  cmdSuggestions.replaceChildren();
  for (const [index, item] of items.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cmd-suggestion';
    button.setAttribute('role', 'option');
    const symbol = document.createElement('strong');
    symbol.textContent = item.symbol;
    const name = document.createElement('span');
    name.textContent = item.name || 'Vietnam security';
    const exchange = document.createElement('small');
    exchange.textContent = item.exchange || '';
    button.append(symbol, name, exchange);
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      cmdBuffer = item.symbol;
      commitCmd();
    });
    button.dataset.index = String(index);
    cmdSuggestions.appendChild(button);
  }
  cmdSuggestions.hidden = items.length === 0;
}

function highlightCmdSuggestion(index: number): void {
  const buttons = [...cmdSuggestions.querySelectorAll<HTMLButtonElement>('.cmd-suggestion')];
  if (buttons.length === 0) return;
  cmdSuggestionIndex = (index + buttons.length) % buttons.length;
  buttons.forEach((button, buttonIndex) => button.classList.toggle('active', buttonIndex === cmdSuggestionIndex));
  buttons[cmdSuggestionIndex].scrollIntoView({ block: 'nearest' });
}

function refreshCmdSuggestions(): void {
  const command = parseCommand(cmdBuffer);
  const request = ++cmdSuggestionRequest;
  if (!command || command.type !== 'symbol') {
    renderCmdSuggestions([]);
    return;
  }
  const extras = [...DEFAULT_SYMBOLS, ...(tradingWorkspace?.getWatchlist() ?? []), ...tiles.map((tile) => tile.symbol)];
  const localItems = searchInstruments(command.value, extras, 100)
    .filter((item) => item.symbol.includes(command.value))
    .slice(0, 20);
  renderCmdSuggestions(localItems);
  if (cmdSuggestionTimer !== null) window.clearTimeout(cmdSuggestionTimer);
  const feed = currentFeed().feed;
  if (!feed?.searchSymbols) return;
  cmdSuggestionTimer = window.setTimeout(() => {
    cmdSuggestionTimer = null;
    void feed.searchSymbols!(command.value, 100).then((remoteItems) => {
      if (request !== cmdSuggestionRequest || cmdOverlay.hidden) return;
      const merged = new Map<string, SymbolSearchResult>();
      for (const item of [...localItems, ...remoteItems]) {
        if (!merged.has(item.symbol)) merged.set(item.symbol, item);
      }
      renderCmdSuggestions([...merged.values()].slice(0, 100));
    }).catch(() => undefined);
  }, 120);
}

function renderCmd(): void {
  if (cmdText.value !== cmdBuffer) cmdText.value = cmdBuffer;
  const cmd = parseCommand(cmdBuffer);
  cmdAction.classList.toggle('invalid', cmd === null);
  cmdActionLabel.textContent =
    cmd === null ? 'Không nhận dạng được' : cmd.type === 'interval' ? 'Khung thời gian mới' : 'Mã chứng khoán mới';
  cmdActionValue.textContent = cmd === null
    ? 'Thử VNM, 15 hoặc 1D'
    : cmd.type === 'interval' ? intervalLabel(cmd.value) : cmd.value.toUpperCase();
  refreshCmdSuggestions();
}

function openCmd(initial: string): void {
  cmdBuffer = normalizeCommandText(initial);
  cmdOverlay.hidden = false;
  renderCmd();
  cmdText.focus({ preventScroll: true });
  cmdText.setSelectionRange(cmdText.value.length, cmdText.value.length);
}

function closeCmd(): void {
  cmdComposing = false;
  cmdBuffer = '';
  cmdText.blur();
  cmdSuggestionRequest += 1;
  if (cmdSuggestionTimer !== null) window.clearTimeout(cmdSuggestionTimer);
  cmdSuggestionTimer = null;
  renderCmdSuggestions([]);
  cmdOverlay.hidden = true;
}

function syncCmdFromInput(): void {
  cmdBuffer = normalizeCommandText(cmdText.value);
  if (!cmdBuffer) {
    closeCmd();
    return;
  }
  renderCmd();
  cmdText.setSelectionRange(cmdText.value.length, cmdText.value.length);
}

cmdText.addEventListener('compositionstart', () => {
  cmdComposing = true;
});

cmdText.addEventListener('compositionend', () => {
  cmdComposing = false;
  syncCmdFromInput();
});

cmdText.addEventListener('input', () => {
  if (cmdComposing) return;
  syncCmdFromInput();
});

cmdText.addEventListener('keydown', (event) => {
  event.stopPropagation();
  if (event.isComposing || cmdComposing) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    if (cmdSuggestionIndex >= 0) cmdBuffer = cmdSuggestionItems[cmdSuggestionIndex].symbol;
    commitCmd();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    highlightCmdSuggestion(cmdSuggestionIndex + (event.key === 'ArrowDown' ? 1 : -1));
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeCmd();
  }
});

function commitCmd(): void {
  const cmd = parseCommand(cmdBuffer);
  closeCmd();
  if (!cmd || !activeTile) return;
  if (cmd.type === 'interval') activeTile.setIntervalCode(cmd.value);
  else activeTile.setSymbol(cmd.value);
}

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement | null;
  const tag = target?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (!providerOverlay.hidden) {
    if (e.key === 'Escape') closeProviderDialog();
    return;
  }

  // Keep global commands inactive while the settings dialog is open.
  if (!paramOverlay.hidden) {
    if (e.key === 'Escape') closeParamDialog();
    return;
  }

  const drawingTile = activeTile;
  if (e.key === 'Escape' && drawingTile && drawingTile.chart.getDrawingTool() !== 'cursor') {
    e.preventDefault();
    drawingTile.selectDrawingTool('cursor');
    hideDrawingEscapeHint();
    return;
  }

  if (e.shiftKey && activeTile) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeTile.toggleReplayPlayback();
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      activeTile.stepReplay();
      return;
    }
  }

  if (cmdOverlay.hidden) {
    const commandText = e.key.length === 1 ? normalizeCommandText(e.key) : '';
    if (commandText) {
      e.preventDefault();
      openCmd(commandText);
    }
    return;
  }
  // Once opened, the focused command input owns typing and IME composition.
});

cmdOverlay.addEventListener('pointerdown', (e) => {
  if (e.target === cmdOverlay) closeCmd();
});

attachSymbolAutocomplete(document.getElementById('watchlist-symbol') as HTMLInputElement, {
  extraSymbols: () => tradingWorkspace?.getWatchlist() ?? DEFAULT_SYMBOLS,
  onSelect: () => document.getElementById('watchlist-add')!.click(),
});

bindDnseRealtimeStatus();
refreshProviderUi();
window.setInterval(pollFiinQuantHealth, FIINQUANT_HEALTH_POLL_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    pollFiinQuantHealth();
    for (const tile of tiles) void tile.recoverRealtimeGap();
  }
});
window.addEventListener('online', () => {
  for (const tile of tiles) void tile.recoverRealtimeGap();
});
const initialMobileViewport = window.matchMedia('(max-width: 760px)').matches;
setWatchlistVisible(initialMobileViewport ? false : uiPreferences.watchlistVisible, false);
setRightPanelVisible(initialMobileViewport ? false : uiPreferences.rightPanelVisible, false);
const defaultTemplate = readDefaultTemplate();
if (defaultTemplate) applyWorkspaceTemplate(defaultTemplate);
else setLayout('1');
tradingWorkspace = new TradingWorkspace({
  market: marketHub,
  engine: paperEngine,
  getActiveSymbol: () => activeTile?.symbol ?? '',
  selectSymbol: (symbol) => activeTile?.setSymbol(symbol),
  drawings: {
    list: () => ({
      drawings: activeTile?.chart.getDrawings() ?? [],
      selectedId: activeTile?.chart.getSelectedDrawingId() ?? null,
    }),
    select: (id) => {
      activeTile?.chart.selectDrawing(id);
      tradingWorkspace?.refreshObjects();
    },
    update: (id, patch) => {
      activeTile?.chart.updateDrawingObject(id, patch);
      tradingWorkspace?.refreshObjects();
    },
    remove: (id) => {
      activeTile?.chart.deleteDrawing(id);
      tradingWorkspace?.refreshObjects();
    },
  },
  onWatchlistChange: (_symbols, addedSymbol) => syncWatchlistFeeds(addedSymbol ? [addedSymbol] : []),
});
tradingWorkspace.setSourceLabel(currentFeed().label);
syncWatchlistFeeds();
setupToolbarOverflow();
