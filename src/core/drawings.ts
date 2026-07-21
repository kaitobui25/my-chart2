import type { Pane } from './pane';
import type { TimeScale } from './time-scale';
import type { Candle, Theme } from './types';
import { formatDuration, formatPrice, hexToRgba } from './utils';
import { tr } from './i18n';

export type DrawingTool =
  | 'cursor'
  | 'trendline'
  | 'ray'
  | 'arrow'
  | 'horizontal-line'
  | 'vertical-line'
  | 'fib-retracement'
  | 'long-position'
  | 'short-position'
  | 'price-range'
  | 'text'
  | 'brush'
  | 'highlighter'
  | 'arrow-up'
  | 'arrow-down'
  | 'rectangle'
  | 'rotated-rectangle'
  | 'path'
  | 'circle'
  | 'ellipse'
  | 'polyline'
  | 'triangle'
  | 'arc'
  | 'curve'
  | 'double-curve'
  | 'note'
  | 'price-note'
  | 'pin'
  | 'table'
  | 'callout'
  | 'comment'
  | 'price-label'
  | 'signpost'
  | 'flag'
  | 'image'
  | 'post'
  | 'idea';

export type DrawableTool = Exclude<DrawingTool, 'cursor'>;

export interface DrawingAnchor {
  index: number;
  price: number;
  /** Keeps drawings attached to the same candle when older history is prepended. */
  time?: number;
}

export type DrawingLineStyle = 'solid' | 'dashed' | 'dotted';

export interface DrawingStyle {
  color: string;
  width: number;
  lineStyle: DrawingLineStyle;
  fontSize: number;
  label: string;
  visible: boolean;
  locked: boolean;
}

export interface SerializedDrawing {
  id: number;
  tool: DrawableTool;
  paneIndex: number;
  start: DrawingAnchor;
  end: DrawingAnchor;
  /** Stop-loss price for long/short position drawings. Older drawings derive it automatically. */
  stopPrice?: number;
  points?: DrawingAnchor[];
  text?: string;
  style?: Partial<DrawingStyle>;
}

export interface ChartDrawing {
  id: number;
  tool: DrawableTool;
  pane: Pane;
  start: DrawingAnchor;
  end: DrawingAnchor;
  stopPrice?: number;
  points?: DrawingAnchor[];
  text?: string;
  style?: Partial<DrawingStyle>;
  draft?: boolean;
}

interface DrawingRenderContext {
  drawing: ChartDrawing;
  timeScale: TimeScale;
  theme: Theme;
  candles: readonly Candle[];
  intervalSec: number;
  selected?: boolean;
  invalidate?: () => void;
}

export type DrawingHandle = 'start' | 'end' | 'entry' | 'target' | 'stop' | 'body';

export interface PositionPrices {
  entry: number;
  target: number;
  stop: number;
}

/** Normalizes old position drawings and guarantees target/stop remain on opposite sides of entry. */
export function resolvePositionPrices(drawing: ChartDrawing): PositionPrices {
  const isLong = drawing.tool === 'long-position';
  const entry = drawing.start.price;
  const fallbackDistance = Math.max(Math.abs(drawing.end.price - entry), Math.abs(entry) * 0.002, 0.0001);
  const validTarget = Number.isFinite(drawing.end.price) && (isLong ? drawing.end.price > entry : drawing.end.price < entry);
  const target = validTarget ? drawing.end.price : entry + (isLong ? fallbackDistance : -fallbackDistance);
  const rawStop = drawing.stopPrice;
  const validStop = Number.isFinite(rawStop) && (isLong ? rawStop! < entry : rawStop! > entry);
  const stopDistance = Math.max(Math.abs(target - entry) * 0.5, Math.abs(entry) * 0.001, 0.00005);
  const stop = validStop ? rawStop! : entry + (isLong ? -stopDistance : stopDistance);
  return { entry, target, stop };
}

export function hitTestDrawingHandle(
  drawing: ChartDrawing,
  timeScale: TimeScale,
  x: number,
  y: number,
  tolerance = 10,
): DrawingHandle | null {
  if (drawing.style?.visible === false || drawing.style?.locked === true) return null;
  const ps = drawing.pane.priceScale;
  const x1 = timeScale.xForIndex(drawing.start.index);
  const x2 = timeScale.xForIndex(drawing.end.index);
  if (drawing.tool === 'long-position' || drawing.tool === 'short-position') {
    const right = Math.max(x1, x2, Math.min(timeScale.width - 8, x1 + 28));
    const prices = resolvePositionPrices(drawing);
    const handles: [DrawingHandle, number][] = [
      ['target', prices.target],
      ['entry', prices.entry],
      ['stop', prices.stop],
    ];
    for (const [handle, price] of handles) {
      if (Math.hypot(x - right, y - ps.yFor(price)) <= tolerance) return handle;
    }
    return null;
  }
  if (Math.hypot(x - x1, y - ps.yFor(drawing.start.price)) <= tolerance) return 'start';
  if (!isSinglePointTool(drawing.tool) && Math.hypot(x - x2, y - ps.yFor(drawing.end.price)) <= tolerance) return 'end';
  return null;
}

const DRAWING_FONT = '600 12px Manrope, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const DEFAULT_TEXT_FONT_SIZE = 28;
const IMAGE_CACHE = new Map<string, HTMLImageElement>();

function drawingTextFont(size: number): string {
  return `600 ${size}px Manrope, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
}

function plainTextBounds(drawing: ChartDrawing, timeScale: TimeScale): { x: number; y: number; width: number; height: number } {
  const x = timeScale.xForIndex(drawing.start.index);
  const y = drawing.pane.priceScale.yFor(drawing.start.price);
  const fontSize = Math.max(12, Math.min(72, Number(drawing.style?.fontSize) || DEFAULT_TEXT_FONT_SIZE));
  const lines = (drawing.text?.trim() || tr('Ghi chú')).split('\n');
  const ctx = drawing.pane.overlayCtx;
  ctx.save();
  ctx.font = drawingTextFont(fontSize);
  const width = Math.max(fontSize, ...lines.map((line) => ctx.measureText(line || ' ').width));
  ctx.restore();
  return { x, y, width, height: Math.max(fontSize, lines.length * fontSize * 1.25) };
}

export function resolveDrawingStyle(drawing: ChartDrawing, theme: Theme): DrawingStyle {
  return {
    color: drawing.style?.color || theme.palette[0] || theme.crosshair,
    width: Math.max(1, Math.min(5, Number(drawing.style?.width) || 1.5)),
    lineStyle: drawing.style?.lineStyle ?? 'solid',
    fontSize: Math.max(12, Math.min(72, Number(drawing.style?.fontSize) || DEFAULT_TEXT_FONT_SIZE)),
    label: drawing.style?.label ?? '',
    visible: drawing.style?.visible !== false,
    locked: drawing.style?.locked === true,
  };
}

export function drawChartDrawing({ drawing, timeScale, theme, intervalSec, selected = false, invalidate }: DrawingRenderContext): void {
  const style = resolveDrawingStyle(drawing, theme);
  if (!style.visible) return;
  const pane = drawing.pane;
  const ctx = pane.overlayCtx;
  const ps = pane.priceScale;
  const x1 = timeScale.xForIndex(drawing.start.index);
  const y1 = ps.yFor(drawing.start.price);
  const x2 = timeScale.xForIndex(drawing.end.index);
  const y2 = ps.yFor(drawing.end.price);
  const lineColor = style.color;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, timeScale.width, pane.height);
  ctx.clip();
  ctx.lineWidth = selected ? Math.max(2, style.width + 0.5) : style.width;
  ctx.strokeStyle = lineColor;
  ctx.fillStyle = lineColor;
  ctx.setLineDash(style.lineStyle === 'dashed' ? [7, 5] : style.lineStyle === 'dotted' ? [2, 4] : []);
  ctx.font = DRAWING_FONT;
  ctx.textBaseline = 'middle';

  switch (drawing.tool) {
    case 'trendline':
      strokeLine(ctx, x1, y1, x2, y2);
      break;
    case 'ray':
      drawRay(ctx, x1, y1, x2, y2, timeScale.width, pane.height);
      break;
    case 'arrow':
      drawArrow(ctx, x1, y1, x2, y2);
      break;
    case 'horizontal-line':
      strokeLine(ctx, 0, y1, timeScale.width, y1);
      drawTag(ctx, formatPrice(drawing.start.price, ps.decimals()), timeScale.width - 6, y1, theme, 'right');
      break;
    case 'vertical-line':
      strokeLine(ctx, x1, 0, x1, pane.height);
      break;
    case 'fib-retracement':
      drawFib(ctx, drawing, x1, x2, theme);
      break;
    case 'long-position':
    case 'short-position':
      drawPosition(ctx, drawing, x1, x2, theme);
      break;
    case 'price-range':
      drawPriceRange(ctx, drawing, x1, y1, x2, y2, theme, intervalSec);
      break;
    case 'text':
      drawPlainText(ctx, drawing.text || tr('Ghi chú'), x1, y1, style);
      break;
    case 'brush':
    case 'highlighter':
    case 'path':
    case 'polyline':
      drawFreehand(ctx, drawing, timeScale, style);
      break;
    case 'arrow-up':
    case 'arrow-down':
      drawArrowMark(ctx, x1, y1, drawing.tool === 'arrow-up', theme);
      break;
    case 'rectangle':
      drawRectangle(ctx, x1, y1, x2, y2, theme);
      break;
    case 'rotated-rectangle':
      drawRotatedRectangle(ctx, x1, y1, x2, y2, theme);
      break;
    case 'circle':
      drawCircle(ctx, x1, y1, x2, y2, theme);
      break;
    case 'ellipse':
      drawEllipse(ctx, x1, y1, x2, y2, theme);
      break;
    case 'triangle':
      drawTriangle(ctx, x1, y1, x2, y2, theme);
      break;
    case 'arc':
      drawArc(ctx, x1, y1, x2, y2);
      break;
    case 'curve':
    case 'double-curve':
      drawCurve(ctx, x1, y1, x2, y2, drawing.tool === 'double-curve');
      break;
    case 'table':
      drawTable(ctx, drawing.text || '', x1, y1, x2, y2, theme);
      break;
    case 'image':
      drawImage(ctx, drawing.text || '', x1, y1, x2, y2, theme, invalidate);
      break;
    case 'note':
      drawPlainText(ctx, drawing.text || tr('Ghi chú'), x1, y1, style);
      break;
    case 'price-note':
    case 'pin':
    case 'callout':
    case 'comment':
    case 'price-label':
    case 'signpost':
    case 'flag':
    case 'post':
    case 'idea':
      drawAnnotation(ctx, drawing, x1, y1, theme);
      break;
  }

  if (style.label && drawing.tool !== 'text' && drawing.tool !== 'note') {
    ctx.setLineDash([]);
    ctx.fillStyle = lineColor;
    ctx.textAlign = 'left';
    ctx.fillText(style.label, x2 + 7, y2 - 10);
  }

  if (drawing.draft || selected) {
    if (drawing.tool === 'long-position' || drawing.tool === 'short-position') {
      const { entry, target, stop } = resolvePositionPrices(drawing);
      const right = Math.max(x1, x2, Math.min(timeScale.width - 8, x1 + 28));
      drawHandle(ctx, right, ps.yFor(target), theme);
      drawHandle(ctx, right, ps.yFor(entry), theme);
      drawHandle(ctx, right, ps.yFor(stop), theme);
    } else {
      drawHandle(ctx, x1, y1, theme);
      if (!isSinglePointTool(drawing.tool)) {
        drawHandle(ctx, x2, y2, theme);
      }
    }
  }
  ctx.restore();
}

function isSinglePointTool(tool: DrawableTool): boolean {
  return [
    'horizontal-line',
    'vertical-line',
    'text',
    'arrow-up',
    'arrow-down',
    'note',
    'price-note',
    'pin',
    'callout',
    'comment',
    'price-label',
    'signpost',
    'flag',
    'post',
    'idea',
  ].includes(tool);
}

function drawFreehand(
  ctx: CanvasRenderingContext2D,
  drawing: ChartDrawing,
  timeScale: TimeScale,
  style: DrawingStyle,
): void {
  const anchors = drawing.points?.length ? drawing.points : [drawing.start, drawing.end];
  if (anchors.length < 2) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (drawing.tool === 'highlighter') {
    ctx.lineWidth = Math.max(6, style.width * 4);
    ctx.strokeStyle = hexToRgba(style.color, 0.28);
  } else {
    ctx.lineWidth = style.width;
    ctx.strokeStyle = style.color;
  }
  ctx.beginPath();
  anchors.forEach((anchor, index) => {
    const x = timeScale.xForIndex(anchor.index);
    const y = drawing.pane.priceScale.yFor(anchor.price);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.restore();
}

function drawArrowMark(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  up: boolean,
  theme: Theme,
): void {
  const direction = up ? -1 : 1;
  const color = up ? theme.up : theme.down;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y + direction * 12);
  ctx.lineTo(x - 8, y);
  ctx.lineTo(x - 3, y);
  ctx.lineTo(x - 3, y - direction * 10);
  ctx.lineTo(x + 3, y - direction * 10);
  ctx.lineTo(x + 3, y);
  ctx.lineTo(x + 8, y);
  ctx.closePath();
  ctx.fill();
}

function drawRectangle(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  theme: Theme,
): void {
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  ctx.fillStyle = hexToRgba(theme.measureUp, 0.08);
  ctx.fillRect(left, top, width, height);
  ctx.strokeStyle = theme.measureUp;
  ctx.strokeRect(left, top, width, height);
}

function drawRotatedRectangle(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  theme: Theme,
): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.max(1, Math.hypot(dx, dy));
  const nx = -dy / length;
  const ny = dx / length;
  const halfWidth = Math.max(10, length * 0.18);
  const points = [
    [x1 + nx * halfWidth, y1 + ny * halfWidth],
    [x2 + nx * halfWidth, y2 + ny * halfWidth],
    [x2 - nx * halfWidth, y2 - ny * halfWidth],
    [x1 - nx * halfWidth, y1 - ny * halfWidth],
  ];
  ctx.beginPath();
  points.forEach(([x, y], index) => index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y));
  ctx.closePath();
  ctx.fillStyle = hexToRgba(theme.measureUp, 0.08);
  ctx.fill();
  ctx.strokeStyle = theme.measureUp;
  ctx.stroke();
}

function drawCircle(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  theme: Theme,
): void {
  const radius = Math.hypot(x2 - x1, y2 - y1);
  ctx.beginPath();
  ctx.arc(x1, y1, radius, 0, Math.PI * 2);
  ctx.fillStyle = hexToRgba(theme.measureUp, 0.07);
  ctx.fill();
  ctx.strokeStyle = theme.measureUp;
  ctx.stroke();
}

function drawEllipse(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  theme: Theme,
): void {
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  ctx.beginPath();
  ctx.ellipse(cx, cy, Math.max(1, Math.abs(x2 - x1) / 2), Math.max(1, Math.abs(y2 - y1) / 2), 0, 0, Math.PI * 2);
  ctx.fillStyle = hexToRgba(theme.measureUp, 0.07);
  ctx.fill();
  ctx.strokeStyle = theme.measureUp;
  ctx.stroke();
}

function drawTriangle(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  theme: Theme,
): void {
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  const top = Math.min(y1, y2);
  const bottom = Math.max(y1, y2);
  ctx.beginPath();
  ctx.moveTo((left + right) / 2, top);
  ctx.lineTo(right, bottom);
  ctx.lineTo(left, bottom);
  ctx.closePath();
  ctx.fillStyle = hexToRgba(theme.measureUp, 0.07);
  ctx.fill();
  ctx.strokeStyle = theme.measureUp;
  ctx.stroke();
}

function drawArc(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  ctx.beginPath();
  ctx.ellipse(cx, cy, Math.max(1, Math.abs(x2 - x1) / 2), Math.max(1, Math.abs(y2 - y1) / 2), 0, Math.PI, Math.PI * 2);
  ctx.stroke();
}

function drawCurve(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  double: boolean,
): void {
  const cx = (x1 + x2) / 2;
  const bend = Math.max(18, Math.abs(x2 - x1) * 0.22);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.quadraticCurveTo(cx, Math.min(y1, y2) - bend, x2, y2);
  ctx.stroke();
  if (double) {
    ctx.beginPath();
    ctx.moveTo(x1, y1 + 10);
    ctx.quadraticCurveTo(cx, Math.min(y1, y2) - bend + 10, x2, y2 + 10);
    ctx.stroke();
  }
}

function drawAnnotation(
  ctx: CanvasRenderingContext2D,
  drawing: ChartDrawing,
  x: number,
  y: number,
  theme: Theme,
): void {
  const price = formatPrice(drawing.start.price, drawing.pane.priceScale.decimals());
  const fallbackText = tr('Ghi chú');
  const text = drawing.text?.trim() || fallbackText;
  switch (drawing.tool) {
    case 'pin':
      ctx.fillStyle = theme.measureUp;
      ctx.beginPath();
      ctx.arc(x, y - 6, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x - 4, y - 1);
      ctx.lineTo(x, y + 8);
      ctx.lineTo(x + 4, y - 1);
      ctx.fill();
      break;
    case 'flag':
      ctx.strokeStyle = theme.text;
      strokeLine(ctx, x, y - 18, x, y + 12);
      ctx.fillStyle = theme.measureUp;
      ctx.beginPath();
      ctx.moveTo(x, y - 18);
      ctx.lineTo(x + 22, y - 14);
      ctx.lineTo(x, y - 7);
      ctx.closePath();
      ctx.fill();
      break;
    case 'signpost':
      ctx.fillStyle = theme.measureUp;
      ctx.beginPath();
      ctx.arc(x, y, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = theme.measureUpText;
      ctx.textAlign = 'center';
      ctx.fillText('★', x, y + 0.5);
      drawTag(ctx, text, x + 16, y, theme, 'left');
      break;
    case 'price-note':
      drawTag(ctx, `${price} · ${text}`, x + 10, y, theme, 'left', theme.measureUp);
      break;
    case 'price-label':
      drawTag(ctx, text === fallbackText ? price : `${text} ${price}`, x, y, theme, 'left', theme.measureUp);
      break;
    case 'idea':
      drawTag(ctx, `${tr('Ý tưởng')} · ${text}`, x + 10, y, theme, 'left', theme.measureUp);
      break;
    case 'post':
      drawTag(ctx, `${tr('Bài viết')} · ${text}`, x + 10, y, theme, 'left');
      break;
    case 'callout':
    case 'comment':
      drawTextNote(ctx, text, x, y, theme);
      break;
  }
}

function drawTable(
  ctx: CanvasRenderingContext2D,
  value: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  theme: Theme,
): void {
  const defaultValue = `${tr('Mức')},${tr('Ghi chú')};${tr('Hỗ trợ')},--;${tr('Kháng cự')},--`;
  const rows = (value || defaultValue)
    .split(';')
    .map((row) => row.split(',').map((cell) => cell.trim()));
  const columns = Math.max(1, ...rows.map((row) => row.length));
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.max(180, Math.abs(x2 - x1));
  const rowHeight = 26;
  const height = rows.length * rowHeight;
  const columnWidth = width / columns;
  ctx.fillStyle = hexToRgba(theme.axisBg, 0.94);
  ctx.fillRect(left, top, width, height);
  ctx.strokeStyle = theme.border;
  ctx.strokeRect(left, top, width, height);
  for (let row = 1; row < rows.length; row++) strokeLine(ctx, left, top + row * rowHeight, left + width, top + row * rowHeight);
  for (let column = 1; column < columns; column++) strokeLine(ctx, left + column * columnWidth, top, left + column * columnWidth, top + height);
  ctx.textAlign = 'left';
  rows.forEach((cells, row) => cells.forEach((cell, column) => {
    ctx.fillStyle = row === 0 ? theme.text : theme.textDim;
    ctx.fillText(cell, left + column * columnWidth + 7, top + row * rowHeight + rowHeight / 2);
  }));
}

function drawImage(
  ctx: CanvasRenderingContext2D,
  url: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  theme: Theme,
  invalidate?: () => void,
): void {
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.max(140, Math.abs(x2 - x1));
  const height = Math.max(90, Math.abs(y2 - y1));
  let image = IMAGE_CACHE.get(url);
  if (!image && url) {
    image = new Image();
    image.referrerPolicy = 'no-referrer';
    image.onload = () => invalidate?.();
    image.src = url;
    IMAGE_CACHE.set(url, image);
  }
  if (image?.complete && image.naturalWidth > 0) {
    ctx.drawImage(image, left, top, width, height);
  } else {
    ctx.fillStyle = hexToRgba(theme.axisBg, 0.94);
    ctx.fillRect(left, top, width, height);
    ctx.strokeStyle = theme.border;
    ctx.strokeRect(left, top, width, height);
    ctx.fillStyle = theme.textDim;
    ctx.textAlign = 'center';
    ctx.fillText(url ? `${tr('Đang tải ảnh')}...` : tr('Chưa có URL ảnh'), left + width / 2, top + height / 2);
  }
}

export function hitTestChartDrawing(
  drawing: ChartDrawing,
  timeScale: TimeScale,
  x: number,
  y: number,
  tolerance = 8,
): boolean {
  if (drawing.style?.visible === false) return false;
  const ps = drawing.pane.priceScale;
  const x1 = timeScale.xForIndex(drawing.start.index);
  const y1 = ps.yFor(drawing.start.price);
  const x2 = timeScale.xForIndex(drawing.end.index);
  const y2 = ps.yFor(drawing.end.price);

  switch (drawing.tool) {
    case 'trendline':
    case 'arrow':
      return distanceToSegment(x, y, x1, y1, x2, y2) <= tolerance;
    case 'ray':
      return distanceToRay(x, y, x1, y1, x2, y2) <= tolerance;
    case 'horizontal-line':
      return Math.abs(y - y1) <= tolerance;
    case 'vertical-line':
      return Math.abs(x - x1) <= tolerance;
    case 'fib-retracement': {
      const left = Math.min(x1, x2) - tolerance;
      const right = Math.max(x1, x2) + tolerance;
      if (x < left || x > right) return false;
      return [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1].some((level) => {
        const price = drawing.start.price + (drawing.end.price - drawing.start.price) * level;
        return Math.abs(y - ps.yFor(price)) <= tolerance;
      });
    }
    case 'long-position':
    case 'short-position': {
      const { target, stop } = resolvePositionPrices(drawing);
      return pointInRect(
        x,
        y,
        Math.min(x1, x2),
        Math.min(ps.yFor(target), ps.yFor(stop)),
        Math.max(28, Math.abs(x2 - x1)),
        Math.abs(ps.yFor(stop) - ps.yFor(target)),
        tolerance,
      );
    }
    case 'price-range':
      return pointInRect(
        x,
        y,
        Math.min(x1, x2),
        Math.min(y1, y2),
        Math.abs(x2 - x1),
        Math.abs(y2 - y1),
        tolerance,
      );
    case 'text':
    case 'note':
      {
        const bounds = plainTextBounds(drawing, timeScale);
        return pointInRect(x, y, bounds.x, bounds.y, bounds.width, bounds.height, tolerance);
      }
    case 'price-note':
    case 'pin':
    case 'callout':
    case 'comment':
    case 'price-label':
    case 'signpost':
    case 'flag':
    case 'post':
    case 'idea':
      return pointInRect(x, y, x1, y1 - 28, 150, 34, tolerance);
    case 'arrow-up':
    case 'arrow-down':
      return pointInRect(x, y, x1 - 12, y1 - 16, 24, 32, tolerance);
    case 'brush':
    case 'highlighter':
    case 'path':
    case 'polyline': {
      const points = drawing.points?.length ? drawing.points : [drawing.start, drawing.end];
      for (let i = 1; i < points.length; i++) {
        const ax = timeScale.xForIndex(points[i - 1].index);
        const ay = ps.yFor(points[i - 1].price);
        const bx = timeScale.xForIndex(points[i].index);
        const by = ps.yFor(points[i].price);
        if (distanceToSegment(x, y, ax, ay, bx, by) <= tolerance) return true;
      }
      return false;
    }
    case 'circle': {
      const radius = Math.hypot(x2 - x1, y2 - y1);
      return Math.abs(Math.hypot(x - x1, y - y1) - radius) <= tolerance;
    }
    case 'rectangle':
    case 'rotated-rectangle':
    case 'ellipse':
    case 'triangle':
    case 'arc':
    case 'curve':
    case 'double-curve':
      return pointInRect(
        x,
        y,
        Math.min(x1, x2),
        Math.min(y1, y2),
        Math.abs(x2 - x1),
        Math.abs(y2 - y1),
        tolerance,
      );
    case 'table':
    case 'image':
      return pointInRect(
        x,
        y,
        Math.min(x1, x2),
        Math.min(y1, y2),
        Math.max(180, Math.abs(x2 - x1)),
        Math.max(90, Math.abs(y2 - y1)),
        tolerance,
      );
  }
}

function distanceToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function distanceToRay(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, ((px - x1) * dx + (py - y1) * dy) / lengthSq);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function pointInRect(
  x: number,
  y: number,
  left: number,
  top: number,
  width: number,
  height: number,
  tolerance: number,
): boolean {
  return x >= left - tolerance && x <= left + width + tolerance && y >= top - tolerance && y <= top + height + tolerance;
}

function strokeLine(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function drawRay(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
  height: number,
): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (Math.abs(dx) < 1) {
    strokeLine(ctx, x1, y1, x1, dy >= 0 ? height : 0);
    return;
  }
  const edgeX = dx > 0 ? width : 0;
  const edgeY = y1 + ((edgeX - x1) / dx) * dy;
  strokeLine(ctx, x1, y1, edgeX, edgeY);
}

function drawArrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  strokeLine(ctx, x1, y1, x2, y2);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const size = 9;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - size * Math.cos(angle - 0.46), y2 - size * Math.sin(angle - 0.46));
  ctx.lineTo(x2 - size * Math.cos(angle + 0.46), y2 - size * Math.sin(angle + 0.46));
  ctx.closePath();
  ctx.fill();
}

function drawFib(
  ctx: CanvasRenderingContext2D,
  drawing: ChartDrawing,
  x1: number,
  x2: number,
  theme: Theme,
): void {
  const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  const width = Math.max(1, right - left);
  const ps = drawing.pane.priceScale;

  levels.forEach((level, index) => {
    const price = drawing.start.price + (drawing.end.price - drawing.start.price) * level;
    const y = ps.yFor(price);
    if (index < levels.length - 1) {
      const nextPrice = drawing.start.price + (drawing.end.price - drawing.start.price) * levels[index + 1];
      const nextY = ps.yFor(nextPrice);
      ctx.fillStyle = hexToRgba(index % 2 === 0 ? theme.measureUp : theme.palette[1] ?? theme.measureUp, 0.055);
      ctx.fillRect(left, Math.min(y, nextY), width, Math.abs(nextY - y));
    }
    ctx.strokeStyle = hexToRgba(theme.measureUp, level === 0 || level === 1 ? 0.95 : 0.66);
    ctx.setLineDash(level === 0 || level === 1 ? [] : [4, 3]);
    strokeLine(ctx, left, y, right, y);
    ctx.setLineDash([]);
    ctx.fillStyle = theme.text;
    ctx.textAlign = 'left';
    ctx.fillText(`${(level * 100).toFixed(level === 0 || level === 1 ? 0 : 1)}%  ${formatPrice(price, ps.decimals())}`, left + 6, y - 8);
  });
}

function drawPosition(
  ctx: CanvasRenderingContext2D,
  drawing: ChartDrawing,
  x1: number,
  x2: number,
  theme: Theme,
): void {
  const ps = drawing.pane.priceScale;
  const { entry, target, stop } = resolvePositionPrices(drawing);
  const yEntry = ps.yFor(entry);
  const yTarget = ps.yFor(target);
  const yStop = ps.yFor(stop);
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  const width = Math.max(28, right - left);

  ctx.fillStyle = hexToRgba(theme.up, 0.17);
  ctx.fillRect(left, Math.min(yEntry, yTarget), width, Math.abs(yTarget - yEntry));
  ctx.fillStyle = hexToRgba(theme.down, 0.17);
  ctx.fillRect(left, Math.min(yEntry, yStop), width, Math.abs(yStop - yEntry));
  ctx.strokeStyle = theme.text;
  strokeLine(ctx, left, yEntry, left + width, yEntry);

  const targetPct = entry === 0 ? 0 : (Math.abs(target - entry) / entry) * 100;
  const stopPct = entry === 0 ? 0 : (Math.abs(stop - entry) / entry) * 100;
  drawTag(ctx, `${tr('Mục tiêu')} ${targetPct.toFixed(2)}%`, left + 6, yTarget, theme, 'left', theme.up);
  drawTag(ctx, `${tr('Vào lệnh')} ${formatPrice(entry, ps.decimals())}`, left + 6, yEntry, theme, 'left', theme.text, false);
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  const ratio = risk > 0 ? reward / risk : 0;
  drawTag(ctx, `${tr('Dừng')} ${stopPct.toFixed(2)}% · R:R ${ratio.toFixed(2)}`, left + 6, yStop, theme, 'left', theme.down);
}

function drawPriceRange(
  ctx: CanvasRenderingContext2D,
  drawing: ChartDrawing,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  theme: Theme,
  intervalSec: number,
): void {
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  const delta = drawing.end.price - drawing.start.price;
  const pct = drawing.start.price === 0 ? 0 : (delta / drawing.start.price) * 100;
  const bars = Math.abs(drawing.end.index - drawing.start.index);
  const color = delta >= 0 ? theme.measureUp : theme.measureDown;

  ctx.fillStyle = hexToRgba(color, 0.14);
  ctx.fillRect(left, top, width, height);
  ctx.strokeStyle = color;
  ctx.strokeRect(left, top, width, height);
  const sign = delta >= 0 ? '+' : '';
  const text = `${sign}${pct.toFixed(2)}% · ${bars} ${tr('nến')} · ${formatDuration(bars * intervalSec)}`;
  drawTag(ctx, text, left + width / 2, top + height / 2, theme, 'center', color);
}

function drawPlainText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  style: DrawingStyle,
): void {
  ctx.save();
  ctx.font = drawingTextFont(style.fontSize);
  ctx.fillStyle = style.color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const lineHeight = style.fontSize * 1.25;
  for (const [index, line] of text.split('\n').entries()) {
    ctx.fillText(line || ' ', x, y + index * lineHeight);
  }
  ctx.restore();
}

function drawTextNote(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, theme: Theme): void {
  ctx.strokeStyle = theme.textDim;
  strokeLine(ctx, x, y, x + 12, y - 12);
  drawTag(ctx, text, x + 16, y - 16, theme, 'left');
}

function drawTag(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  theme: Theme,
  align: 'left' | 'center' | 'right',
  color = theme.text,
  border = true,
): void {
  ctx.font = DRAWING_FONT;
  const width = ctx.measureText(text).width + 12;
  const height = 22;
  const left = align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;
  const top = y - height / 2;
  ctx.fillStyle = hexToRgba(theme.axisBg, 0.94);
  ctx.beginPath();
  ctx.roundRect(left, top, width, height, 4);
  ctx.fill();
  if (border) {
    ctx.strokeStyle = theme.border;
    ctx.stroke();
  }
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, left + 6, y);
}

function drawHandle(ctx: CanvasRenderingContext2D, x: number, y: number, theme: Theme): void {
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fillStyle = theme.bg;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = theme.measureUp;
  ctx.stroke();
}
