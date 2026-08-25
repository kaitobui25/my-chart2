import { Series, type MinMax, type RenderContext } from '../../core/series';
import type { InstitutionalFlowPoint } from './institutional-flow-model';

export const INSTITUTIONAL_FLOW_ZERO_MIN = 0.2;
export const INSTITUTIONAL_FLOW_ZERO_MAX = 0.8;

export interface InstitutionalFlowSeriesOptions {
  foreignColor: string;
  proprietaryColor: string;
  zeroLineColor?: string;
  zeroLineWidth?: number;
  zeroLineStyle?: 'solid' | 'dashed' | 'dotted';
  zeroPosition?: number;
  barOpacity?: number;
  heightFraction?: number;
  showValues?: boolean;
  labelFontSize?: number;
  labelOpacity?: number;
}

interface StackGeometry {
  positiveTop: number;
  negativeBottom: number;
  positiveValues: Array<{ value: number; color: string }>;
  negativeValues: Array<{ value: number; color: string }>;
}

export interface InstitutionalFlowRegionLayout {
  top: number;
  bottom: number;
  height: number;
  zeroY: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function institutionalFlowRegionLayout(
  paneHeight: number,
  legendHeight: number,
  heightFraction: number,
  zeroPosition: number,
): InstitutionalFlowRegionLayout {
  const top = Math.max(5, legendHeight + 7);
  const available = Math.max(40, paneHeight - top - 6);
  const height = Math.min(available, Math.max(68, paneHeight * clamp(heightFraction, 0.16, 0.48)));
  const position = clamp(zeroPosition, INSTITUTIONAL_FLOW_ZERO_MIN, INSTITUTIONAL_FLOW_ZERO_MAX);
  return {
    top,
    bottom: top + height,
    height,
    zeroY: top + height * position,
  };
}

export function institutionalFlowZeroPositionForY(
  paneY: number,
  paneHeight: number,
  legendHeight: number,
  heightFraction: number,
): number {
  const layout = institutionalFlowRegionLayout(paneHeight, legendHeight, heightFraction, 0.5);
  return clamp(
    (paneY - layout.top) / Math.max(1, layout.height),
    INSTITUTIONAL_FLOW_ZERO_MIN,
    INSTITUTIONAL_FLOW_ZERO_MAX,
  );
}

/**
 * Compact value labels for institutional flow.
 * Billions are the implicit default unit, so only million values carry `tr`.
 */
export function formatInstitutionalFlowValue(value: number): string {
  const sign = value >= 0 ? '+' : '−';
  const billions = Math.abs(value) / 1_000_000_000;
  if (billions >= 1000) {
    const digits = billions >= 10_000 ? 0 : 1;
    return `${sign}${(billions / 1000).toFixed(digits)}k`;
  }
  if (billions >= 1) {
    const digits = billions >= 100 ? 0 : billions >= 10 ? 1 : 2;
    return `${sign}${billions.toFixed(digits)}`;
  }
  const millions = Math.abs(value) / 1_000_000;
  const digits = millions >= 100 ? 0 : millions >= 10 ? 1 : 2;
  return `${sign}${millions.toFixed(digits)} tr`;
}

/**
 * Signed, stacked histogram rendered in a fixed pixel region at the top of the
 * main pane. It deliberately opts out of PriceScale so institutional cash flow
 * can never distort stock-price autoscaling or add values to the price axis.
 */
export class InstitutionalFlowSeries extends Series {
  private data: InstitutionalFlowPoint[] = [];
  private readonly foreignColor: string;
  private readonly proprietaryColor: string;
  private readonly zeroLineColor: string | null;
  private readonly zeroLineWidth: number;
  private readonly zeroLineStyle: 'solid' | 'dashed' | 'dotted';
  private readonly barOpacity: number;
  private readonly heightFraction: number;
  private readonly showValues: boolean;
  private readonly labelFontSize: number;
  private readonly labelOpacity: number;
  private zeroPosition: number;

  constructor(options: InstitutionalFlowSeriesOptions) {
    super();
    this.title = 'Dòng tiền tổ chức';
    this.legendColor = options.foreignColor;
    this.foreignColor = options.foreignColor;
    this.proprietaryColor = options.proprietaryColor;
    this.zeroLineColor = options.zeroLineColor ?? null;
    this.zeroLineWidth = clamp(options.zeroLineWidth ?? 1, 0.5, 3);
    this.zeroLineStyle = options.zeroLineStyle ?? 'solid';
    this.zeroPosition = clamp(options.zeroPosition ?? 0.5, INSTITUTIONAL_FLOW_ZERO_MIN, INSTITUTIONAL_FLOW_ZERO_MAX);
    this.barOpacity = clamp(options.barOpacity ?? 1, 0, 1);
    this.heightFraction = clamp(options.heightFraction ?? 0.28, 0.16, 0.48);
    this.showValues = options.showValues ?? false;
    this.labelFontSize = clamp(options.labelFontSize ?? 8, 6, 14);
    this.labelOpacity = clamp(options.labelOpacity ?? 0.7, 0, 1);
  }

  setData(data: readonly InstitutionalFlowPoint[]): void {
    this.data = [...data];
  }

  getZeroPosition(): number {
    return this.zeroPosition;
  }

  setZeroPosition(position: number): void {
    this.zeroPosition = clamp(position, INSTITUTIONAL_FLOW_ZERO_MIN, INSTITUTIONAL_FLOW_ZERO_MAX);
  }

  zeroLineY(paneHeight: number, legendHeight: number): number {
    return institutionalFlowRegionLayout(
      paneHeight,
      legendHeight,
      this.heightFraction,
      this.zeroPosition,
    ).zeroY;
  }

  hitZeroLine(
    paneY: number,
    paneHeight: number,
    legendHeight: number,
    tolerance = 7,
  ): boolean {
    return Math.abs(paneY - this.zeroLineY(paneHeight, legendHeight)) <= tolerance;
  }

  moveZeroLineTo(paneY: number, paneHeight: number, legendHeight: number): number {
    this.zeroPosition = institutionalFlowZeroPositionForY(
      paneY,
      paneHeight,
      legendHeight,
      this.heightFraction,
    );
    return this.zeroPosition;
  }

  minMax(): MinMax | null {
    return null;
  }

  valueAt(): number | null {
    return null;
  }

  draw(rc: RenderContext): void {
    if (this.data.length === 0) return;
    const start = Math.max(0, Math.floor(rc.from));
    const end = Math.min(this.data.length - 1, Math.ceil(rc.to));
    if (start > end) return;

    let maxPositiveStack = 0;
    let maxNegativeStack = 0;
    for (let index = start; index <= end; index += 1) {
      const point = this.data[index];
      if (!point) continue;
      const foreign = point.foreign ?? 0;
      const proprietary = point.proprietary ?? 0;
      const positive = Math.max(0, foreign) + Math.max(0, proprietary);
      const negative = Math.abs(Math.min(0, foreign) + Math.min(0, proprietary));
      maxPositiveStack = Math.max(maxPositiveStack, positive);
      maxNegativeStack = Math.max(maxNegativeStack, negative);
    }
    if (maxPositiveStack <= 0 && maxNegativeStack <= 0) return;

    const layout = institutionalFlowRegionLayout(
      rc.paneHeight,
      rc.legendHeight,
      this.heightFraction,
      this.zeroPosition,
    );
    const positiveSpace = Math.max(6, layout.zeroY - layout.top - 5);
    const negativeSpace = Math.max(6, layout.bottom - layout.zeroY - 5);
    let valueToPixels = Number.POSITIVE_INFINITY;
    if (maxPositiveStack > 0) valueToPixels = Math.min(valueToPixels, positiveSpace / maxPositiveStack);
    if (maxNegativeStack > 0) valueToPixels = Math.min(valueToPixels, negativeSpace / maxNegativeStack);
    if (!Number.isFinite(valueToPixels) || valueToPixels <= 0) return;

    let barWidth = Math.max(1, Math.round(rc.ts.barSpacing * 0.66));
    if (barWidth > 1 && barWidth % 2 === 0) barWidth -= 1;
    const halfBar = barWidth >> 1;

    const { ctx } = rc;
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = this.zeroLineColor ?? rc.theme.border;
    ctx.lineWidth = this.zeroLineWidth;
    ctx.setLineDash(this.zeroLineStyle === 'dashed' ? [5, 4] : this.zeroLineStyle === 'dotted' ? [1, 3] : []);
    ctx.beginPath();
    ctx.moveTo(0, Math.round(layout.zeroY) + 0.5);
    ctx.lineTo(rc.paneWidth, Math.round(layout.zeroY) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    const geometries = new Map<number, StackGeometry>();
    ctx.globalAlpha *= this.barOpacity;
    for (let index = start; index <= end; index += 1) {
      const point = this.data[index];
      if (!point) continue;
      const x = Math.round(rc.ts.xForIndex(index));
      if (x < -barWidth || x > rc.paneWidth + barWidth) continue;

      let positiveY = layout.zeroY;
      let negativeY = layout.zeroY;
      const geometry: StackGeometry = {
        positiveTop: layout.zeroY,
        negativeBottom: layout.zeroY,
        positiveValues: [],
        negativeValues: [],
      };
      const segments = [
        { value: point.foreign, color: this.foreignColor },
        { value: point.proprietary, color: this.proprietaryColor },
      ];
      for (const segment of segments) {
        if (segment.value === null || segment.value === 0 || !Number.isFinite(segment.value)) continue;
        const height = Math.max(1, Math.abs(segment.value) * valueToPixels);
        ctx.fillStyle = segment.color;
        if (segment.value > 0) {
          const nextY = positiveY - height;
          ctx.fillRect(x - halfBar, nextY, barWidth, Math.max(1, positiveY - nextY));
          positiveY = nextY;
          geometry.positiveTop = nextY;
          geometry.positiveValues.push({ value: segment.value, color: segment.color });
        } else {
          const nextY = negativeY + height;
          ctx.fillRect(x - halfBar, negativeY, barWidth, Math.max(1, nextY - negativeY));
          negativeY = nextY;
          geometry.negativeBottom = nextY;
          geometry.negativeValues.push({ value: segment.value, color: segment.color });
        }
      }
      geometries.set(index, geometry);
    }

    if (this.showValues) {
      ctx.globalAlpha = this.labelOpacity;
      ctx.font = `400 ${this.labelFontSize}px Manrope, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      ctx.textBaseline = 'middle';
      for (const [index, geometry] of geometries) {
        const x = Math.round(rc.ts.xForIndex(index));
        this.drawLabels(ctx, x, geometry.positiveTop - 3, geometry.positiveValues, -Math.PI / 2);
        this.drawLabels(ctx, x, geometry.negativeBottom + 3, geometry.negativeValues, Math.PI / 2);
      }
    }
    ctx.restore();
  }

  private drawLabels(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    values: Array<{ value: number; color: string }>,
    rotation: number,
  ): void {
    if (values.length === 0) return;

    // Values are already stored foreign first, proprietary second. Draw them on
    // one rotated text axis so foreign stays closest to the bar and proprietary
    // starts only after the foreign label plus a readable gap.
    const gap = Math.max(5, this.labelFontSize * 0.8);
    let offset = 0;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.textAlign = 'left';
    for (const item of values) {
      const label = formatInstitutionalFlowValue(item.value);
      ctx.fillStyle = item.color;
      ctx.fillText(label, offset, 0);
      offset += ctx.measureText(label).width + gap;
    }
    ctx.restore();
  }
}
