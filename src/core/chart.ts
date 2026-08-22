import { type Candle, type Theme, darkTheme } from './types';
import { heikinAshi, heikinAshiCandle } from './heikin-ashi';
import { tr } from './i18n';
import { ChevronDown, ChevronUp, createElement as createLucideElement, Eye, EyeOff, Settings2, Trash2, X } from 'lucide';
import { TimeScale } from './time-scale';
import { Pane } from './pane';
import type { PriceScaleMode } from './price-scale';
import {
  BandSeries,
  CandleSeries,
  HistogramSeries,
  LineSeries,
  Series,
  VisibleRangeExtremaSeries,
  ZoneSeries,
  type BandSeriesOptions,
  type HistogramSeriesOptions,
  type LineSeriesOptions,
  type PriceSeriesMode,
  type RenderContext,
  type VisibleRangeExtremaSeriesOptions,
} from './series';
import {
  clamp,
  formatCompact,
  formatDuration,
  formatPrice,
  formatTimeFull,
  formatTimeTick,
  hexToRgba,
  niceBarStep,
} from './utils';
import {
  drawChartDrawing,
  hitTestDrawingHandle,
  hitTestChartDrawing,
  resolvePositionPrices,
  type ChartDrawing,
  type DrawableTool,
  type DrawingAnchor,
  type DrawingHandle,
  type DrawingStyle,
  type DrawingTool,
  type SerializedDrawing,
} from './drawings';

export interface ChartOptions {
  theme?: Partial<Theme>;
  /** Seconds per bar (for time labels). Inferred from data when omitted. */
  intervalSec?: number;
  /** Fixed decimals for prices. Omit to infer precision from the visible scale. */
  pricePrecision?: number;
  priceAxisWidth?: number;
  timeAxisHeight?: number;
}

export interface BarLabel {
  time: number;
  text: string;
  color?: string;
  underlineColor?: string;
}

export interface BarLabelStyle {
  opacity?: number;
  gap?: number;
  fontSize?: number;
}

export interface BarProgressMarker {
  time: number;
  remaining: number;
  color?: string;
}

export interface CrosshairEvent {
  index: number | null;
  candle: Candle | null;
}

export interface VisibleRangeChangeEvent {
  from: number;
  to: number;
  dataLength: number;
}

/** A confirmed click on a bar in the price area. */
export interface BarClickEvent extends CrosshairEvent {}

export interface ChartMarketQuote {
  bid?: number | null;
  ask?: number | null;
  last: number;
  time: number;
}

export interface IndicatorAppearance {
  colors: string[];
  display: 'line' | 'area';
  lineWidth: number;
  lineStyle: 'solid' | 'dashed' | 'dotted';
  opacity: number;
}

type EventName = 'crosshair' | 'data';

interface CrosshairState {
  pane: Pane;
  x: number;
  y: number;
  index: number;
}

/** Shift+drag price/time ruler, anchored to bar indices so it survives pan/zoom. */
interface MeasureState {
  pane: Pane;
  startIndex: number;
  startPrice: number;
  endIndex: number;
  endPrice: number;
  dragging: boolean;
}

interface DrawingDragState {
  pointerId: number;
  drawing: ChartDrawing;
  handle: DrawingHandle;
  moved: boolean;
  pointerStart?: DrawingAnchor;
  originalStart?: DrawingAnchor;
  originalEnd?: DrawingAnchor;
  originalStopPrice?: number;
  originalPoints?: DrawingAnchor[];
}

const FONT = '500 12px Manrope, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const FONT_STRONG = '700 12px Manrope, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const MIN_MAIN_PANE_HEIGHT = 100;
const MIN_INDICATOR_PANE_HEIGHT = 56;
const legendIcon = (icon: Parameters<typeof createLucideElement>[0]): string =>
  createLucideElement(icon, {
    width: 18,
    height: 18,
    stroke: 'currentColor',
    'stroke-width': 1.8,
    'aria-hidden': 'true',
  }).outerHTML;

interface LegendIcons {
  settings: string;
  visible: string;
  hidden: string;
  remove: string;
  collapse: string;
  expand: string;
  trash: string;
}

let cachedLegendIcons: LegendIcons | null = null;

function getLegendIcons(): LegendIcons {
  if (!cachedLegendIcons) {
    cachedLegendIcons = {
      settings: legendIcon(Settings2),
      visible: legendIcon(Eye),
      hidden: legendIcon(EyeOff),
      remove: legendIcon(X),
      collapse: legendIcon(ChevronUp),
      expand: legendIcon(ChevronDown),
      trash: legendIcon(Trash2),
    };
  }
  return cachedLegendIcons;
}

/** Enable canvas text hinting where the browser supports it. */
function crispContext(ctx: CanvasRenderingContext2D): CanvasRenderingContext2D {
  (ctx as CanvasRenderingContext2D & { textRendering?: string }).textRendering =
    'optimizeLegibility';
  return ctx;
}
const FREEHAND_TOOLS: DrawableTool[] = ['brush', 'highlighter', 'path', 'polyline'];

export class L2Chart {
  readonly timeScale = new TimeScale();
  readonly panes: Pane[] = [];
  readonly mainSeries: CandleSeries;
  theme: Theme;

  private candles: Candle[] = [];
  private heikinAshiCandles: Candle[] = [];
  private intervalSec: number;
  private intervalExplicit: boolean;
  private axisW: number;
  private readonly configuredAxisW: number | null;
  private readonly timeAxisH: number;

  private root: HTMLDivElement;
  private panesEl: HTMLDivElement;
  private timeAxisEl: HTMLDivElement;
  private taCanvas: HTMLCanvasElement;
  private taOverlay: HTMLCanvasElement;
  private taCtx: CanvasRenderingContext2D;
  private taOverlayCtx: CanvasRenderingContext2D;
  private priceScaleMenu: HTMLDivElement;
  private priceScaleMenuPane: Pane | null = null;
  private viewMenu: HTMLDivElement;
  private indicatorContext: HTMLDivElement;

  private width = 0;
  private rafId = 0;
  private needMain = false;
  private needOverlay = false;
  private crosshair: CrosshairState | null = null;
  /** Crosshair index driven from outside (multi-chart sync). Own crosshair wins. */
  private externalIndex: number | null = null;
  private measure: MeasureState | null = null;
  private timeTicks: { index: number; label: string; major: boolean }[] = [];
  private watermark = '';
  private legendTitle = '';
  private legendCollapsed = false;
  private marketQuote: ChartMarketQuote | null = null;
  private sessionsVisible = true;
  private barLabels = new Map<number, Omit<BarLabel, 'time'>>();
  private barLabelOpacity = 0.7;
  private barLabelGap = 10;
  private barLabelFontSize = 8;
  private barProgressMarker: BarProgressMarker | null = null;
  private barProgressAnchor: { time: number; bottom: number } | null = null;

  private pointers = new Map<number, { x: number; y: number }>();
  private pointerStarts = new Map<number, { x: number; y: number }>();
  private dragging = false;
  private lastDragX = 0;
  private lastDragY = 0;
  private dragPane: Pane | null = null;
  private lastPinchDist = 0;
  private hasFit = false;
  private axisScaling: { pointerId: number; pane: Pane; lastY: number } | null = null;
  private drawingTool: DrawingTool = 'cursor';
  private drawingText = '';
  private drawings: ChartDrawing[] = [];
  private drawingDraft: ChartDrawing | null = null;
  private drawingPointerId: number | null = null;
  private drawingDrag: DrawingDragState | null = null;
  private selectedDrawingId: number | null = null;
  private nextDrawingId = 1;
  private static readonly drawingStyleDefaults = new Map<DrawableTool, Partial<DrawingStyle>>();
  private readonly drawingUndoStack: SerializedDrawing[][] = [];
  private readonly drawingRedoStack: SerializedDrawing[][] = [];
  private drawingHistoryGroup: string | null = null;
  private drawingHistoryTime = 0;
  private replaySelectionMode = false;
  private indicatorOwner: string | null = null;
  private indicatorAppearance: IndicatorAppearance | null = null;
  private indicatorSeriesIndex = 0;
  private selectedIndicatorId: string | null = null;
  private readonly barClickListeners = new Set<(e: BarClickEvent) => void>();
  private readonly drawingListeners = new Set<(drawings: SerializedDrawing[], selectedId: number | null) => void>();
  private readonly drawingEditListeners = new Set<(id: number) => boolean>();
  private readonly indicatorRemoveListeners = new Set<(id: string) => void>();
  private readonly indicatorSettingsListeners = new Set<(id: string) => void>();
  private readonly visibleRangeListeners = new Set<(e: VisibleRangeChangeEvent) => void>();

  private ro: ResizeObserver;
  private listeners: Record<EventName, Set<(e: CrosshairEvent) => void>> = {
    crosshair: new Set(),
    data: new Set(),
  };
  private detachFns: (() => void)[] = [];

  constructor(container: HTMLElement, options: ChartOptions = {}) {
    this.theme = { ...darkTheme, ...options.theme };
    this.intervalSec = options.intervalSec ?? 60;
    this.intervalExplicit = options.intervalSec !== undefined;
    this.configuredAxisW = options.priceAxisWidth ?? null;
    this.axisW = this.configuredAxisW ?? 92;
    this.timeAxisH = options.timeAxisHeight ?? 28;

    this.root = document.createElement('div');
    Object.assign(this.root.style, {
      position: 'relative',
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      background: this.theme.bg,
      userSelect: 'none',
      touchAction: 'none',
      cursor: 'crosshair',
    } satisfies Partial<CSSStyleDeclaration>);
    container.appendChild(this.root);

    this.panesEl = document.createElement('div');
    Object.assign(this.panesEl.style, {
      flex: '1 1 0%',
      display: 'flex',
      flexDirection: 'column',
      minHeight: '0',
    } satisfies Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.panesEl);

    this.timeAxisEl = document.createElement('div');
    Object.assign(this.timeAxisEl.style, {
      position: 'relative',
      height: `${this.timeAxisH}px`,
      flex: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    this.taCanvas = document.createElement('canvas');
    this.taOverlay = document.createElement('canvas');
    for (const c of [this.taCanvas, this.taOverlay]) {
      Object.assign(c.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
      this.timeAxisEl.appendChild(c);
    }
    this.taCtx = crispContext(this.taCanvas.getContext('2d')!);
    this.taOverlayCtx = crispContext(this.taOverlay.getContext('2d')!);
    this.root.appendChild(this.timeAxisEl);

    this.priceScaleMenu = this.createPriceScaleMenu();
    this.root.appendChild(this.priceScaleMenu);
    this.viewMenu = this.createViewMenu();
    this.root.appendChild(this.viewMenu);
    this.indicatorContext = this.createIndicatorContext();
    this.root.appendChild(this.indicatorContext);

    this.mainSeries = new CandleSeries(() => this.priceSeriesCandles());
    const mainPane = this.createPane(3);
    mainPane.priceScale.setPrecision(options.pricePrecision ?? null);
    mainPane.series.push(this.mainSeries);

    this.bindEvents();
    this.watchDpr();
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.root);
    this.layout();
  }

  setData(candles: Candle[]): void {
    this.stampDrawingTimes();
    this.candles = candles;
    this.heikinAshiCandles = heikinAshi(candles);
    this.reindexDrawingAnchors();
    this.panes[0]?.priceScale.setBasePrice(this.priceSeriesCandles()[0]?.close ?? 1);
    if (!this.intervalExplicit && candles.length > 1) {
      const diffs: number[] = [];
      for (let i = 1; i < Math.min(candles.length, 20); i++) {
        diffs.push(candles[i].time - candles[i - 1].time);
      }
      diffs.sort((a, b) => a - b);
      this.intervalSec = diffs[Math.floor(diffs.length / 2)] || 60;
    }
    this.timeScale.setDataLen(candles.length);
    for (const pane of this.panes) pane.priceScale.reset();
    if (!this.hasFit && candles.length > 0) {
      this.timeScale.fit();
      this.hasFit = true;
    }
    this.emitData();
    this.invalidate();
  }

  /** Prepend an older history page while preserving the current logical viewport. */
  prependData(candles: Candle[]): void {
    if (candles.length === 0) return;
    if (this.candles.length === 0) {
      this.setData(candles);
      return;
    }
    const firstTime = this.candles[0].time;
    const older = candles
      .filter((candle) => candle.time < firstTime)
      .sort((a, b) => a.time - b.time);
    if (older.length === 0) return;

    this.stampDrawingTimes();
    this.candles = [...older, ...this.candles];
    // HA Open phu thuoc nen HA truoc, nen prepend history phai tinh lai toan bo chuoi.
    this.heikinAshiCandles = heikinAshi(this.candles);
    this.timeScale.prependData(older.length);
    this.reindexDrawingAnchors();
    if (this.crosshair) this.crosshair.index += older.length;
    if (this.externalIndex !== null) this.externalIndex += older.length;
    if (this.measure) {
      this.measure.startIndex += older.length;
      this.measure.endIndex += older.length;
    }
    this.panes[0]?.priceScale.setBasePrice(this.priceSeriesCandles()[0]?.close ?? 1);
    for (const pane of this.panes) pane.priceScale.reset();
    this.emitData();
    this.invalidate();
  }

  /** Append a new bar or replace the last one (live updates). */
  updateCandle(c: Candle): void {
    const lastIndex = this.candles.length - 1;
    const last = this.candles[lastIndex];
    if (last && c.time === last.time) {
      this.candles[lastIndex] = c;
      this.heikinAshiCandles[lastIndex] = heikinAshiCandle(
        c,
        this.heikinAshiCandles[lastIndex - 1],
      );
    } else if (!last || c.time > last.time) {
      this.candles.push(c);
      this.heikinAshiCandles.push(
        heikinAshiCandle(c, this.heikinAshiCandles[this.heikinAshiCandles.length - 1]),
      );
      this.timeScale.setDataLen(this.candles.length);
    } else {
      return;
    }
    this.emitData();
    this.invalidate();
  }

  getCandles(): readonly Candle[] {
    return this.candles;
  }

  private priceSeriesCandles(): readonly Candle[] {
    return this.mainSeries.mode === 'heikin-ashi' ? this.heikinAshiCandles : this.candles;
  }

  getIntervalSec(): number {
    return this.intervalSec;
  }

  setIntervalSec(sec: number): void {
    this.intervalSec = sec;
    this.intervalExplicit = true;
  }

  /** Set fixed price decimals, or pass null to infer them from the visible scale. */
  setPricePrecision(decimals: number | null): void {
    this.panes[0]?.priceScale.setPrecision(decimals);
    this.invalidate();
  }

  setMode(mode: PriceSeriesMode): void {
    this.mainSeries.mode = mode;
    this.panes[0]?.priceScale.setBasePrice(this.priceSeriesCandles()[0]?.close ?? 1);
    this.invalidate();
  }

  setPriceSeriesColors(colors: { line?: string; area?: string }): void {
    this.mainSeries.lineColor = colors.line || null;
    this.mainSeries.areaColor = colors.area || null;
    this.invalidate();
  }

  /** Draw compact labels under selected price bars. */
  setBarLabels(labels: readonly BarLabel[], style: BarLabelStyle = {}): void {
    this.barLabels = new Map(labels.map(({ time, ...label }) => [time, label]));
    if (style.opacity !== undefined) this.barLabelOpacity = clamp(style.opacity, 0, 1);
    if (style.gap !== undefined) this.barLabelGap = clamp(style.gap, 0, 40);
    if (style.fontSize !== undefined) this.barLabelFontSize = clamp(style.fontSize, 6, 16);
    this.invalidate();
  }

  /** Draw a compact vertical progress marker beside one price bar. */
  setBarProgressMarker(marker: BarProgressMarker | null): void {
    const next = marker ? { ...marker, remaining: clamp(marker.remaining, 0, 1) } : null;
    if (!next || next.time !== this.barProgressMarker?.time) this.barProgressAnchor = null;
    this.barProgressMarker = next;
    this.invalidate();
  }

  /** Set the centered watermark, typically the active symbol. */
  setWatermark(text: string): void {
    this.watermark = text;
    this.invalidate();
  }

  setLegendTitle(title: string): void {
    this.legendTitle = title;
    this.invalidate();
  }

  setLegendCollapsed(collapsed: boolean): void {
    if (this.legendCollapsed === collapsed) return;
    this.legendCollapsed = collapsed;
    this.invalidate();
  }

  isLegendCollapsed(): boolean {
    return this.legendCollapsed;
  }

  setMarketQuote(quote: ChartMarketQuote | null): void {
    this.marketQuote = quote;
    this.invalidate();
  }

  setSessionsVisible(visible: boolean): void {
    this.sessionsVisible = visible;
    this.invalidate();
  }

  getSessionsVisible(): boolean {
    return this.sessionsVisible;
  }

  getPaneWeights(): number[] {
    return this.panes.map((pane) => pane.weight);
  }

  setPaneWeights(weights: readonly number[]): void {
    weights.forEach((weight, index) => {
      const pane = this.panes[index];
      if (!pane || !Number.isFinite(weight) || weight <= 0) return;
      pane.weight = weight;
      pane.el.style.flex = `${weight} 1 0%`;
    });
    this.layout();
  }

  setTheme(theme: Partial<Theme>): void {
    this.theme = { ...this.theme, ...theme };
    this.root.style.background = this.theme.bg;
    for (const p of this.panes.slice(1)) p.el.style.borderTop = `1px solid ${this.theme.border}`;
    this.invalidate();
  }

  addPane(weight = 1): Pane {
    const pane = this.createPane(weight);
    this.layout();
    return pane;
  }

  removePane(pane: Pane): void {
    const idx = this.panes.indexOf(pane);
    if (idx <= 0) return; // pane 0 is permanent
    this.panes.splice(idx, 1);
    pane.resizeHandle?.remove();
    pane.el.remove();
    if (this.crosshair?.pane === pane) this.crosshair = null;
    if (this.measure?.pane === pane) this.measure = null;
    if (this.drawings.some((drawing) => drawing.pane === pane && drawing.id === this.selectedDrawingId)) {
      this.selectedDrawingId = null;
    }
    this.drawings = this.drawings.filter((drawing) => drawing.pane !== pane);
    if (this.drawingDraft?.pane === pane) this.drawingDraft = null;
    this.emitDrawingChange();
    this.layout();
  }

  addLine(opts: LineSeriesOptions & { pane?: Pane } = {}): LineSeries {
    const appearance = this.indicatorAppearance;
    const color = appearance?.colors[this.indicatorSeriesIndex % appearance.colors.length];
    this.indicatorSeriesIndex++;
    const s = new LineSeries({
      ...opts,
      color: color ?? opts.color,
      lineWidth: appearance?.lineWidth ?? opts.lineWidth,
      lineStyle: appearance?.lineStyle ?? opts.lineStyle,
      fill: appearance ? appearance.display === 'area' : opts.fill,
    });
    s.indicatorId = this.indicatorOwner;
    s.opacity = appearance?.opacity ?? 1;
    (opts.pane ?? this.panes[0]).series.push(s);
    this.invalidate();
    return s;
  }

  addHistogram(opts: HistogramSeriesOptions & { pane?: Pane } = {}): HistogramSeries {
    const appearance = this.indicatorAppearance;
    const color = appearance?.colors[this.indicatorSeriesIndex % appearance.colors.length];
    const negative = appearance?.colors[(this.indicatorSeriesIndex + 1) % appearance.colors.length];
    const directionalVolume = this.indicatorOwner === 'volume' && color && negative
      ? (i: number) => {
          const candle = this.candles[i];
          const value = candle && candle.close >= candle.open ? color : negative;
          return value.startsWith('#') ? hexToRgba(value, 0.62) : value;
        }
      : null;
    this.indicatorSeriesIndex++;
    const s = new HistogramSeries({
      ...opts,
      posColor: color ?? opts.posColor,
      negColor: negative ?? opts.negColor,
      colorFor: directionalVolume ?? (appearance ? undefined : opts.colorFor),
    });
    s.indicatorId = this.indicatorOwner;
    s.opacity = appearance?.opacity ?? 1;
    (opts.pane ?? this.panes[0]).series.push(s);
    this.invalidate();
    return s;
  }

  addBand(opts: BandSeriesOptions & { pane?: Pane } = {}): BandSeries {
    const appearance = this.indicatorAppearance;
    const color = appearance?.colors[this.indicatorSeriesIndex % appearance.colors.length];
    const s = new BandSeries({ ...opts, fillColor: color ? hexToRgba(color, 0.1) : opts.fillColor });
    s.indicatorId = this.indicatorOwner;
    s.opacity = appearance?.opacity ?? 1;
    (opts.pane ?? this.panes[0]).series.push(s);
    this.invalidate();
    return s;
  }

  /** Per-bar background highlight. */
  addZone(opts: { pane?: Pane } = {}): ZoneSeries {
    const s = new ZoneSeries();
    s.indicatorId = this.indicatorOwner;
    s.opacity = this.indicatorAppearance?.opacity ?? 1;
    (opts.pane ?? this.panes[0]).series.push(s);
    this.invalidate();
    return s;
  }

  /**
   * Extra candle series from computed data — Heikin-Ashi, renko, another
   * symbol... `getData` is called on every render.
   */
  addCandles(getData: () => readonly Candle[], opts: { pane?: Pane; title?: string } = {}): CandleSeries {
    const s = new CandleSeries(getData);
    s.title = opts.title ?? '';
    s.indicatorId = this.indicatorOwner;
    s.opacity = this.indicatorAppearance?.opacity ?? 1;
    (opts.pane ?? this.panes[0]).series.push(s);
    this.invalidate();
    return s;
  }

  addVisibleRangeExtrema(
    opts: VisibleRangeExtremaSeriesOptions & { pane?: Pane } = {},
  ): VisibleRangeExtremaSeries {
    const appearance = this.indicatorAppearance;
    const s = new VisibleRangeExtremaSeries(() => this.candles, {
      ...opts,
      highColor: appearance?.colors[0] ?? opts.highColor,
      lowColor: appearance?.colors[1] ?? opts.lowColor,
    });
    s.indicatorId = this.indicatorOwner;
    s.opacity = appearance?.opacity ?? 1;
    (opts.pane ?? this.panes[0]).series.push(s);
    this.invalidate();
    return s;
  }

  /** Tags every series created by `factory` so its legend can manage the indicator as one object. */
  withIndicatorOwner<T>(id: string, factory: () => T, appearance: IndicatorAppearance | null = null): T {
    const previous = this.indicatorOwner;
    const previousAppearance = this.indicatorAppearance;
    const previousIndex = this.indicatorSeriesIndex;
    this.indicatorOwner = id;
    this.indicatorAppearance = appearance;
    this.indicatorSeriesIndex = 0;
    try {
      return factory();
    } finally {
      this.indicatorOwner = previous;
      this.indicatorAppearance = previousAppearance;
      this.indicatorSeriesIndex = previousIndex;
    }
  }

  onIndicatorRemove(cb: (id: string) => void): () => void {
    this.indicatorRemoveListeners.add(cb);
    return () => this.indicatorRemoveListeners.delete(cb);
  }

  onIndicatorSettings(cb: (id: string) => void): () => void {
    this.indicatorSettingsListeners.add(cb);
    return () => this.indicatorSettingsListeners.delete(cb);
  }

  getSelectedIndicatorId(): string | null {
    return this.selectedIndicatorId;
  }

  clearIndicatorSelection(): void {
    if (this.selectedIndicatorId === null && this.indicatorContext.hidden) return;
    this.selectedIndicatorId = null;
    this.indicatorContext.hidden = true;
    this.invalidate();
  }

  deleteSelectedIndicator(): boolean {
    const id = this.selectedIndicatorId;
    if (!id) return false;
    this.clearIndicatorSelection();
    for (const cb of this.indicatorRemoveListeners) cb(id);
    return true;
  }

  private toggleIndicatorVisibility(id: string): void {
    const series = this.panes.flatMap((pane) => pane.series).filter((item) => item.indicatorId === id);
    if (series.length === 0) return;
    const visible = series.some((item) => item.visible);
    for (const item of series) item.visible = !visible;
    if (visible && this.selectedIndicatorId === id) this.clearIndicatorSelection();
    this.invalidate();
  }

  removeSeries(series: Series): void {
    if (series === this.mainSeries) return;
    for (const pane of this.panes) {
      const i = pane.series.indexOf(series);
      if (i < 0) continue;
      pane.series.splice(i, 1);
      if (pane !== this.panes[0] && pane.series.length === 0) this.removePane(pane);
      break;
    }
    if (this.selectedIndicatorId && !this.panes.some((pane) => pane.series.some((item) => item.indicatorId === this.selectedIndicatorId))) {
      this.clearIndicatorSelection();
    }
    this.invalidate();
  }

  fitContent(): void {
    this.timeScale.fit();
    for (const pane of this.panes) pane.priceScale.reset();
    this.invalidate();
  }

  /** Reset only vertical scales, preserving the current horizontal replay position. */
  fitPriceScale(): void {
    for (const pane of this.panes) pane.priceScale.reset();
    this.invalidate();
  }

  scrollToLatest(): void {
    this.timeScale.scrollToEnd();
    this.invalidate();
    this.emitVisibleRangeChange();
  }

  setDrawingTool(tool: DrawingTool, text = ''): void {
    this.drawingTool = tool;
    this.drawingText = text.trim();
    this.drawingDraft = null;
    this.drawingPointerId = null;
    if (tool !== 'cursor') this.selectedDrawingId = null;
    this.root.style.cursor = this.replaySelectionMode || tool === 'cursor' ? 'crosshair' : 'cell';
    this.invalidateOverlay();
  }

  getDrawingTool(): DrawingTool {
    return this.drawingTool;
  }

  getDrawings(): SerializedDrawing[] {
    this.stampDrawingTimes();
    return this.drawings.map((drawing) => ({
      id: drawing.id,
      tool: drawing.tool,
      paneIndex: Math.max(0, this.panes.indexOf(drawing.pane)),
      start: { ...drawing.start },
      end: { ...drawing.end },
      stopPrice: drawing.stopPrice,
      points: drawing.points?.map((point) => ({ ...point })),
      text: drawing.text,
      style: drawing.style ? { ...drawing.style } : undefined,
    }));
  }

  setDrawings(drawings: SerializedDrawing[]): void {
    this.restoreDrawingSnapshot(drawings);
    this.drawingUndoStack.length = 0;
    this.drawingRedoStack.length = 0;
    this.resetDrawingHistoryGroup();
    this.selectedDrawingId = null;
    this.emitDrawingChange();
    this.invalidateOverlay();
  }

  getSelectedDrawingId(): number | null {
    return this.selectedDrawingId;
  }

  getDrawingAnchorClientPoint(id: number): { x: number; y: number; paneIndex: number } | null {
    const drawing = this.drawings.find((item) => item.id === id);
    if (!drawing) return null;
    const paneIndex = this.panes.indexOf(drawing.pane);
    if (paneIndex < 0) return null;
    const paneRect = drawing.pane.el.getBoundingClientRect();
    return {
      x: paneRect.left + this.timeScale.xForIndex(drawing.start.index),
      y: paneRect.top + drawing.pane.priceScale.yFor(drawing.start.price),
      paneIndex,
    };
  }

  selectDrawing(id: number | null): boolean {
    if (id !== null && !this.drawings.some((drawing) => drawing.id === id)) return false;
    this.selectedDrawingId = id;
    this.emitDrawingChange();
    this.invalidateOverlay();
    return true;
  }

  updateDrawingObject(
    id: number,
    patch: { text?: string; style?: Partial<DrawingStyle> },
  ): boolean {
    const drawing = this.drawings.find((item) => item.id === id);
    if (!drawing) return false;
    const historyKey = patch.text !== undefined
      ? `text:${id}`
      : `style:${id}:${Object.keys(patch.style ?? {}).sort().join(',')}`;
    this.recordDrawingMutation(historyKey);
    if (patch.text !== undefined) drawing.text = patch.text;
    if (patch.style) {
      drawing.style = { ...(drawing.style ?? {}), ...patch.style };
      L2Chart.drawingStyleDefaults.set(drawing.tool, { ...drawing.style });
    }
    this.emitDrawingChange();
    this.invalidateOverlay();
    return true;
  }

  deleteDrawing(id: number): boolean {
    const index = this.drawings.findIndex((drawing) => drawing.id === id);
    if (index < 0) return false;
    this.recordDrawingMutation();
    this.drawings.splice(index, 1);
    if (this.selectedDrawingId === id) this.selectedDrawingId = null;
    this.emitDrawingChange();
    this.invalidateOverlay();
    return true;
  }

  onDrawingsChange(
    cb: (drawings: SerializedDrawing[], selectedId: number | null) => void,
  ): () => void {
    this.drawingListeners.add(cb);
    return () => this.drawingListeners.delete(cb);
  }

  /** Called when the user double-clicks a drawing to edit its content. */
  onDrawingEditRequest(cb: (id: number) => boolean): () => void {
    this.drawingEditListeners.add(cb);
    return () => this.drawingEditListeners.delete(cb);
  }

  /** Arms the chart to choose the starting bar for a historical replay. */
  setReplaySelectionMode(active: boolean): void {
    this.replaySelectionMode = active;
    if (active) {
      this.drawingDraft = null;
      this.drawingPointerId = null;
      this.selectedDrawingId = null;
    }
    this.root.style.cursor = active || this.drawingTool === 'cursor' ? 'crosshair' : 'cell';
    this.invalidateOverlay();
  }

  undoDrawing(): boolean {
    this.drawingDraft = null;
    this.drawingPointerId = null;
    this.drawingDrag = null;
    const snapshot = this.drawingUndoStack.pop();
    if (!snapshot) return false;
    this.drawingRedoStack.push(this.getDrawings());
    this.restoreDrawingSnapshot(snapshot);
    this.selectedDrawingId = null;
    this.resetDrawingHistoryGroup();
    this.emitDrawingChange();
    this.invalidateOverlay();
    return true;
  }

  redoDrawing(): boolean {
    this.drawingDraft = null;
    this.drawingPointerId = null;
    this.drawingDrag = null;
    const snapshot = this.drawingRedoStack.pop();
    if (!snapshot) return false;
    this.drawingUndoStack.push(this.getDrawings());
    this.restoreDrawingSnapshot(snapshot);
    this.selectedDrawingId = null;
    this.resetDrawingHistoryGroup();
    this.emitDrawingChange();
    this.invalidateOverlay();
    return true;
  }

  canUndoDrawing(): boolean {
    return this.drawingUndoStack.length > 0;
  }

  canRedoDrawing(): boolean {
    return this.drawingRedoStack.length > 0;
  }

  deleteSelectedDrawing(): boolean {
    if (this.selectedDrawingId === null) return false;
    const index = this.drawings.findIndex((drawing) => drawing.id === this.selectedDrawingId);
    if (index < 0) return false;
    if (this.drawings[index].style?.locked) return false;
    this.recordDrawingMutation();
    this.selectedDrawingId = null;
    this.drawings.splice(index, 1);
    this.emitDrawingChange();
    this.invalidateOverlay();
    return true;
  }

  clearDrawingSelection(): void {
    if (this.selectedDrawingId === null) return;
    this.selectedDrawingId = null;
    this.emitDrawingChange();
    this.invalidateOverlay();
  }

  clearDrawings(): void {
    if (this.drawings.length > 0) this.recordDrawingMutation();
    this.drawingDraft = null;
    this.drawingPointerId = null;
    this.drawingDrag = null;
    this.drawings = [];
    this.selectedDrawingId = null;
    this.measure = null;
    this.emitDrawingChange();
    this.invalidateOverlay();
  }

  /**
   * Show a synced crosshair at the bar nearest to `time` (unix seconds), or
   * clear it with null. Used to mirror the crosshair across multiple charts.
   */
  setExternalCrosshair(time: number | null): void {
    const idx = time === null ? null : this.indexNearTime(time);
    if (idx === this.externalIndex) return;
    this.externalIndex = idx;
    this.invalidateOverlay();
  }

  private indexNearTime(time: number): number | null {
    const arr = this.candles;
    if (arr.length === 0) return null;
    const hi = arr.length - 1;
    // Ignore times clearly outside this chart's data (different market hours).
    if (time < arr[0].time - this.intervalSec || time > arr[hi].time + this.intervalSec) return null;
    if (time <= arr[0].time) return 0;
    if (time >= arr[hi].time) return hi;
    let lo = 0;
    let up = hi;
    while (lo < up) {
      const mid = (lo + up) >> 1;
      if (arr[mid].time < time) lo = mid + 1;
      else up = mid;
    }
    return time - arr[lo - 1].time <= arr[lo].time - time ? lo - 1 : lo;
  }

  on(name: EventName, cb: (e: CrosshairEvent) => void): () => void {
    this.listeners[name].add(cb);
    return () => this.listeners[name].delete(cb);
  }

  onVisibleRangeChange(cb: (e: VisibleRangeChangeEvent) => void): () => void {
    this.visibleRangeListeners.add(cb);
    return () => this.visibleRangeListeners.delete(cb);
  }

  /** Called after a click without a drag, with the nearest visible bar. */
  onBarClick(cb: (e: BarClickEvent) => void): () => void {
    this.barClickListeners.add(cb);
    return () => this.barClickListeners.delete(cb);
  }

  destroy(): void {
    this.ro.disconnect();
    for (const fn of this.detachFns) fn();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.root.remove();
  }

  private createPane(weight: number): Pane {
    const pane = new Pane(weight);
    pane.el = document.createElement('div');
    Object.assign(pane.el.style, {
      position: 'relative',
      flex: `${weight} 1 0%`,
      minHeight: `${this.panes.length === 0 ? MIN_MAIN_PANE_HEIGHT : MIN_INDICATOR_PANE_HEIGHT}px`,
    } satisfies Partial<CSSStyleDeclaration>);
    if (this.panes.length > 0) {
      pane.resizeHandle = document.createElement('div');
      pane.resizeHandle.className = 'l2chart-pane-resizer';
      pane.resizeHandle.setAttribute('role', 'separator');
      pane.resizeHandle.setAttribute('aria-orientation', 'horizontal');
      pane.resizeHandle.setAttribute('aria-label', 'Resize indicator pane');
      pane.resizeHandle.tabIndex = 0;
      this.bindPaneResize(pane.resizeHandle, pane);
      this.panesEl.appendChild(pane.resizeHandle);
      pane.el.style.borderTop = `1px solid ${this.theme.border}`;
    }
    pane.canvas = document.createElement('canvas');
    pane.overlay = document.createElement('canvas');
    for (const c of [pane.canvas, pane.overlay]) {
      Object.assign(c.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
      pane.el.appendChild(c);
    }
    pane.ctx = crispContext(pane.canvas.getContext('2d')!);
    pane.overlayCtx = crispContext(pane.overlay.getContext('2d')!);
    pane.legendEl = document.createElement('div');
    pane.legendEl.className = this.panes.length === 0 ? 'l2chart-legend l2chart-legend-main' : 'l2chart-legend';
    pane.legendEl.addEventListener('pointerdown', (event) => {
      if ((event.target as HTMLElement).closest('[data-legend-toggle],[data-indicator-action],[data-indicator-row]')) event.stopPropagation();
    });
    pane.legendEl.addEventListener('click', (event) => {
      const legendToggle = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-legend-toggle]');
      if (legendToggle) {
        event.preventDefault();
        event.stopPropagation();
        this.setLegendCollapsed(!this.legendCollapsed);
        return;
      }
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-indicator-action]');
      const id = button?.dataset.indicatorId;
      if (id) {
        event.preventDefault();
        event.stopPropagation();
        if (button.dataset.indicatorAction === 'settings') {
          for (const cb of this.indicatorSettingsListeners) cb(id);
        } else if (button.dataset.indicatorAction === 'visibility') {
          this.toggleIndicatorVisibility(id);
        } else if (button.dataset.indicatorAction === 'remove') {
          for (const cb of this.indicatorRemoveListeners) cb(id);
        }
        return;
      }
      const row = (event.target as HTMLElement).closest<HTMLElement>('[data-indicator-row]');
      const rowId = row?.dataset.indicatorRow;
      if (!rowId) return;
      event.preventDefault();
      event.stopPropagation();
      this.selectIndicator(rowId, row.dataset.indicatorTitle ?? rowId, event.clientX, event.clientY);
    });
    Object.assign(pane.legendEl.style, {
      position: 'absolute',
      top: '6px',
      left: '8px',
      pointerEvents: 'none',
      font: '500 11px Manrope, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      lineHeight: '1.8',
      zIndex: '2',
      whiteSpace: 'nowrap',
    } satisfies Partial<CSSStyleDeclaration>);
    pane.el.appendChild(pane.legendEl);
    this.panesEl.appendChild(pane.el);
    this.panes.push(pane);
    return pane;
  }

  private bindPaneResize(handle: HTMLDivElement, pane: Pane): void {
    let previous: Pane | null = null;
    let startY = 0;
    let previousHeight = 0;
    let paneHeight = 0;
    let resizingPointerId: number | null = null;

    const resize = (delta: number) => {
      if (!previous) return;
      const previousMin = previous === this.panes[0] ? MIN_MAIN_PANE_HEIGHT : MIN_INDICATOR_PANE_HEIGHT;
      const paneMin = MIN_INDICATOR_PANE_HEIGHT;
      const total = previousHeight + paneHeight;
      const nextPrevious = Math.max(previousMin, Math.min(total - paneMin, previousHeight + delta));
      const nextPane = total - nextPrevious;
      previous.weight = nextPrevious;
      pane.weight = nextPane;
      previous.el.style.flex = `${nextPrevious} 1 0%`;
      pane.el.style.flex = `${nextPane} 1 0%`;
      this.layout();
    };

    handle.addEventListener('pointerdown', (event) => {
      const index = this.panes.indexOf(pane);
      previous = index > 0 ? this.panes[index - 1] : null;
      if (!previous) return;
      event.preventDefault();
      event.stopPropagation();
      startY = event.clientY;
      previousHeight = previous.el.getBoundingClientRect().height;
      paneHeight = pane.el.getBoundingClientRect().height;
      resizingPointerId = event.pointerId;
      handle.classList.add('dragging');
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        /* synthetic pointer events may not have an active pointer to capture */
      }
    });
    handle.addEventListener('pointermove', (event) => {
      if (resizingPointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      resize(event.clientY - startY);
    });
    const finish = (event: PointerEvent) => {
      if (resizingPointerId !== event.pointerId) return;
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
      handle.classList.remove('dragging');
      resizingPointerId = null;
      previous = null;
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      const index = this.panes.indexOf(pane);
      previous = index > 0 ? this.panes[index - 1] : null;
      if (!previous) return;
      event.preventDefault();
      previousHeight = previous.el.getBoundingClientRect().height;
      paneHeight = pane.el.getBoundingClientRect().height;
      resize(event.key === 'ArrowUp' ? -12 : 12);
      previous = null;
    });
  }

  /** Keep CSS and bitmap sizes aligned to avoid resampling one-pixel strokes. */
  private sizeCanvas(
    c: HTMLCanvasElement,
    cssW: number,
    cssH: number,
    dpr: number,
  ): { w: number; h: number } {
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssH * dpr));
    if (c.width !== bw) c.width = bw;
    if (c.height !== bh) c.height = bh;
    const w = bw / dpr;
    const h = bh / dpr;
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    return { w, h };
  }

  /** Re-layout after browser zoom or a move between displays changes the DPR. */
  private watchDpr(): void {
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const onChange = () => {
      this.layout();
      this.watchDpr();
    };
    mq.addEventListener('change', onChange, { once: true });
    this.detachFns.push(() => mq.removeEventListener('change', onChange));
  }

  private layout(): void {
    const dpr = window.devicePixelRatio || 1;
    const rootW = this.root.getBoundingClientRect().width;
    this.axisW = this.configuredAxisW ?? (rootW <= 720 ? 68 : rootW <= 960 ? 76 : 92);
    let width = rootW;
    for (const pane of this.panes) {
      const paneH = pane.el.getBoundingClientRect().height;
      for (const c of [pane.canvas, pane.overlay]) {
        const s = this.sizeCanvas(c, rootW, paneH, dpr);
        width = s.w;
        pane.height = s.h;
      }
    }
    for (const c of [this.taCanvas, this.taOverlay]) {
      width = this.sizeCanvas(c, rootW, this.timeAxisH, dpr).w;
    }
    this.width = width;
    this.timeScale.setWidth(Math.max(0, this.width - this.axisW));
    this.invalidate();
  }

  private bindEvents(): void {
    const el = this.panesEl;
    const listen = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement,
      name: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(name, fn as EventListener, opts);
      this.detachFns.push(() => target.removeEventListener(name, fn as EventListener, opts));
    };

    listen(el, 'pointerdown', (e) => {
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic events have no active pointer to capture */
      }
      const axisPane = this.hitPriceAxis(e.clientX, e.clientY);
      if (axisPane && e.button === 0) {
        this.axisScaling = { pointerId: e.pointerId, pane: axisPane, lastY: e.clientY };
        this.root.style.cursor = 'ns-resize';
        this.clearCrosshair();
        return;
      }
      if (this.drawingTool !== 'cursor' && e.button === 0) {
        this.clearIndicatorSelection();
        this.startDrawing(this.drawingTool, e.pointerId, e.clientX, e.clientY);
        return;
      }
      if (!this.replaySelectionMode && !e.shiftKey && e.button === 0) {
        const selected = this.drawings.find((drawing) => drawing.id === this.selectedDrawingId);
        if (selected) {
          const hit = this.hitPane(e.clientX, e.clientY);
          const handle = hit && hit.pane === selected.pane
            ? hitTestDrawingHandle(selected, this.timeScale, hit.x, hit.y)
            : null;
          if (handle) {
            this.clearIndicatorSelection();
            this.drawingDrag = { pointerId: e.pointerId, drawing: selected, handle, moved: false };
            this.root.style.cursor = 'grabbing';
            return;
          }
          const canDragDrawing = hit
            && hit.pane === selected.pane
            && selected.style?.locked !== true
            && hitTestChartDrawing(selected, this.timeScale, hit.x, hit.y);
          if (canDragDrawing) {
            this.clearIndicatorSelection();
            this.beginDrawingBodyDrag(selected, e.pointerId, hit.x, hit.y);
            return;
          }
        }
        const drawing = this.findDrawingAt(
          e.clientX,
          e.clientY,
          e.pointerType === 'touch' ? 14 : 8,
        );
        if (drawing) {
          this.clearIndicatorSelection();
          this.selectedDrawingId = drawing.id;
          this.emitDrawingChange();
          this.invalidateOverlay();
          if (drawing.style?.locked !== true) {
            const hit = this.hitPane(e.clientX, e.clientY);
            if (hit) this.beginDrawingBodyDrag(drawing, e.pointerId, hit.x, hit.y);
          }
          return;
        }
        if (this.selectedDrawingId !== null) {
          this.selectedDrawingId = null;
          this.emitDrawingChange();
          this.invalidateOverlay();
        }
      }
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.pointerStarts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 1) {
        if (e.shiftKey) {
          e.preventDefault();
          this.startMeasure(e.clientX, e.clientY);
        } else {
          if (this.measure) {
            this.measure = null;
            this.invalidateOverlay();
          }
          this.dragging = true;
          this.lastDragX = e.clientX;
          this.lastDragY = e.clientY;
          this.dragPane = this.hitPane(e.clientX, e.clientY)?.pane ?? null;
          this.root.style.cursor = 'grabbing';
        }
      } else if (this.pointers.size === 2) {
        this.dragging = false;
        this.dragPane = null;
        this.lastPinchDist = this.pinchDist();
      }
    });

    listen(el, 'pointermove', (e) => {
      if (this.drawingDrag?.pointerId === e.pointerId) {
        this.updateDrawingHandle(this.drawingDrag, e.clientX, e.clientY);
        return;
      }
      if (this.axisScaling?.pointerId === e.pointerId) {
        const state = this.axisScaling;
        const paneRect = state.pane.el.getBoundingClientRect();
        const anchorY = clamp(e.clientY - paneRect.top, 0, state.pane.height);
        state.pane.priceScale.scaleBy(Math.exp((e.clientY - state.lastY) * 0.008), anchorY);
        state.lastY = e.clientY;
        this.invalidate();
        return;
      }
      if (this.drawingPointerId === e.pointerId && this.drawingDraft) {
        this.updateDrawing(e.clientX, e.clientY);
        this.updateCrosshair(e.clientX, e.clientY);
        return;
      }
      if (this.pointers.has(e.pointerId)) {
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      if (this.pointers.size === 2) {
        const dist = this.pinchDist();
        if (this.lastPinchDist > 0) {
          const rect = el.getBoundingClientRect();
          const xs = [...this.pointers.values()].map((p) => p.x - rect.left);
          this.timeScale.zoom(dist / this.lastPinchDist, (xs[0] + xs[1]) / 2);
          this.invalidate();
          this.emitVisibleRangeChange();
        }
        this.lastPinchDist = dist;
        return;
      }
      if (this.measure?.dragging) {
        this.updateMeasureEnd(e.clientX, e.clientY);
      } else if (this.dragging) {
        this.timeScale.scroll(e.clientX - this.lastDragX);
        this.dragPane?.priceScale.panBy(e.clientY - this.lastDragY);
        this.lastDragX = e.clientX;
        this.lastDragY = e.clientY;
        this.invalidate();
        this.emitVisibleRangeChange();
      }
      this.updateCrosshair(e.clientX, e.clientY);
      this.updatePointerCursor(e.clientX, e.clientY);
    });

    const release = (e: PointerEvent) => {
      if (this.drawingDrag?.pointerId === e.pointerId) {
        const changed = this.drawingDrag.moved;
        this.drawingDrag = null;
        if (changed) this.emitDrawingChange();
        this.updatePointerCursor(e.clientX, e.clientY);
        return;
      }
      if (this.axisScaling?.pointerId === e.pointerId) {
        this.axisScaling = null;
        this.updatePointerCursor(e.clientX, e.clientY);
        return;
      }
      if (this.drawingPointerId === e.pointerId) {
        this.finishDrawing();
        this.updatePointerCursor(e.clientX, e.clientY);
        return;
      }
      const start = this.pointerStarts.get(e.pointerId);
      const isBarClick =
        e.type === 'pointerup' &&
        !!start &&
        Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5;
      this.pointers.delete(e.pointerId);
      this.pointerStarts.delete(e.pointerId);
      if (this.pointers.size === 0) {
        this.dragging = false;
        this.dragPane = null;
      }
      if (this.measure) this.measure.dragging = false;
      this.lastPinchDist = 0;
      if (isBarClick && this.replaySelectionMode && !e.shiftKey) {
        const hit = this.hitPane(e.clientX, e.clientY);
        if (hit && this.candles.length > 0) {
          const index = clamp(
            Math.round(this.timeScale.indexForX(hit.x)),
            0,
            this.candles.length - 1,
          );
          const candle = this.candles[index] ?? null;
          for (const cb of this.barClickListeners) cb({ index, candle });
        }
      } else if (isBarClick && !e.shiftKey && this.drawingTool === 'cursor') {
        const indicator = this.findIndicatorAt(e.clientX, e.clientY);
        if (indicator) this.selectIndicator(indicator.id, indicator.title, e.clientX, e.clientY);
        else this.clearIndicatorSelection();
      }
      this.updatePointerCursor(e.clientX, e.clientY);
    };
    listen(el, 'pointerup', release);
    listen(el, 'pointercancel', release);

    listen(el, 'pointerleave', () => {
      if (!this.dragging && !this.axisScaling && !this.drawingDraft) this.clearCrosshair();
    });

    listen(el, 'wheel', (e) => {
      e.preventDefault();
      const axisPane = this.hitPriceAxis(e.clientX, e.clientY);
      if (axisPane) {
        const paneRect = axisPane.el.getBoundingClientRect();
        axisPane.priceScale.scaleBy(
          Math.exp(e.deltaY * 0.002),
          clamp(e.clientY - paneRect.top, 0, axisPane.height),
        );
        this.invalidate();
        return;
      }
      const rect = el.getBoundingClientRect();
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        this.timeScale.scroll(-e.deltaX);
      } else {
        this.timeScale.zoom(Math.exp(-e.deltaY * 0.002), e.clientX - rect.left);
      }
      this.invalidate();
      this.emitVisibleRangeChange();
      this.updateCrosshair(e.clientX, e.clientY);
    }, { passive: false });

    listen(el, 'dblclick', (e) => {
      const drawing = this.findDrawingAt(e.clientX, e.clientY);
      if (drawing) {
        this.clearIndicatorSelection();
        this.selectedDrawingId = drawing.id;
        this.emitDrawingChange();
        this.invalidateOverlay();
        let handled = false;
        for (const cb of this.drawingEditListeners) handled = cb(drawing.id) || handled;
        if (handled) return;
      }
      const axisPane = this.hitPriceAxis(e.clientX, e.clientY);
      if (axisPane) {
        axisPane.priceScale.reset();
        this.invalidate();
      } else {
        this.fitContent();
      }
    });

    listen(el, 'contextmenu', (e) => {
      const pane = this.hitPriceAxis(e.clientX, e.clientY);
      e.preventDefault();
      if (pane) {
        this.hideViewMenu();
        this.showPriceScaleMenu(pane, e.clientX, e.clientY);
        return;
      }
      this.hidePriceScaleMenu();
      if (this.hitPane(e.clientX, e.clientY)) this.showViewMenu(e.clientX, e.clientY);
      else this.hideViewMenu();
    });

    const onWindowPointerDown = (e: PointerEvent) => {
      if (!this.priceScaleMenu.hidden && !this.priceScaleMenu.contains(e.target as Node)) {
        this.hidePriceScaleMenu();
      }
      if (!this.viewMenu.hidden && !this.viewMenu.contains(e.target as Node)) {
        this.hideViewMenu();
      }
    };
    window.addEventListener('pointerdown', onWindowPointerDown);
    this.detachFns.push(() => window.removeEventListener('pointerdown', onWindowPointerDown));

    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.deleteSelectedDrawing()) {
        e.preventDefault();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.deleteSelectedIndicator()) {
        e.preventDefault();
        return;
      }
      const modifier = e.metaKey || e.ctrlKey;
      if (modifier && !e.altKey && e.key.toLowerCase() === 'z') {
        const changed = e.shiftKey ? this.redoDrawing() : this.undoDrawing();
        if (changed) e.preventDefault();
        return;
      }
      if (modifier && !e.altKey && e.key.toLowerCase() === 'y') {
        if (this.redoDrawing()) e.preventDefault();
        return;
      }
      if (e.altKey && !modifier) {
        const scale = this.priceScaleMenuPane?.priceScale ?? this.panes[0]?.priceScale;
        const key = e.key.toLowerCase();
        if (scale && ['r', 'i', 'p', 'l'].includes(key)) {
          if (key === 'r') scale.reset();
          else if (key === 'i') scale.setInverted(!scale.isInverted());
          else if (key === 'p') scale.setMode('percent');
          else scale.setMode('log');
          e.preventDefault();
          this.refreshPriceScaleMenu();
          this.invalidate();
          return;
        }
      }
      if (e.key === 'Escape') {
        if (!this.priceScaleMenu.hidden) {
          this.hidePriceScaleMenu();
          return;
        }
        if (!this.viewMenu.hidden) {
          this.hideViewMenu();
          return;
        }
        if (this.drawingDraft) {
          this.drawingDraft = null;
          this.drawingPointerId = null;
          this.invalidateOverlay();
        } else if (this.measure) {
          this.measure = null;
          this.invalidateOverlay();
        } else if (this.selectedIndicatorId) {
          this.clearIndicatorSelection();
        } else {
          this.clearDrawingSelection();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    this.detachFns.push(() => window.removeEventListener('keydown', onKey));
  }

  private startDrawing(tool: DrawableTool, pointerId: number, clientX: number, clientY: number): void {
    const hit = this.hitPane(clientX, clientY);
    if (!hit || this.candles.length === 0) return;
    const rawIndex = this.timeScale.indexForX(hit.x);
    const anchor = {
      index: FREEHAND_TOOLS.includes(tool) ? rawIndex : Math.round(rawIndex),
      price: hit.pane.priceScale.priceFor(hit.y),
    };
    const savedStyle = L2Chart.drawingStyleDefaults.get(tool);
    this.drawingDraft = {
      id: this.nextDrawingId++,
      tool,
      pane: hit.pane,
      start: anchor,
      end: { ...anchor },
      text: this.drawingText || (tool === 'text' ? tr('Ghi chú') : undefined),
      points: FREEHAND_TOOLS.includes(tool) ? [{ ...anchor }] : undefined,
      ...(savedStyle ? { style: { ...savedStyle } } : {}),
      draft: true,
    };
    this.drawingPointerId = pointerId;
    this.invalidateOverlay();
  }

  private updateDrawing(clientX: number, clientY: number): void {
    const drawing = this.drawingDraft;
    if (!drawing || this.candles.length === 0) return;
    const rect = drawing.pane.el.getBoundingClientRect();
    const x = clamp(clientX - rect.left, 0, this.timeScale.width);
    const y = clamp(clientY - rect.top, 0, drawing.pane.height);
    const rawIndex = this.timeScale.indexForX(x);
    const next = {
      index: FREEHAND_TOOLS.includes(drawing.tool) ? rawIndex : Math.round(rawIndex),
      price: drawing.pane.priceScale.priceFor(y),
    };
    drawing.end = next;
    if (FREEHAND_TOOLS.includes(drawing.tool)) {
      const points = drawing.points ?? (drawing.points = [{ ...drawing.start }]);
      const last = points[points.length - 1];
      const lastX = this.timeScale.xForIndex(last.index);
      const lastY = drawing.pane.priceScale.yFor(last.price);
      if (Math.hypot(x - lastX, y - lastY) >= 2) points.push({ ...next });
    }
    this.invalidateOverlay();
  }

  private finishDrawing(): void {
    const drawing = this.drawingDraft;
    if (drawing) {
      if (drawing.tool === 'long-position' || drawing.tool === 'short-position') {
        const prices = resolvePositionPrices(drawing);
        drawing.start.price = prices.entry;
        drawing.end.price = prices.target;
        drawing.stopPrice = prices.stop;
      }
      this.recordDrawingMutation();
      drawing.draft = false;
      this.drawings.push(drawing);
      this.selectedDrawingId = drawing.id;
      this.emitDrawingChange();
    }
    this.drawingDraft = null;
    this.drawingPointerId = null;
    this.invalidateOverlay();
  }

  private updateDrawingHandle(state: DrawingDragState, clientX: number, clientY: number): void {
    const { drawing, handle } = state;
    const rect = drawing.pane.el.getBoundingClientRect();
    const x = clamp(clientX - rect.left, 0, this.timeScale.width);
    const y = clamp(clientY - rect.top, 0, drawing.pane.height);
    const nextIndex = Math.round(this.timeScale.indexForX(x));
    const nextPrice = drawing.pane.priceScale.priceFor(y);
    const minStep = Math.max(Math.abs(drawing.start.price) * 0.0001, 0.00001);

    if (handle === 'body') {
      const pointerStart = state.pointerStart;
      const originalStart = state.originalStart;
      const originalEnd = state.originalEnd;
      const originalStopPrice = state.originalStopPrice;
      if (!pointerStart || !originalStart || !originalEnd) return;
      const rawIndex = this.timeScale.indexForX(x);
      const deltaIndex = Math.round(rawIndex - pointerStart.index);
      const deltaPrice = nextPrice - pointerStart.price;
      if (deltaIndex === 0 && Math.abs(deltaPrice) < minStep) return;
      if (!state.moved) this.recordDrawingMutation();
      drawing.start = {
        index: originalStart.index + deltaIndex,
        price: originalStart.price + deltaPrice,
      };
      drawing.end = {
        index: originalEnd.index + deltaIndex,
        price: originalEnd.price + deltaPrice,
      };
      drawing.stopPrice = originalStopPrice === undefined ? undefined : originalStopPrice + deltaPrice;
      drawing.points = state.originalPoints?.map((point) => ({
        index: point.index + deltaIndex,
        price: point.price + deltaPrice,
      }));
    } else if (drawing.tool === 'long-position' || drawing.tool === 'short-position') {
      if (!state.moved) this.recordDrawingMutation();
      const isLong = drawing.tool === 'long-position';
      const { entry, target, stop } = resolvePositionPrices(drawing);
      if (handle === 'entry') {
        drawing.start.price = isLong
          ? clamp(nextPrice, stop + minStep, target - minStep)
          : clamp(nextPrice, target + minStep, stop - minStep);
      } else if (handle === 'target') {
        drawing.end.price = isLong ? Math.max(entry + minStep, nextPrice) : Math.min(entry - minStep, nextPrice);
      } else if (handle === 'stop') {
        drawing.stopPrice = isLong ? Math.min(entry - minStep, nextPrice) : Math.max(entry + minStep, nextPrice);
      }
    } else if (handle === 'start') {
      if (!state.moved) this.recordDrawingMutation();
      drawing.start = { index: nextIndex, price: nextPrice };
    } else if (handle === 'end') {
      if (!state.moved) this.recordDrawingMutation();
      drawing.end = { index: nextIndex, price: nextPrice };
    }
    state.moved = true;
    this.invalidateOverlay();
  }

  private beginDrawingBodyDrag(
    drawing: ChartDrawing,
    pointerId: number,
    x: number,
    y: number,
  ): void {
    const isPosition = drawing.tool === 'long-position' || drawing.tool === 'short-position';
    const prices = isPosition ? resolvePositionPrices(drawing) : null;
    this.drawingDrag = {
      pointerId,
      drawing,
      handle: 'body',
      moved: false,
      pointerStart: {
        index: this.timeScale.indexForX(x),
        price: drawing.pane.priceScale.priceFor(y),
      },
      originalStart: {
        index: drawing.start.index,
        price: prices?.entry ?? drawing.start.price,
      },
      originalEnd: {
        index: drawing.end.index,
        price: prices?.target ?? drawing.end.price,
      },
      originalStopPrice: prices?.stop ?? drawing.stopPrice,
      originalPoints: drawing.points?.map((point) => ({ ...point })),
    };
    this.root.style.cursor = 'grabbing';
  }

  private startMeasure(clientX: number, clientY: number): void {
    const hit = this.hitPane(clientX, clientY);
    if (!hit || this.candles.length === 0) return;
    const index = Math.round(this.timeScale.indexForX(hit.x));
    const price = hit.pane.priceScale.priceFor(hit.y);
    this.measure = {
      pane: hit.pane,
      startIndex: index,
      startPrice: price,
      endIndex: index,
      endPrice: price,
      dragging: true,
    };
    this.invalidateOverlay();
  }

  private updateMeasureEnd(clientX: number, clientY: number): void {
    const m = this.measure;
    if (!m || this.candles.length === 0) return;
    const r = m.pane.el.getBoundingClientRect();
    const x = clamp(clientX - r.left, 0, this.timeScale.width);
    const y = clamp(clientY - r.top, 0, m.pane.height);
    m.endIndex = Math.round(this.timeScale.indexForX(x));
    m.endPrice = m.pane.priceScale.priceFor(y);
    this.invalidateOverlay();
  }

  private pinchDist(): number {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private hitPane(clientX: number, clientY: number): { pane: Pane; x: number; y: number } | null {
    for (const pane of this.panes) {
      const r = pane.el.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) {
        return { pane, x: clamp(clientX - r.left, 0, this.timeScale.width), y: clientY - r.top };
      }
    }
    return null;
  }

  private findDrawingAt(clientX: number, clientY: number, tolerance = 8): ChartDrawing | null {
    const hit = this.hitPane(clientX, clientY);
    if (!hit) return null;
    for (let i = this.drawings.length - 1; i >= 0; i--) {
      const drawing = this.drawings[i];
      if (drawing.pane === hit.pane && hitTestChartDrawing(drawing, this.timeScale, hit.x, hit.y, tolerance)) {
        return drawing;
      }
    }
    return null;
  }

  private findIndicatorAt(clientX: number, clientY: number): { id: string; title: string } | null {
    const hit = this.hitPane(clientX, clientY);
    const rootRect = this.root.getBoundingClientRect();
    const range = this.timeScale.visibleRange();
    if (!hit || !range || clientX - rootRect.left > this.timeScale.width || this.candles.length === 0) return null;
    const index = clamp(Math.round(this.timeScale.indexForX(hit.x)), 0, this.candles.length - 1);
    const legendBounds = this.legendBounds(hit.pane);
    const rc: RenderContext = {
      ctx: hit.pane.ctx,
      ts: this.timeScale,
      ps: hit.pane.priceScale,
      from: range.from,
      to: range.to,
      paneWidth: this.timeScale.width,
      paneHeight: hit.pane.height,
      legendWidth: legendBounds.width,
      legendHeight: legendBounds.height,
      theme: this.theme,
    };
    for (let i = hit.pane.series.length - 1; i >= 0; i--) {
      const series = hit.pane.series[i];
      if (!series.visible || !series.indicatorId) continue;
      if (series.hitTest(rc, index, hit.x, hit.y)) {
        return { id: series.indicatorId, title: series.title || series.indicatorId };
      }
    }
    return null;
  }

  private selectIndicator(id: string, title: string, clientX: number, clientY: number): void {
    this.selectedIndicatorId = id;
    this.indicatorContext.querySelector<HTMLElement>('[data-indicator-context-title]')!.textContent = title;
    this.indicatorContext.hidden = false;
    const rootRect = this.root.getBoundingClientRect();
    const width = this.indicatorContext.offsetWidth;
    const height = this.indicatorContext.offsetHeight;
    this.indicatorContext.style.left = `${clamp(clientX - rootRect.left + 12, 8, Math.max(8, rootRect.width - width - 8))}px`;
    this.indicatorContext.style.top = `${clamp(clientY - rootRect.top - height - 12, 8, Math.max(8, rootRect.height - height - 8))}px`;
    this.invalidate();
  }

  private hitPriceAxis(clientX: number, clientY: number): Pane | null {
    const rootRect = this.root.getBoundingClientRect();
    const x = clientX - rootRect.left;
    if (x < this.timeScale.width || x > this.width) return null;
    return this.hitPane(clientX, clientY)?.pane ?? null;
  }

  private createIndicatorContext(): HTMLDivElement {
    const context = document.createElement('div');
    const icons = getLegendIcons();
    context.className = 'l2chart-indicator-context';
    context.hidden = true;
    context.innerHTML = `<strong data-indicator-context-title></strong>` +
      `<button type="button" data-indicator-context-action="settings" title="${tr('Cấu hình chỉ báo')}" aria-label="${tr('Cấu hình chỉ báo')}">${icons.settings}</button>` +
      `<button type="button" data-indicator-context-action="remove" class="danger" title="${tr('Xóa chỉ báo')}" aria-label="${tr('Xóa chỉ báo')}">${icons.trash}</button>`;
    context.addEventListener('pointerdown', (event) => event.stopPropagation());
    context.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-indicator-context-action]');
      const id = this.selectedIndicatorId;
      if (!button || !id) return;
      event.preventDefault();
      event.stopPropagation();
      if (button.dataset.indicatorContextAction === 'settings') {
        for (const cb of this.indicatorSettingsListeners) cb(id);
      } else {
        this.deleteSelectedIndicator();
      }
    });
    return context;
  }

  private createPriceScaleMenu(): HTMLDivElement {
    const menu = document.createElement('div');
    menu.className = 'l2chart-price-scale-menu';
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    const actions: { action: string; label: string; shortcut?: string; divider?: boolean }[] = [
      { action: 'reset', label: tr('Đặt lại tỷ lệ giá'), shortcut: '⌥ R' },
      { action: 'auto', label: tr('Tự động vừa dữ liệu'), divider: true },
      { action: 'invert', label: tr('Đảo chiều trục'), shortcut: '⌥ I', divider: true },
      { action: 'mode:regular', label: tr('Thường') },
      { action: 'mode:percent', label: tr('Phần trăm'), shortcut: '⌥ P' },
      { action: 'mode:indexed', label: tr('Chỉ số hóa 100') },
      { action: 'mode:log', label: tr('Logarit'), shortcut: '⌥ L' },
    ];
    for (const item of actions) {
      if (item.divider) {
        const divider = document.createElement('span');
        divider.className = 'l2chart-price-scale-divider';
        menu.appendChild(divider);
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.priceScaleAction = item.action;
      button.setAttribute('role', 'menuitem');
      button.innerHTML = `<span class="l2chart-price-scale-check" aria-hidden="true"></span><span>${item.label}</span>${item.shortcut ? `<kbd>${item.shortcut}</kbd>` : ''}`;
      button.addEventListener('click', () => {
        const pane = this.priceScaleMenuPane;
        if (!pane) return;
        if (item.action === 'reset' || item.action === 'auto') pane.priceScale.reset();
        else if (item.action === 'invert') pane.priceScale.setInverted(!pane.priceScale.isInverted());
        else if (item.action.startsWith('mode:')) pane.priceScale.setMode(item.action.slice(5) as PriceScaleMode);
        this.refreshPriceScaleMenu();
        this.invalidate();
        if (item.action === 'reset' || item.action === 'auto') this.hidePriceScaleMenu();
      });
      menu.appendChild(button);
    }
    return menu;
  }

  private createViewMenu(): HTMLDivElement {
    const menu = document.createElement('div');
    menu.className = 'l2chart-price-scale-menu l2chart-view-menu';
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.innerHTML = `<span class="l2chart-price-scale-check" aria-hidden="true"></span><span>${tr('Đặt lại khung nhìn')}</span>`;
    button.addEventListener('click', () => {
      this.fitContent();
      this.hideViewMenu();
    });
    menu.appendChild(button);
    return menu;
  }

  private showViewMenu(clientX: number, clientY: number): void {
    this.viewMenu.hidden = false;
    const rootRect = this.root.getBoundingClientRect();
    const width = this.viewMenu.offsetWidth;
    const height = this.viewMenu.offsetHeight;
    this.viewMenu.style.left = `${clamp(clientX - rootRect.left, 8, Math.max(8, rootRect.width - width - 8))}px`;
    this.viewMenu.style.top = `${clamp(clientY - rootRect.top, 8, Math.max(8, rootRect.height - height - 8))}px`;
  }

  private hideViewMenu(): void {
    this.viewMenu.hidden = true;
  }

  private showPriceScaleMenu(pane: Pane, clientX: number, clientY: number): void {
    this.hideViewMenu();
    this.priceScaleMenuPane = pane;
    this.refreshPriceScaleMenu();
    this.priceScaleMenu.hidden = false;
    const rootRect = this.root.getBoundingClientRect();
    const width = this.priceScaleMenu.offsetWidth;
    const height = this.priceScaleMenu.offsetHeight;
    this.priceScaleMenu.style.left = `${clamp(clientX - rootRect.left - width, 8, Math.max(8, rootRect.width - width - 8))}px`;
    this.priceScaleMenu.style.top = `${clamp(clientY - rootRect.top, 8, Math.max(8, rootRect.height - height - 8))}px`;
  }

  private refreshPriceScaleMenu(): void {
    const scale = this.priceScaleMenuPane?.priceScale;
    if (!scale) return;
    for (const button of this.priceScaleMenu.querySelectorAll<HTMLButtonElement>('button[data-price-scale-action]')) {
      const action = button.dataset.priceScaleAction ?? '';
      const active = action === 'auto'
        ? !scale.isManual()
        : action === 'invert'
          ? scale.isInverted()
          : action.startsWith('mode:') && scale.getMode() === action.slice(5);
      button.classList.toggle('active', active);
      button.querySelector('.l2chart-price-scale-check')!.textContent = active ? '✓' : '';
    }
  }

  private hidePriceScaleMenu(): void {
    this.priceScaleMenu.hidden = true;
    this.priceScaleMenuPane = null;
  }

  private updatePointerCursor(clientX: number, clientY: number): void {
    if (this.dragging) {
      this.root.style.cursor = 'grabbing';
    } else if (this.axisScaling || this.hitPriceAxis(clientX, clientY)) {
      this.root.style.cursor = 'ns-resize';
    } else if (this.drawingTool === 'cursor' && this.isPointerOverMovableDrawing(clientX, clientY)) {
      this.root.style.cursor = 'grab';
    } else {
      this.root.style.cursor = this.replaySelectionMode || this.drawingTool === 'cursor' ? 'crosshair' : 'cell';
    }
  }

  private isPointerOverMovableDrawing(clientX: number, clientY: number): boolean {
    const selected = this.drawings.find((drawing) => drawing.id === this.selectedDrawingId);
    if (!selected || selected.style?.locked === true) return false;
    const hit = this.hitPane(clientX, clientY);
    return !!hit
      && hit.pane === selected.pane
      && hitTestChartDrawing(selected, this.timeScale, hit.x, hit.y);
  }

  private updateCrosshair(clientX: number, clientY: number): void {
    let found: CrosshairState | null = null;
    const hit = this.hitPane(clientX, clientY);
    if (hit) {
      const index = clamp(
        Math.round(this.timeScale.indexForX(hit.x)),
        0,
        Math.max(0, this.candles.length - 1),
      );
      found = { pane: hit.pane, x: hit.x, y: hit.y, index };
    }
    const prevIndex = this.crosshair?.index ?? null;
    this.crosshair = found;
    this.invalidateOverlay();
    if ((found?.index ?? null) !== prevIndex) {
      this.emit('crosshair', {
        index: found?.index ?? null,
        candle: found ? (this.candles[found.index] ?? null) : null,
      });
      this.invalidate(); // legend follows the crosshair
    }
  }

  private clearCrosshair(): void {
    if (!this.crosshair) return;
    this.crosshair = null;
    this.emit('crosshair', { index: null, candle: null });
    this.invalidateOverlay();
    this.invalidate();
  }

  invalidate(): void {
    this.needMain = true;
    this.schedule();
  }

  private invalidateOverlay(): void {
    this.needOverlay = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      if (this.needMain) {
        this.needMain = false;
        this.renderMain();
        this.needOverlay = true;
      }
      if (this.needOverlay) {
        this.needOverlay = false;
        this.renderOverlay();
      }
    });
  }

  private emit(name: EventName, e: CrosshairEvent): void {
    for (const cb of this.listeners[name]) cb(e);
  }

  private emitData(): void {
    for (const cb of this.listeners.data) cb({ index: null, candle: null });
  }

  private emitVisibleRangeChange(): void {
    const range = this.timeScale.visibleRange();
    if (!range) return;
    const event = { ...range, dataLength: this.candles.length };
    for (const cb of this.visibleRangeListeners) cb(event);
  }

  private drawingAnchors(): DrawingAnchor[] {
    const anchors: DrawingAnchor[] = [];
    for (const drawing of [...this.drawings, ...(this.drawingDraft ? [this.drawingDraft] : [])]) {
      anchors.push(drawing.start, drawing.end, ...(drawing.points ?? []));
    }
    return anchors;
  }

  private stampDrawingTimes(): void {
    if (this.candles.length === 0) return;
    for (const anchor of this.drawingAnchors()) {
      if (anchor.time !== undefined) continue;
      anchor.time = this.timeForLogicalIndex(anchor.index);
    }
  }

  private timeForLogicalIndex(index: number): number {
    const candles = this.candles;
    const lastIndex = candles.length - 1;
    if (index <= 0) return candles[0].time + index * this.intervalSec;
    if (index >= lastIndex) return candles[lastIndex].time + (index - lastIndex) * this.intervalSec;
    const leftIndex = Math.floor(index);
    const rightIndex = Math.ceil(index);
    if (leftIndex === rightIndex) return candles[leftIndex].time;
    return candles[leftIndex].time
      + (candles[rightIndex].time - candles[leftIndex].time) * (index - leftIndex);
  }

  private reindexDrawingAnchors(): void {
    if (this.candles.length === 0) return;
    for (const anchor of this.drawingAnchors()) {
      if (anchor.time === undefined) continue;
      anchor.index = this.logicalIndexForTime(anchor.time);
    }
    this.stampDrawingTimes();
  }

  private logicalIndexForTime(time: number): number {
    const candles = this.candles;
    if (candles.length === 0) return 0;
    const lastIndex = candles.length - 1;
    if (time <= candles[0].time) return (time - candles[0].time) / this.intervalSec;
    if (time >= candles[lastIndex].time) {
      return lastIndex + (time - candles[lastIndex].time) / this.intervalSec;
    }
    let lo = 0;
    let hi = lastIndex;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (candles[mid].time < time) lo = mid + 1;
      else hi = mid;
    }
    if (candles[lo].time === time) return lo;
    const previous = lo - 1;
    const span = candles[lo].time - candles[previous].time;
    return previous + (span > 0 ? (time - candles[previous].time) / span : 0);
  }

  private emitDrawingChange(): void {
    const snapshot = this.getDrawings();
    for (const cb of this.drawingListeners) cb(snapshot, this.selectedDrawingId);
  }

  private recordDrawingMutation(group: string | null = null): void {
    const now = Date.now();
    const coalesced = group !== null && group === this.drawingHistoryGroup && now - this.drawingHistoryTime < 900;
    if (!coalesced) {
      this.drawingUndoStack.push(this.getDrawings());
      if (this.drawingUndoStack.length > 100) this.drawingUndoStack.shift();
    }
    this.drawingRedoStack.length = 0;
    this.drawingHistoryGroup = group;
    this.drawingHistoryTime = now;
  }

  private resetDrawingHistoryGroup(): void {
    this.drawingHistoryGroup = null;
    this.drawingHistoryTime = 0;
  }

  private restoreDrawingSnapshot(drawings: SerializedDrawing[]): void {
    this.drawings = drawings.map((drawing) => ({
      id: drawing.id,
      tool: drawing.tool,
      pane: this.panes[drawing.paneIndex] ?? this.panes[0],
      start: { ...drawing.start },
      end: { ...drawing.end },
      stopPrice: drawing.stopPrice,
      points: drawing.points?.map((point) => ({ ...point })),
      text: drawing.text,
      style: drawing.style ? { ...drawing.style } : undefined,
    }));
    this.nextDrawingId = Math.max(1, ...this.drawings.map((drawing) => drawing.id + 1));
  }

  private renderMain(): void {
    const dpr = window.devicePixelRatio || 1;
    const range = this.timeScale.visibleRange();
    this.computeTimeTicks(range);

    for (const pane of this.panes) {
      const ctx = pane.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, this.width, pane.height);
      ctx.fillStyle = this.theme.bg;
      ctx.fillRect(0, 0, this.width, pane.height);
      pane.priceScale.setHeight(pane.height);

      if (range) {
        pane.autoscale(range.from, range.to);
        this.drawSessionBands(pane, range.from, range.to);
        this.drawGrid(pane);
        if (pane === this.panes[0] && this.watermark) {
          ctx.save();
          ctx.globalAlpha = 0.05;
          ctx.fillStyle = this.theme.text;
          const size = Math.round(Math.min(76, Math.max(28, pane.height * 0.16)));
          ctx.font = `700 ${size}px Manrope, -apple-system, BlinkMacSystemFont, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(this.watermark, this.timeScale.width / 2, pane.height / 2);
          ctx.restore();
        }
        const legendBounds = this.legendBounds(pane);
        const rc: RenderContext = {
          ctx,
          ts: this.timeScale,
          ps: pane.priceScale,
          from: range.from,
          to: range.to,
          paneWidth: this.timeScale.width,
          paneHeight: pane.height,
          legendWidth: legendBounds.width,
          legendHeight: legendBounds.height,
          theme: this.theme,
        };
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, this.timeScale.width, pane.height);
        ctx.clip();
        for (const s of pane.series) {
          if (!s.visible) continue;
          ctx.save();
          ctx.globalAlpha *= clamp(s.opacity, 0, 1);
          s.draw(rc);
          if (s.indicatorId === this.selectedIndicatorId) {
            ctx.save();
            ctx.shadowColor = this.theme.palette[0];
            ctx.shadowBlur = 7;
            s.draw(rc);
            ctx.restore();
          }
          ctx.restore();
        }
        if (pane === this.panes[0]) {
          this.drawBarProgressMarker(pane, range.from, range.to);
          this.drawBarLabels(pane, range.from, range.to);
        }
        ctx.restore();
      }
      this.drawPriceAxis(pane);
      this.updateLegend(pane);
    }
    this.renderTimeAxis();
  }

  private drawBarLabels(pane: Pane, from: number, to: number): void {
    if (this.barLabels.size === 0) return;
    const candles = this.priceSeriesCandles();
    const ctx = pane.ctx;
    ctx.save();
    ctx.globalAlpha = this.barLabelOpacity;
    ctx.font = `400 ${this.barLabelFontSize}px Manrope, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let index = Math.max(0, Math.floor(from)); index <= Math.min(candles.length - 1, Math.ceil(to)); index += 1) {
      const candle = candles[index];
      const label = this.barLabels.get(candle.time);
      if (!label) continue;
      const x = this.timeScale.xForIndex(index);
      const y = Math.max(
        0,
        Math.min(pane.height - this.barLabelFontSize - 2, pane.priceScale.yFor(candle.low) + this.barLabelGap),
      );
      ctx.fillStyle = label.color ?? this.theme.textDim;
      ctx.fillText(label.text, x, y);
      if (label.underlineColor) {
        const width = ctx.measureText(label.text).width + 2;
        ctx.strokeStyle = label.underlineColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x - width / 2, y + this.barLabelFontSize + 1);
        ctx.lineTo(x + width / 2, y + this.barLabelFontSize + 1);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawBarProgressMarker(pane: Pane, from: number, to: number): void {
    const marker = this.barProgressMarker;
    if (!marker) return;
    const candles = this.priceSeriesCandles();
    const index = candles.findIndex((candle) => candle.time === marker.time);
    if (index < Math.floor(from) || index > Math.ceil(to)) return;

    const candle = candles[index];
    const fullHeight = Math.max(12, pane.height * 0.2);
    const initialBottom = clamp(pane.priceScale.yFor(candle.low), fullHeight + 4, pane.height - 4);
    const bottom = clamp(this.barProgressAnchor?.bottom ?? initialBottom, fullHeight + 4, pane.height - 4);
    if (!this.barProgressAnchor) this.barProgressAnchor = { time: marker.time, bottom };
    const visibleHeight = Math.max(5, fullHeight * marker.remaining);
    const visibleTop = bottom - visibleHeight;
    const segmentCount = 5;
    const segmentGap = 2;
    const segmentHeight = (fullHeight - segmentGap * (segmentCount - 1)) / segmentCount;
    const x = this.timeScale.xForIndex(index) + clamp(this.timeScale.barSpacing * 1.5, 14, 28);
    const ctx = pane.ctx;
    ctx.save();
    ctx.strokeStyle = marker.color ?? '#d4a017';
    ctx.lineWidth = 3;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    for (let segment = 0; segment < segmentCount; segment += 1) {
      const segmentTop = bottom - fullHeight + segment * (segmentHeight + segmentGap);
      const segmentBottom = segmentTop + segmentHeight;
      const drawTop = Math.max(segmentTop, visibleTop);
      if (drawTop >= segmentBottom) continue;
      ctx.moveTo(x, drawTop);
      ctx.lineTo(x, segmentBottom);
    }
    ctx.stroke();
    ctx.restore();
  }

  private computeTimeTicks(range: { from: number; to: number } | null): void {
    this.timeTicks = [];
    if (!range) return;
    const step = niceBarStep(Math.ceil(80 / this.timeScale.barSpacing));
    let prevTime: number | null = null;
    for (let i = Math.ceil(range.from / step) * step; i <= range.to; i += step) {
      const c = this.candles[i];
      if (!c) continue;
      const tick = formatTimeTick(c.time, prevTime, this.intervalSec);
      this.timeTicks.push({ index: i, label: tick.text, major: tick.major });
      prevTime = c.time;
    }
  }

  private drawGrid(pane: Pane): void {
    const ctx = pane.ctx;
    ctx.fillStyle = this.theme.grid;
    ctx.save();
    ctx.globalAlpha = 0.48;
    for (const t of this.timeTicks) {
      const x = Math.round(this.timeScale.xForIndex(t.index));
      if (x < 0 || x > this.timeScale.width) continue;
      ctx.fillRect(x, 0, 1, pane.height);
      // Emphasize calendar boundaries with a second grid stroke.
      if (t.major) ctx.fillRect(x, 0, 1, pane.height);
    }
    ctx.restore();
    for (const p of pane.priceScale.ticks()) {
      const y = Math.round(pane.priceScale.yFor(p));
      ctx.fillRect(0, y, this.timeScale.width, 1);
    }
  }

  private drawSessionBands(pane: Pane, from: number, to: number): void {
    if (!this.sessionsVisible || this.intervalSec >= 86400) return;
    const ctx = pane.ctx;
    let groupStart = from;
    let groupKey = '';

    const sessionFor = (time: number): { key: string; phase: 'am' | 'pm' | 'off' } => {
      const date = new Date((time + 7 * 3600) * 1000);
      const day = `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}`;
      const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
      const phase = minute >= 540 && minute <= 690 ? 'am' : minute >= 780 && minute <= 900 ? 'pm' : 'off';
      return { key: `${day}:${phase}`, phase };
    };

    const drawGroup = (start: number, end: number, key: string) => {
      if (!key) return;
      const phase = key.endsWith(':am') ? 'am' : key.endsWith(':pm') ? 'pm' : 'off';
      const left = this.timeScale.xForIndex(start) - this.timeScale.barSpacing / 2;
      const right = this.timeScale.xForIndex(end) + this.timeScale.barSpacing / 2;
      if (phase !== 'off') {
        ctx.fillStyle = hexToRgba(this.theme.measureUp, phase === 'am' ? 0.025 : 0.045);
        ctx.fillRect(left, 0, right - left, pane.height);
      }
      // Keep the session shading without a full-height separator that can be
      // mistaken for market data.
    };

    for (let index = from; index <= to; index++) {
      const candle = this.candles[index];
      if (!candle) continue;
      const nextKey = sessionFor(candle.time).key;
      if (!groupKey) {
        groupKey = nextKey;
        groupStart = index;
      } else if (nextKey !== groupKey) {
        drawGroup(groupStart, index - 1, groupKey);
        groupStart = index;
        groupKey = nextKey;
      }
    }
    drawGroup(groupStart, to, groupKey);
  }

  private drawPriceAxis(pane: Pane): void {
    const ctx = pane.ctx;
    const x0 = this.timeScale.width;
    ctx.fillStyle = this.theme.axisBg;
    ctx.fillRect(x0, 0, this.axisW, pane.height);
    ctx.fillStyle = this.theme.border;
    ctx.fillRect(x0, 0, 1, pane.height);

    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = this.theme.textDim;
    for (const p of pane.priceScale.ticks()) {
      const y = Math.round(pane.priceScale.yFor(p));
      if (y < 8 || y > pane.height - 8) continue;
      ctx.fillText(pane.priceScale.formatLabel(p), x0 + 7, y);
    }

    // Last matched price is always visible on the main pane.
    if (pane === this.panes[0] && this.candles.length > 0) {
      const last = this.candles[this.candles.length - 1];
      const prev = this.candles[this.candles.length - 2] ?? last;
      const matchedPrice = this.marketQuote?.last && this.marketQuote.last > 0
        ? this.marketQuote.last
        : last.close;
      const y = Math.round(pane.priceScale.yFor(matchedPrice));
      if (y >= 0 && y <= pane.height) {
        const up = matchedPrice >= prev.close;
        const color = up ? this.theme.lastPriceUpBg : this.theme.lastPriceDownBg;
        // Draw the last matched price across the main pane.
        ctx.fillStyle = hexToRgba(color, 0.55);
        for (let dx = 0; dx < x0 - 2; dx += 6) ctx.fillRect(dx, y, 2, 1);
        ctx.fillStyle = color;
        this.roundRect(ctx, x0 + 2, y - 9, this.axisW - 5, 18, 3);
        ctx.fillStyle = '#ffffff';
        ctx.font = FONT_STRONG;
        ctx.fillText(pane.priceScale.formatLabel(matchedPrice), x0 + 7, y);
        ctx.font = FONT;
      }
      this.drawMarketQuoteLines(pane, y);
    }
  }

  private drawMarketQuoteLines(pane: Pane, matchedLabelY: number): void {
    const quote = this.marketQuote;
    if (!quote || !(Number(quote.bid) > 0) || !(Number(quote.ask) > 0)) return;
    const ctx = pane.ctx;
    const x0 = this.timeScale.width;
    const entries = [
      { label: 'ASK', price: Number(quote.ask), color: this.theme.down },
      { label: 'BID', price: Number(quote.bid), color: this.theme.up },
    ];
    const rawY = entries.map((entry) => pane.priceScale.yFor(entry.price));
    const labelY = [...rawY];
    if (Math.abs(labelY[0] - matchedLabelY) < 18) labelY[0] = matchedLabelY - 18;
    if (Math.abs(labelY[1] - matchedLabelY) < 18) labelY[1] = matchedLabelY + 18;
    if (Math.abs(labelY[0] - labelY[1]) < 18) {
      const middle = (labelY[0] + labelY[1]) / 2;
      labelY[0] = middle - 9;
      labelY[1] = middle + 9;
    }
    entries.forEach((entry, index) => {
      const y = Math.round(rawY[index]);
      if (y < 0 || y > pane.height) return;
      ctx.fillStyle = hexToRgba(entry.color, 0.42);
      for (let x = 0; x < x0 - 2; x += 7) ctx.fillRect(x, y, 3, 1);
      const ly = clamp(Math.round(labelY[index]), 9, pane.height - 9);
      ctx.fillStyle = entry.color;
      this.roundRect(ctx, x0 + 2, ly - 8, this.axisW - 5, 16, 3);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(pane.priceScale.formatLabel(entry.price), x0 + 7, ly);
    });
  }

  private renderTimeAxis(): void {
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.taCtx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.timeAxisH);
    ctx.fillStyle = this.theme.axisBg;
    ctx.fillRect(0, 0, this.width, this.timeAxisH);
    ctx.fillStyle = this.theme.border;
    ctx.fillRect(0, 0, this.width, 1);

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (const t of this.timeTicks) {
      const x = Math.round(this.timeScale.xForIndex(t.index));
      if (x < 15 || x > this.timeScale.width - 15) continue;
      ctx.font = t.major ? FONT_STRONG : FONT;
      ctx.fillStyle = t.major ? this.theme.text : this.theme.textDim;
      ctx.fillText(t.label, x, this.timeAxisH / 2 + 1);
    }
  }

  private renderOverlay(): void {
    const dpr = window.devicePixelRatio || 1;
    for (const pane of this.panes) {
      const ctx = pane.overlayCtx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, this.width, pane.height);
    }
    this.taOverlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.taOverlayCtx.clearRect(0, 0, this.width, this.timeAxisH);

    for (const drawing of this.drawings) {
      drawChartDrawing({
        drawing,
        timeScale: this.timeScale,
        theme: this.theme,
        candles: this.candles,
        intervalSec: this.intervalSec,
        selected: drawing.id === this.selectedDrawingId,
        invalidate: () => this.invalidateOverlay(),
      });
    }
    if (this.drawingDraft) {
      drawChartDrawing({
        drawing: this.drawingDraft,
        timeScale: this.timeScale,
        theme: this.theme,
        candles: this.candles,
        intervalSec: this.intervalSec,
        invalidate: () => this.invalidateOverlay(),
      });
    }
    this.drawMeasure();
    if (this.replaySelectionMode && this.crosshair) this.drawReplaySelection(this.crosshair.index);

    const ch = this.crosshair;
    const index = ch ? ch.index : this.externalIndex;
    if (index === null || this.candles.length === 0) return;
    const snapX = Math.round(this.timeScale.xForIndex(index));
    if (snapX < 0 || snapX > this.timeScale.width) return;

    for (const pane of this.panes) {
      const ctx = pane.overlayCtx;
      ctx.fillStyle = this.theme.crosshair;
      for (let y = 0; y < pane.height; y += 5) ctx.fillRect(snapX, y, 1, 2);
      if (ch && pane === ch.pane) {
        const yy = Math.round(ch.y);
        for (let x = 0; x < this.timeScale.width; x += 5) ctx.fillRect(x, yy, 2, 1);
        // Price label in the axis area.
        const price = pane.priceScale.priceFor(ch.y);
        ctx.font = FONT;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillStyle = this.theme.crosshairLabelBg;
        this.roundRect(ctx, this.timeScale.width + 2, yy - 9, this.axisW - 5, 18, 3);
        ctx.fillStyle = this.theme.crosshairLabelText;
        ctx.fillText(
          pane.priceScale.formatLabel(price),
          this.timeScale.width + 7,
          yy,
        );
      }
    }

    // Time label under the crosshair.
    const candle = this.candles[index];
    if (candle) {
      const ctx = this.taOverlayCtx;
      ctx.font = FONT;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      const label = formatTimeFull(candle.time, this.intervalSec);
      const w = ctx.measureText(label).width + 14;
      const x = clamp(snapX - w / 2, 0, this.width - w);
      ctx.fillStyle = this.theme.crosshairLabelBg;
      this.roundRect(ctx, x, 4, w, this.timeAxisH - 8, 3);
      ctx.fillStyle = this.theme.crosshairLabelText;
      ctx.fillText(label, x + w / 2, this.timeAxisH / 2 + 1);
    }
  }

  private drawReplaySelection(index: number): void {
    if (this.candles.length === 0) return;
    const x = Math.round(this.timeScale.xForIndex(index));
    if (x < 0 || x > this.timeScale.width) return;
    const color = this.theme.measureUp;
    for (const pane of this.panes) {
      const ctx = pane.overlayCtx;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, pane.height);
      ctx.stroke();
      ctx.restore();
    }

    const ctx = this.panes[0]?.overlayCtx;
    if (!ctx) return;
    ctx.save();
    ctx.font = FONT_STRONG;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = 'REPLAY';
    const width = ctx.measureText(label).width + 16;
    const left = clamp(x - width / 2, 4, Math.max(4, this.timeScale.width - width - 4));
    ctx.fillStyle = color;
    this.roundRect(ctx, left, 7, width, 19, 4);
    ctx.fillStyle = this.theme.measureUpText;
    ctx.fillText(label, left + width / 2, 17);
    ctx.restore();
  }

  private drawMeasure(): void {
    const m = this.measure;
    const len = this.candles.length;
    if (!m || len === 0) return;
    const ctx = m.pane.overlayCtx;
    const ts = this.timeScale;
    const ps = m.pane.priceScale;
    const x1 = ts.xForIndex(m.startIndex);
    const x2 = ts.xForIndex(m.endIndex);
    const y1 = ps.yFor(m.startPrice);
    const y2 = ps.yFor(m.endPrice);
    const up = m.endPrice >= m.startPrice;
    const base = up ? this.theme.measureUp : this.theme.measureDown;

    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const w = Math.abs(x2 - x1);
    const h = Math.abs(y2 - y1);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, ts.width, m.pane.height);
    ctx.clip();
    ctx.fillStyle = hexToRgba(base, 0.105);
    ctx.fillRect(left, top, w, h);
    if (w > 1 && h > 1) {
      ctx.strokeStyle = hexToRgba(base, 0.28);
      ctx.lineWidth = 1;
      ctx.strokeRect(left + 0.5, top + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
    }

    ctx.strokeStyle = hexToRgba(base, 0.92);
    ctx.fillStyle = hexToRgba(base, 0.92);
    ctx.lineWidth = 1.5;
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    if (w > 14) this.drawArrow(ctx, x1, midY, x2, midY);
    if (h > 14) this.drawArrow(ctx, midX, y1, midX, y2);

    const bars = Math.abs(m.endIndex - m.startIndex);
    const dp = m.endPrice - m.startPrice;
    const pct = m.startPrice !== 0 ? (dp / m.startPrice) * 100 : 0;
    let vol = 0;
    const lo = Math.max(0, Math.min(m.startIndex, m.endIndex));
    const hi = Math.min(len - 1, Math.max(m.startIndex, m.endIndex));
    for (let i = lo; i <= hi; i++) vol += this.candles[i].volume ?? 0;

    const sign = dp >= 0 ? '+' : '';
    const decimals = ps.decimals();
    const lines = [
      `${sign}${formatPrice(dp, decimals)} (${sign}${pct.toFixed(2)}%)`,
      `${bars} bars · ${formatDuration(bars * this.intervalSec)}`,
      `Vol ${formatCompact(vol)}`,
    ];
    ctx.font = FONT;
    let tw = 0;
    for (const l of lines) tw = Math.max(tw, ctx.measureText(l).width);
    const bw = tw + 22;
    const bh = lines.length * 16 + 12;
    const bx = clamp(midX - bw / 2, 4, Math.max(4, ts.width - bw - 4));
    let by = top - bh - 10;
    if (by < 4) by = top + h + 10;
    ctx.shadowColor = hexToRgba(base, 0.22);
    ctx.shadowBlur = 14;
    ctx.fillStyle = hexToRgba(base, 0.96);
    this.roundRect(ctx, bx, by, bw, bh, 6);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = hexToRgba(base, 0.38);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = up ? this.theme.measureUpText : this.theme.measureDownText;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    lines.forEach((l, i) => ctx.fillText(l, bx + bw / 2, by + 14 + i * 16));
    ctx.restore();
  }

  private drawArrow(
    ctx: CanvasRenderingContext2D,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): void {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const s = 7;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - s * Math.cos(ang - 0.42), y2 - s * Math.sin(ang - 0.42));
    ctx.lineTo(x2 - s * Math.cos(ang + 0.42), y2 - s * Math.sin(ang + 0.42));
    ctx.closePath();
    ctx.fill();
  }

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): void {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
  }

  private legendBounds(pane: Pane): { width: number; height: number } {
    const rect = pane.legendEl.getBoundingClientRect();
    const priceRows = pane === this.panes[0] && this.candles.length > 0 ? 1 : 0;
    if (pane === this.panes[0] && this.legendCollapsed) {
      return {
        width: Math.max(rect.width, 128),
        height: Math.max(rect.height, priceRows * 26 + 8),
      };
    }
    const indicatorRows = pane.series.filter((series) => series.title).length;
    return {
      width: Math.max(rect.width, priceRows ? 300 : 180),
      height: Math.max(rect.height, priceRows * 24 + indicatorRows * 26 + 10),
    };
  }

  private updateLegend(pane: Pane): void {
    const idx = this.crosshair?.index ?? this.candles.length - 1;
    const priceCandles = this.priceSeriesCandles();
    const c = priceCandles[idx];
    const decimals = pane.priceScale.decimals();
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const escAttr = (s: string) => esc(s).replace(/"/g, '&quot;');
    const textColor = escAttr(this.theme.text);
    const dimColor = escAttr(this.theme.textDim);
    const icons = getLegendIcons();
    let html = '';
    pane.legendEl.classList.toggle('l2chart-legend-collapsed', pane === this.panes[0] && this.legendCollapsed);

    if (pane === this.panes[0] && c) {
      const prev = priceCandles[idx - 1] ?? c;
      const chg = c.close - prev.close;
      const pct = prev.close !== 0 ? (chg / prev.close) * 100 : 0;
      const color = escAttr(chg >= 0 ? this.theme.up : this.theme.down);
      const f = (v: number) => formatPrice(v, decimals);
      const toggleTitle = this.legendCollapsed ? tr('Hiện các dòng chỉ báo') : tr('Ẩn các dòng chỉ báo');
      const toggleIcon = this.legendCollapsed ? icons.expand : icons.collapse;
      html += `<div class="l2chart-legend-row l2chart-legend-primary${this.legendCollapsed ? ' collapsed' : ''}" style="color:${textColor}">` +
        `<span class="l2chart-legend-primary-text"><b>${esc(this.legendTitle)}</b>&nbsp; ` +
        `<span style="color:${dimColor}">O</span> <span style="color:${color}">${f(c.open)}</span> ` +
        `<span style="color:${dimColor}">H</span> <span style="color:${color}">${f(c.high)}</span> ` +
        `<span style="color:${dimColor}">L</span> <span style="color:${color}">${f(c.low)}</span> ` +
        `<span style="color:${dimColor}">C</span> <span style="color:${color}">${f(c.close)}</span> ` +
        `<span style="color:${color}">${chg >= 0 ? '+' : ''}${f(chg)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span>`;
      html += `</span>` +
        `<button type="button" class="l2chart-legend-action l2chart-legend-toggle" data-legend-toggle title="${escAttr(toggleTitle)}" aria-label="${escAttr(toggleTitle)}" aria-expanded="${this.legendCollapsed ? 'false' : 'true'}">${toggleIcon}</button>` +
        `</div>`;
      if (this.legendCollapsed) {
        if (pane.legendEl.innerHTML !== html) pane.legendEl.innerHTML = html;
        return;
      }
    }
    const removableIndicators = new Set<string>();
    for (const s of pane.series) {
      if (!s.title) continue;
      const v = s.valueAt(idx);
      const color = escAttr(s.legendColor ?? this.theme.textDim);
      const removable = s.indicatorId && !removableIndicators.has(s.indicatorId);
      if (s.indicatorId) removableIndicators.add(s.indicatorId);
      const indicatorVisible = s.indicatorId
        ? this.panes.some((itemPane) => itemPane.series.some((item) => item.indicatorId === s.indicatorId && item.visible))
        : s.visible;
      const visibilityTitle = indicatorVisible ? tr('Ẩn chỉ báo') : tr('Hiện chỉ báo');
      const actions = removable
        ? `<span class="l2chart-legend-actions">` +
          `<button type="button" class="l2chart-legend-action l2chart-legend-settings" data-indicator-action="settings" data-indicator-id="${escAttr(s.indicatorId!)}" title="${tr('Cấu hình')} ${escAttr(s.title)}" aria-label="${tr('Cấu hình chỉ báo')} ${escAttr(s.title)}">` +
          `${icons.settings}</button>` +
          `<button type="button" class="l2chart-legend-action l2chart-legend-settings l2chart-legend-visibility" data-indicator-action="visibility" data-indicator-id="${escAttr(s.indicatorId!)}" title="${visibilityTitle} ${escAttr(s.title)}" aria-label="${visibilityTitle} ${escAttr(s.title)}">${indicatorVisible ? icons.visible : icons.hidden}</button>` +
          `<button type="button" class="l2chart-legend-action l2chart-legend-remove" data-indicator-action="remove" data-indicator-id="${escAttr(s.indicatorId!)}" title="${tr('Xóa')} ${escAttr(s.title)}" aria-label="${tr('Xóa chỉ báo')} ${escAttr(s.title)}">${icons.remove}</button>` +
          `</span>`
        : '';
      const selected = s.indicatorId === this.selectedIndicatorId;
      const rowData = s.indicatorId
        ? ` data-indicator-row="${escAttr(s.indicatorId)}" data-indicator-title="${escAttr(s.title)}"`
        : '';
      const valueText = s.legendText ?? (v === null ? '—' : s.formatValue(v, decimals));
      html += `<div class="l2chart-legend-row${selected ? ' selected' : ''}"${rowData} style="color:${dimColor}"><span>${esc(s.title)} ` +
        `<span style="color:${color}">${esc(valueText)}</span></span>${actions}</div>`;
    }
    if (pane.legendEl.innerHTML !== html) pane.legendEl.innerHTML = html;
  }
}
