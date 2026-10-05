export interface CandleRenderingOptions {
  /** Candle body width as a fraction of the current bar spacing. */
  bodyWidthRatio: number;
  /** Lower bound for the rendered body width in CSS pixels. */
  minBodyWidth: number;
  /** Upper bound for the rendered body width in CSS pixels. */
  maxBodyWidth: number;
  /** Hide the body fill for rising candles while keeping the outline. */
  hollowUp: boolean;
  /** Hide the body fill for falling candles while keeping the outline. */
  hollowDown: boolean;
  /** Opacity used for bars outside the active focus window. */
  baseOpacity: number;
  /** Opacity used for bars inside the active focus window. */
  focusOpacity: number;
  /** Number of neighbouring bars on each side of the focused bar. */
  focusRadius: number;
  /** Minimum bar spacing at which high-low wicks remain visible. */
  minWickSpacing: number;
}

export const defaultCandleRenderingOptions: Readonly<CandleRenderingOptions> = Object.freeze({
  bodyWidthRatio: 0.72,
  minBodyWidth: 1,
  maxBodyWidth: 99,
  hollowUp: false,
  hollowDown: false,
  baseOpacity: 1,
  focusOpacity: 1,
  focusRadius: 0,
  minWickSpacing: 1.5,
});

export function normalizeCandleRenderingOptions(
  options: Partial<CandleRenderingOptions> = {},
): CandleRenderingOptions {
  const merged = { ...defaultCandleRenderingOptions, ...options };
  const minBodyWidth = positiveInteger(merged.minBodyWidth, defaultCandleRenderingOptions.minBodyWidth);
  const maxBodyWidth = Math.max(
    minBodyWidth,
    positiveInteger(merged.maxBodyWidth, defaultCandleRenderingOptions.maxBodyWidth),
  );

  return {
    bodyWidthRatio: positiveNumber(merged.bodyWidthRatio, defaultCandleRenderingOptions.bodyWidthRatio),
    minBodyWidth,
    maxBodyWidth,
    hollowUp: Boolean(merged.hollowUp),
    hollowDown: Boolean(merged.hollowDown),
    baseOpacity: clamp01(merged.baseOpacity),
    focusOpacity: clamp01(merged.focusOpacity),
    focusRadius: Math.max(0, Math.round(finiteNumber(merged.focusRadius, 0))),
    minWickSpacing: Math.max(0, finiteNumber(merged.minWickSpacing, defaultCandleRenderingOptions.minWickSpacing)),
  };
}

export function candleBodyWidth(
  barSpacing: number,
  options: CandleRenderingOptions,
): number {
  const desired = Math.round(Math.max(0, barSpacing) * options.bodyWidthRatio);
  let width = Math.max(options.minBodyWidth, Math.min(options.maxBodyWidth, desired));
  if (width > 1 && width % 2 === 0) {
    if (width - 1 >= options.minBodyWidth) width -= 1;
    else if (width + 1 <= options.maxBodyWidth) width += 1;
  }
  return Math.max(1, width);
}

export function candleOpacity(
  index: number,
  focusIndex: number | null,
  options: CandleRenderingOptions,
): number {
  if (focusIndex === null) return options.baseOpacity;
  return Math.abs(index - focusIndex) <= options.focusRadius
    ? options.focusOpacity
    : options.baseOpacity;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, finiteNumber(value, 1)));
}

function positiveInteger(value: number, fallback: number): number {
  return Math.max(1, Math.round(positiveNumber(value, fallback)));
}

function positiveNumber(value: number, fallback: number): number {
  const resolved = finiteNumber(value, fallback);
  return resolved > 0 ? resolved : fallback;
}

function finiteNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}
