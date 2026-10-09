import type { IndicatorDef, ParamDef } from '../registry';
import type { RenderContext } from '../../core/series';
import type { Candle } from '../../core/types';
import type {
  SmcV2EqualLevel,
  SmcV2PeriodLevel,
  SmcV2Result,
  SmcV2Structure,
  SmcV2StructureLine,
  SmcV2Zone,
} from './smart-money-concepts-v2-model';
import {
  calculateSmartMoneyConceptsV2,
  smcV2FibLevels,
  smcV2SwingContext,
  smcV2PremiumDiscountZones,
  type SmcV2Options,
} from './smart-money-concepts-v2-model';

function toggle(key: string, label: string, section: string, value = true): ParamDef {
  return { key, label, type: 'boolean', default: value, section };
}

function selection(
  key: string,
  label: string,
  value: string,
  options: Array<[string, string]>,
  section: string,
): ParamDef {
  return {
    key,
    label,
    type: 'select',
    default: value,
    section,
    options: options.map(([option, text]) => ({ value: option, label: text })),
  };
}

function numberParam(
  key: string,
  label: string,
  type: 'int' | 'float',
  value: number,
  section: string,
  min: number,
  max: number,
  step?: number,
): ParamDef {
  return { key, label, type, default: value, section, min, max, step };
}

function colorParam(key: string, label: string, value: string, section: string): ParamDef {
  return { key, label, type: 'color', default: value, section };
}

const fibDefaults = [
  ['0', 0, '#787b86'], ['236', 0.236, '#f44336'], ['382', 0.382, '#81c784'],
  ['500', 0.5, '#4caf50'], ['618', 0.618, '#009688'], ['786', 0.786, '#64b5f6'], ['1000', 1, '#787b86'],
] as const;
interface FibSetting { enabled: boolean; ratio: number; color: string }

function chartCalendarTimeframe(seconds: number): string | undefined {
  // The chart uses src/interval.ts's 30-day approximation for its supported 1M interval.
  if (seconds === 30 * 86400) return 'M';
  if (seconds === 7 * 86400) return 'W';
  if (seconds === 86400) return 'D';
  return undefined;
}

function showZone(
  rc: RenderContext,
  zone: SmcV2Zone,
  color: string,
  extension = 0,
  split = false,
): void {
  const { ctx, ts, ps, from, to } = rc;
  if (zone.endIndex + extension < from || zone.startIndex > to) return;
  const left = ts.xForIndex(zone.startIndex);
  const rightIndex = zone.endIndex + extension;
  const right = ts.xForIndex(rightIndex);
  const firstY = ps.yFor(zone.top);
  const secondY = ps.yFor(zone.bottom);
  const y = Math.min(firstY, secondY);
  const height = Math.max(1, Math.abs(firstY - secondY));

  ctx.save();
  ctx.globalAlpha *= split ? 0.3 : 0.2;
  ctx.fillStyle = color;
  if (split) {
    ctx.fillRect(left, y, right - left, height / 2);
    ctx.fillRect(left, y + height / 2, right - left, height / 2);
  } else ctx.fillRect(left, y, right - left, height);
  ctx.restore();

  ctx.save();
  ctx.globalAlpha *= split ? 0.3 : 0.2;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  if (split) {
    ctx.strokeRect(left, y, right - left, height / 2);
    ctx.strokeRect(left, y + height / 2, right - left, height / 2);
  } else ctx.strokeRect(left, y, right - left, height);
  ctx.restore();
}

function showStructure(
  rc: RenderContext,
  event: SmcV2Structure,
  color: string,
): void {
  const { ctx, ts, ps, from, to } = rc;
  if (event.index < from || event.originIndex > to) return;
  const x1 = ts.xForIndex(event.originIndex);
  const x2 = ts.xForIndex(event.index);
  const y = ps.yFor(event.price);

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = event.scope === 'swing' ? 1.25 : 1;
  ctx.setLineDash(event.scope === 'internal' ? [6, 4] : []);
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.font = `600 ${event.scope === 'swing' ? 10 : 8}px Manrope, -apple-system, BlinkMacSystemFont, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = event.direction === 'bullish' ? 'bottom' : 'top';
  ctx.fillText(event.type, (x1 + x2) / 2, y + (event.direction === 'bullish' ? -2 : 2));
  ctx.restore();
}

function showStructureLine(rc: RenderContext, line: SmcV2StructureLine, style: string, color: string): void {
  const { ctx, ts, ps, from, to } = rc;
  if (line.toIndex < from || line.fromIndex > to) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = line.scope === 'internal' ? 1 : 3;
  ctx.setLineDash(style === 'dashed' ? [6, 4] : style === 'dotted' ? [2, 3] : []);
  ctx.beginPath();
  ctx.moveTo(ts.xForIndex(line.fromIndex), ps.yFor(line.fromPrice));
  ctx.lineTo(ts.xForIndex(line.toIndex), ps.yFor(line.toPrice));
  ctx.stroke();
  ctx.restore();
}

function showEqualLevel(rc: RenderContext, level: SmcV2EqualLevel, color: string): void {
  const { ctx, ts, ps, from, to } = rc;
  if (level.index < from || level.firstIndex > to) return;
  const bullish = level.label === 'EQL';
  const y = ps.yFor(level.price);
  const x1 = ts.xForIndex(level.firstIndex);
  const x2 = ts.xForIndex(level.index);

  ctx.save();
  ctx.strokeStyle = color;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(x1, ps.yFor(level.firstPrice));
  ctx.lineTo(x2, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.font = '600 9px Manrope, -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = bullish ? 'top' : 'bottom';
  ctx.fillText(level.label, (x1 + x2) / 2, y + (bullish ? 2 : -2));
  ctx.restore();
}

function showPeriodLevel(rc: RenderContext, level: SmcV2PeriodLevel, color: string, style: string): void {
  const { ctx, ts, ps, from, to } = rc;
  if (level.endIndex < from || level.startIndex > to) return;
  const x2 = ts.xForIndex(level.endIndex + 20);

  ctx.save();
  ctx.strokeStyle = color;
  ctx.setLineDash(style === 'dashed' ? [6, 4] : style === 'dotted' ? [2, 3] : []);
  ctx.lineWidth = 1;
  ctx.font = '600 9px Manrope, -apple-system, BlinkMacSystemFont, sans-serif';
  for (const [price, suffix, baseline, origin] of [
    [level.high, 'H', 'bottom', level.highIndex],
    [level.low, 'L', 'top', level.lowIndex],
  ] as const) {
    const y = ps.yFor(price);
    ctx.beginPath();
    ctx.moveTo(ts.xForIndex(origin), y);
    ctx.lineTo(x2, y);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = baseline;
    ctx.fillText(`P${level.label}${suffix}`, x2 + 3, y);
  }
  ctx.restore();
}

function showPivots(
  rc: RenderContext,
  data: SmcV2Result,
  options: {
    swingPivots: boolean;
    internalPivots: boolean;
    strongWeak: boolean;
    bullishColor: string;
    bearishColor: string;
    monochrome: boolean;
    present: boolean;
    internalBullColor: string;
    internalBearColor: string;
  },
): void {
  const { ctx, ts, ps, from, to } = rc;
  ctx.save();
  ctx.font = '600 9px Manrope, -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'center';
  const latestPivots = new Map<string, typeof data.pivots[number]>();
  if (options.present) {
    for (const pivot of data.pivots) latestPivots.set(`${pivot.scope}:${pivot.direction}`, pivot);
  }
  for (const pivot of data.pivots) {
    const isInternal = pivot.scope === 'internal';
    if (isInternal ? !options.internalPivots : !options.swingPivots) continue;
    if (pivot.index < from || pivot.index > to) continue;
    if (options.present && latestPivots.get(`${pivot.scope}:${pivot.direction}`) !== pivot) continue;
    if (!isInternal && data.barStates[pivot.confirmedAt]?.atr == null) continue;
    const bullish = pivot.direction === 'bullish';
    ctx.fillStyle = isInternal ? (bullish ? options.internalBullColor : options.internalBearColor) : options.monochrome
      ? (bullish ? '#b2b5be' : '#5d606b')
      : (bullish ? options.bullishColor : options.bearishColor);
    ctx.textBaseline = bullish ? 'top' : 'bottom';
    ctx.fillText(
      pivot.label,
      ts.xForIndex(pivot.index),
      ps.yFor(pivot.price + (isInternal ? 0 : (bullish ? -0.5 : 0.5) * (data.barStates[pivot.confirmedAt]?.atr ?? 0))),
    );
  }

  const context = smcV2SwingContext(data);
  if (options.strongWeak) {
    const rightX = ts.xForIndex(data.barStates.length - 1 + 20);
    ctx.textAlign = 'left';
    for (const [point, high] of [[context.high, true], [context.low, false]] as const) {
      if (!point) continue;
      const color = options.monochrome ? (high ? '#5d606b' : '#b2b5be') : (high ? options.bearishColor : options.bullishColor);
      const y = ps.yFor(point.price);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(ts.xForIndex(point.index), y);
      ctx.lineTo(rightX, y);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.textBaseline = high ? 'bottom' : 'top';
      const strong = high ? context.bias === -1 : context.bias === 1;
      ctx.fillText(`${strong ? 'Strong' : 'Weak'} ${high ? 'High' : 'Low'}`, rightX, y);
    }
  }
  ctx.restore();
}

function showPremiumDiscount(
  rc: RenderContext,
  data: SmcV2Result,
  colors: { premium: string; equilibrium: string; discount: string },
): void {
  const { ctx, ts, ps } = rc;
  const { high, low, rangeAnchorIndex } = smcV2SwingContext(data);
  if (!high || !low) return;
  const top = Math.max(high.price, low.price);
  const bottom = Math.min(high.price, low.price);
  const equilibrium = (top + bottom) / 2;
  const leftIndex = rangeAnchorIndex ?? 0;
  const left = ts.xForIndex(leftIndex);
  const right = ts.xForIndex(data.barStates.length - 1);
  const yMiddle = ps.yFor(equilibrium);
  const x = Math.min(left, right);
  const width = Math.abs(right - left);

  ctx.save();
  ctx.globalAlpha *= 0.2;
  for (const zone of smcV2PremiumDiscountZones(data)) {
    const y1 = ps.yFor(zone.top);
    const y2 = ps.yFor(zone.bottom);
    ctx.fillStyle = zone.label === 'Premium' ? colors.premium : zone.label === 'Discount' ? colors.discount : colors.equilibrium;
    ctx.fillRect(x, Math.min(y1, y2), width, Math.abs(y2 - y1));
  }
  ctx.restore();

  ctx.save();
  ctx.font = '600 9px Manrope, -apple-system, BlinkMacSystemFont, sans-serif';
  const middleX = ts.xForIndex(Math.round((leftIndex + data.barStates.length - 1) / 2));
  for (const [text, color, labelX, labelY, baseline] of [
    ['Premium', colors.premium, middleX, ps.yFor(high.price), 'bottom'],
    ['Equilibrium', colors.equilibrium, right, yMiddle, 'middle'],
    ['Discount', colors.discount, middleX, ps.yFor(low.price), 'top'],
  ] as const) {
    ctx.fillStyle = color;
    ctx.textAlign = text === 'Equilibrium' ? 'left' : 'center';
    ctx.textBaseline = baseline;
    ctx.fillText(text, labelX, labelY);
  }
  ctx.restore();
}

function showFibonacci(
  rc: RenderContext,
  data: SmcV2Result,
  direction: 'auto' | 'high-to-low' | 'low-to-high',
  extendRight: boolean,
  showLabels: boolean,
  settings: FibSetting[],
  transparency: number,
): void {
  const { ctx, ts, ps, to } = rc;
  const enabled = settings.filter(setting => setting.enabled);
  const levels = smcV2FibLevels(data, direction, undefined, enabled.map(setting => setting.ratio));
  const { high, low, bias } = smcV2SwingContext(data);
  if (!levels.length || !high || !low) return;
  const highToLow = direction === 'high-to-low' || (direction === 'auto' && bias === -1);
  const leftIndex = highToLow ? high.index : low.index;
  const anchorEndIndex = highToLow ? low.index : high.index;
  const left = ts.xForIndex(extendRight ? Math.min(leftIndex, anchorEndIndex) : leftIndex);
  const right = ts.xForIndex(data.barStates.length - 1);
  const lineEndX = extendRight ? Math.max(right, ts.xForIndex(to), rc.paneWidth) : ts.xForIndex(anchorEndIndex);
  const labelX = extendRight ? right : ts.xForIndex(anchorEndIndex);
  const atr14 = smcV2SwingContext(data).atr14;
  const labelOffset = (atr14 ?? 0) * 0.5;

  ctx.save();
  ctx.font = '600 9px Manrope, -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'left';
  for (let index = 1; index < levels.length; index++) {
    const y1 = ps.yFor(levels[index - 1].price);
    const y2 = ps.yFor(levels[index].price);
    ctx.fillStyle = enabled[index].color;
    ctx.globalAlpha = 1 - transparency / 100;
    ctx.fillRect(Math.min(left, lineEndX), Math.min(y1, y2), Math.abs(lineEndX - left), Math.abs(y2 - y1));
  }
  for (let index = 0; index < levels.length; index++) {
    const level = levels[index];
    const y = ps.yFor(level.price);
    ctx.strokeStyle = enabled[index].color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(lineEndX, y);
    ctx.stroke();
    if (showLabels && atr14 !== null) {
      ctx.fillStyle = enabled[index].color;
      ctx.globalAlpha = 1;
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${level.ratio} (${level.price.toFixed(ps.decimals())})`, labelX, ps.yFor(level.price + labelOffset));
    }
  }
  ctx.restore();
}

function drawSmcV2(
  rc: RenderContext,
  data: SmcV2Result,
  display: {
    mode: string;
    style: string;
    internal: boolean;
    swing: boolean;
    internalBullType: string;
    internalBearType: string;
    swingBullType: string;
    swingBearType: string;
    internalLineStyle: string;
    swingLineStyle: string;
    internalLineColor: string;
    swingLineColor: string;
    internalLine: boolean;
    swingLine: boolean;
    internalBullColor: string;
    internalBearColor: string;
    swingBullColor: string;
    swingBearColor: string;
    internalPivots: boolean;
    swingPivots: boolean;
    strongWeak: boolean;
    orderBlocks: boolean;
    internalOrderBlockCount: number;
    swingOrderBlockCount: number;
    bullOrderBlockColor: string;
    bearOrderBlockColor: string;
    bullSwingBlockColor: string;
    bearSwingBlockColor: string;
    equalLevels: boolean;
    fairValueGaps: boolean;
    bullFairValueGapColor: string;
    bearFairValueGapColor: string;
    fvgExtend: number;
    premiumDiscount: boolean;
    premiumColor: string;
    equilibriumColor: string;
    discountColor: string;
    fib: boolean;
    fibDirection: 'auto' | 'high-to-low' | 'low-to-high';
    fibExtendRight: boolean;
    fibShowLabels: boolean;
    fibSettings: FibSetting[];
    fibTransparency: number;
    periodStyles: Record<'D' | 'W' | 'M', { color: string; style: string }>;
    internalTrend: string;
    swingTrend: string;
    internalTrendBull: string;
    internalTrendBear: string;
    swingTrendBull: string;
    swingTrendBear: string;
  },
  candles: readonly Candle[],
): void {
  // Pine plots trend colors before updating structure bias on this bar.
  for (let index = rc.from; index <= rc.to && index < candles.length; index++) {
    const previous = data.barStates[index - 1];
    const colorFor = (scope: 'internal' | 'swing') => scope === 'internal'
      ? (previous?.internalBias === 1 ? display.internalTrendBull : display.internalTrendBear)
      : (previous?.bias === 1 ? display.swingTrendBull : display.swingTrendBear);
    const backgroundScope = display.internalTrend === 'background' ? 'internal' : display.swingTrend === 'background' ? 'swing' : null;
    const candleScope = display.internalTrend === 'candles' ? 'internal' : display.swingTrend === 'candles' ? 'swing' : null;
    if (!backgroundScope && !candleScope) break;
    const { ctx, ts, ps } = rc;
    const x = ts.xForIndex(index);
    ctx.save();
    ctx.globalAlpha *= 0.5;
    if (backgroundScope) {
      ctx.fillStyle = colorFor(backgroundScope);
      ctx.fillRect(x - ts.barSpacing / 2, 0, ts.barSpacing, rc.paneHeight);
    }
    if (candleScope) {
      const candle = candles[index];
      ctx.fillStyle = ctx.strokeStyle = colorFor(candleScope);
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x, ps.yFor(candle.high));
      ctx.lineTo(x, ps.yFor(candle.low));
      ctx.stroke();
      const y1 = ps.yFor(candle.open);
      const y2 = ps.yFor(candle.close);
      const width = Math.max(1, ts.barSpacing * 0.7);
      ctx.fillRect(x - width / 2, Math.min(y1, y2), width, Math.max(1, Math.abs(y2 - y1)));
    }
    ctx.restore();
  }
  if (display.fairValueGaps) {
    for (const gap of data.fairValueGaps) {
      showZone(
        rc,
        gap,
        display.style === 'monochrome' ? (gap.direction === 'bullish' ? '#b2b5be' : '#5d606b') : gap.direction === 'bullish' ? display.bullFairValueGapColor : display.bearFairValueGapColor,
        display.fvgExtend,
        true,
      );
    }
  }
  if (display.orderBlocks) {
    const counts = { internal: 0, swing: 0 };
    for (const block of data.orderBlocks) {
      const scope = block.scope ?? 'swing';
      const maximum = scope === 'internal' ? display.internalOrderBlockCount : display.swingOrderBlockCount;
      if (counts[scope]++ >= maximum) continue;
      const bullish = block.direction === 'bullish';
      const color = display.style === 'monochrome' ? (bullish ? '#b2b5be' : '#5d606b') : block.scope === 'internal'
        ? (bullish ? display.bullOrderBlockColor : display.bearOrderBlockColor)
        : (bullish ? display.bullSwingBlockColor : display.bearSwingBlockColor);
      showZone(rc, block, color);
    }
  }
  if (display.equalLevels) {
    const latestEqualLevels = display.mode === 'present'
      ? [...data.equalLevels.reduce((latest, level) => {
          const previous = latest.get(level.label);
          if (!previous || level.confirmedAt > previous.confirmedAt) latest.set(level.label, level);
          return latest;
        }, new Map<SmcV2EqualLevel['label'], SmcV2EqualLevel>()).values()]
      : data.equalLevels;
    for (const level of latestEqualLevels) {
      const bullish = level.label === 'EQL';
      showEqualLevel(
        rc,
        level,
        display.style === 'monochrome'
          ? (bullish ? '#b2b5be' : '#5d606b')
          : (bullish ? display.swingBullColor : display.swingBearColor),
      );
    }
  }
  for (const level of data.periodLevels) showPeriodLevel(rc, level, display.periodStyles[level.label].color, display.periodStyles[level.label].style);
  if (display.premiumDiscount) {
    showPremiumDiscount(rc, data, {
      premium: display.style === 'monochrome' ? '#5d606b' : display.premiumColor,
      equilibrium: display.equilibriumColor,
      discount: display.style === 'monochrome' ? '#b2b5be' : display.discountColor,
    });
  }
  if (display.fib) {
    showFibonacci(rc, data, display.fibDirection, display.fibExtendRight, display.fibShowLabels, display.fibSettings, display.fibTransparency);
  }

  const visibleEvents = data.structures.filter(event => {
    const visible = event.scope === 'internal' ? display.internal : display.swing;
    const bullish = event.direction === 'bullish';
    const filter = event.scope === 'internal'
      ? (bullish ? display.internalBullType : display.internalBearType)
      : (bullish ? display.swingBullType : display.swingBearType);
    return visible && (filter === 'all' || filter === event.type);
  });
  const latestEvents = display.mode === 'present'
    ? visibleEvents.reduce((latest, event) => {
        const key = `${event.scope}:${event.direction}`;
        const previous = latest.get(key);
        if (!previous || event.index > previous.index) latest.set(key, event);
        return latest;
      }, new Map<string, SmcV2Structure>())
    : null;
  for (const line of data.structureLines) {
    if (line.supersededAt !== undefined && line.supersededAt < data.barStates.length) continue;
    if (line.scope === 'internal' ? display.internalLine : display.swingLine) {
      showStructureLine(rc, line,
        line.scope === 'internal' ? display.internalLineStyle : display.swingLineStyle,
        line.scope === 'internal' ? display.internalLineColor : display.swingLineColor);
    }
  }
  for (const event of visibleEvents) {
    const bullish = event.direction === 'bullish';
    if (latestEvents && latestEvents.get(`${event.scope}:${event.direction}`) !== event) continue;
    const color = display.style === 'monochrome'
      ? (bullish ? '#b2b5be' : '#5d606b')
      : event.scope === 'internal'
        ? (bullish ? display.internalBullColor : display.internalBearColor)
        : (bullish ? display.swingBullColor : display.swingBearColor);
    showStructure(rc, event, color);
  }
  showPivots(rc, data, {
    internalPivots: display.internalPivots,
    swingPivots: display.swingPivots,
    strongWeak: display.strongWeak,
    bullishColor: display.swingBullColor,
    bearishColor: display.swingBearColor,
    monochrome: display.style === 'monochrome',
    present: display.mode === 'present',
    internalBullColor: display.internalBullColor,
    internalBearColor: display.internalBearColor,
  });
}

/** Shared settings, rendering and timeframe lifecycle for the SMC family. */
export function createSmcIndicator(
  identity: { id: string; name: string; title: string; order: number },
  calculate: typeof calculateSmartMoneyConceptsV2 = (candles, options) => calculateSmartMoneyConceptsV2(candles, options),
): IndicatorDef {
const def: IndicatorDef = {
  id: identity.id,
  name: identity.name,
  category: 'overlay',
  order: identity.order,
  params: [
    ...(['internal', 'swing'] as const).flatMap(scope => [
      selection(`${scope}Trend`, `${scope} trend`, 'none', [['none', 'None'], ['candles', 'Candles'], ['background', 'Background']], 'Trend colors'),
      colorParam(`${scope}TrendBull`, 'Bullish', '#089981', 'Trend colors'),
      colorParam(`${scope}TrendBear`, 'Bearish', '#f23645', 'Trend colors'),
    ]),
    ...(['D', 'W', 'M'] as const).flatMap(frame => [
      selection(`period${frame}Style`, `${frame} line style`, 'solid', [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']], 'Period levels'),
      colorParam(`period${frame}Color`, `${frame} color`, '#2157f3', 'Period levels'),
    ]),
    numberParam('fibTransparency', 'Fill transparency', 'int', 90, 'Fibonacci levels', 0, 100),
    ...fibDefaults.flatMap(([key, ratio, color]) => [
      toggle(`showFib${key}`, `Show ${ratio}`, 'Fibonacci levels'),
      numberParam(`fibValue${key}`, `Ratio ${ratio}`, 'float', ratio, 'Fibonacci levels', -10, 10, 0.001),
      colorParam(`fibColor${key}`, `Color ${ratio}`, color, 'Fibonacci levels'),
    ]),
    selection('mode', 'Chế độ hiển thị', 'historical', [
      ['historical', 'Toàn bộ lịch sử'],
      ['present', 'Tín hiệu gần nhất'],
    ], '⚙️ Cài đặt chung'),
    selection('style', 'Bảng màu', 'colored', [
      ['colored', 'Màu sắc'],
      ['monochrome', 'Đơn sắc'],
    ], '⚙️ Cài đặt chung'),

    toggle('showInternal', 'Hiển thị cấu trúc Internal', '📌 Cấu trúc Internal'),
    selection('internalBullType', 'Cấu trúc tăng', 'all', [['all', 'Tất cả'], ['BOS', 'BOS'], ['CHoCH', 'CHoCH']], '📌 Cấu trúc Internal'),
    colorParam('internalBullColor', 'Màu cấu trúc tăng', '#089981', '📌 Cấu trúc Internal'),
    selection('internalBearType', 'Cấu trúc giảm', 'all', [['all', 'Tất cả'], ['BOS', 'BOS'], ['CHoCH', 'CHoCH']], '📌 Cấu trúc Internal'),
    colorParam('internalBearColor', 'Màu cấu trúc giảm', '#f23645', '📌 Cấu trúc Internal'),
    toggle('internalConfluence', 'Bộ lọc Confluence', '📌 Cấu trúc Internal', false),
    toggle('internalLine', 'Hiển thị đường cấu trúc', '📌 Cấu trúc Internal'),
    colorParam('internalLineColor', 'Màu đường cấu trúc', '#ffff00', '📌 Cấu trúc Internal'),
    selection('internalLineStyle', 'Kiểu đường cấu trúc', 'dotted', [['solid', 'Liền'], ['dashed', 'Gạch'], ['dotted', 'Chấm']], '📌 Cấu trúc Internal'),
    toggle('showInternalPivots', 'Hiển thị Pivot Internal', '📌 Cấu trúc Internal', false),
    numberParam('internalLength', 'Độ dài Pivot Internal', 'int', 5, '📌 Cấu trúc Internal', 2, 50),

    toggle('showSwing', 'Hiển thị cấu trúc Swing', '🏔️ Cấu trúc Swing', false),
    selection('swingBullType', 'Cấu trúc tăng', 'all', [['all', 'Tất cả'], ['BOS', 'BOS'], ['CHoCH', 'CHoCH']], '🏔️ Cấu trúc Swing'),
    colorParam('swingBullColor', 'Màu cấu trúc tăng', '#089981', '🏔️ Cấu trúc Swing'),
    selection('swingBearType', 'Cấu trúc giảm', 'all', [['all', 'Tất cả'], ['BOS', 'BOS'], ['CHoCH', 'CHoCH']], '🏔️ Cấu trúc Swing'),
    colorParam('swingBearColor', 'Màu cấu trúc giảm', '#f23645', '🏔️ Cấu trúc Swing'),
    toggle('swingLine', 'Hiển thị đường cấu trúc', '🏔️ Cấu trúc Swing', false),
    colorParam('swingLineColor', 'Màu đường cấu trúc', '#800080', '🏔️ Cấu trúc Swing'),
    selection('swingLineStyle', 'Kiểu đường cấu trúc', 'solid', [['solid', 'Liền'], ['dashed', 'Gạch'], ['dotted', 'Chấm']], '🏔️ Cấu trúc Swing'),
    toggle('showSwingPivots', 'Hiển thị Pivot Swing', '🏔️ Cấu trúc Swing', false),
    numberParam('swingLength', 'Độ dài Pivot Swing', 'int', 50, '🏔️ Cấu trúc Swing', 10, 200),
    toggle('showStrongWeak', 'Hiển thị đỉnh / đáy mạnh-yếu', '🏔️ Cấu trúc Swing'),

    toggle('showInternalOrderBlocks', 'Hiển thị OB Internal', '🧱 Order Blocks'),
    numberParam('internalOrderBlockCount', 'Số OB Internal', 'int', 5, '🧱 Order Blocks', 1, 20),
    toggle('showSwingOrderBlocks', 'Hiển thị OB Swing', '🧱 Order Blocks', false),
    numberParam('swingOrderBlockCount', 'Số OB Swing', 'int', 5, '🧱 Order Blocks', 1, 20),
    selection('orderBlockFilter', 'Bộ lọc OB', 'atr', [['atr', 'ATR'], ['range', 'Biên độ trung bình']], '🧱 Order Blocks'),
    selection('mitigation', 'Cách vô hiệu OB', 'wick', [['close', 'Giá đóng cửa'], ['wick', 'Râu nến (High/Low)']], '🧱 Order Blocks'),
    colorParam('bullOrderBlockColor', 'OB Internal tăng', '#3179f5', '🧱 Order Blocks'),
    colorParam('bearOrderBlockColor', 'OB Internal giảm', '#f77c80', '🧱 Order Blocks'),
    colorParam('bullSwingBlockColor', 'OB Swing tăng', '#1848cc', '🧱 Order Blocks'),
    colorParam('bearSwingBlockColor', 'OB Swing giảm', '#b22833', '🧱 Order Blocks'),

    toggle('showEqualLevels', 'Hiển thị Equal High / Low', '⚖️ Equal High / Low'),
    numberParam('equalLength', 'Số nến xác nhận', 'int', 3, '⚖️ Equal High / Low', 1, 20),
    numberParam('equalThreshold', 'Ngưỡng nhạy', 'float', 0.1, '⚖️ Equal High / Low', 0, 0.5, 0.1),

    toggle('showFairValueGaps', 'Hiển thị FVG', '🟩 Fair Value Gaps (FVG)', false),
    toggle('filterFairValueGaps', 'Tự động lọc FVG nhỏ', '🟩 Fair Value Gaps (FVG)'),
    selection('fvgTimeframe', 'Khung thời gian', 'chart', [['chart', 'Khung biểu đồ'],
      ['1', '1m'], ['3', '3m'], ['5', '5m'], ['15', '15m'], ['30', '30m'],
      ['60', '1h'], ['120', '2h'], ['240', '4h'], ['D', '1D'], ['W', '1W'], ['M', '1M']], '🟩 Fair Value Gaps (FVG)'),
    colorParam('bullFairValueGapColor', 'FVG tăng', '#00c853', '🟩 Fair Value Gaps (FVG)'),
    colorParam('bearFairValueGapColor', 'FVG giảm', '#ff1744', '🟩 Fair Value Gaps (FVG)'),
    numberParam('fvgExtend', 'Kéo dài FVG (nến)', 'int', 3, '🟩 Fair Value Gaps (FVG)', 0, 100),

    toggle('showDailyLevels', 'Hiển thị mức ngày trước', '📅 Đỉnh / Đáy đa khung', false),
    toggle('showWeeklyLevels', 'Hiển thị mức tuần trước', '📅 Đỉnh / Đáy đa khung', false),
    toggle('showMonthlyLevels', 'Hiển thị mức tháng trước', '📅 Đỉnh / Đáy đa khung', false),
    numberParam('periodUtcOffsetHours', 'Múi giờ UTC lệch (giờ)', 'float', 0, '📅 Đỉnh / Đáy đa khung', -12, 14, 0.5),

    toggle('showPremiumDiscount', 'Hiển thị vùng Premium / Discount', '🎯 Vùng Premium / Discount', false),
    colorParam('premiumColor', 'Premium', '#f23645', '🎯 Vùng Premium / Discount'),
    colorParam('equilibriumColor', 'Equilibrium', '#878b94', '🎯 Vùng Premium / Discount'),
    colorParam('discountColor', 'Discount', '#089981', '🎯 Vùng Premium / Discount'),

    toggle('showFib', 'Hiển thị Fibonacci Retracement', '📐 Fibonacci Retracement', false),
    selection('fibDirection', 'Hướng Fib', 'auto', [
      ['auto', 'Theo xu hướng Swing'],
      ['high-to-low', 'Đỉnh mạnh → Đáy yếu'],
      ['low-to-high', 'Đáy mạnh → Đỉnh yếu'],
    ], '📐 Fibonacci Retracement'),
    toggle('fibExtendRight', 'Kéo dài sang phải', '📐 Fibonacci Retracement'),
    toggle('fibShowLabels', 'Hiển thị nhãn mức Fib', '📐 Fibonacci Retracement'),
  ],
  create(chart, params) {
    const analysisOptions: SmcV2Options = {
      swingLength: Number(params.swingLength),
      internalLength: Number(params.internalLength),
      internalConfluence: params.internalConfluence === true,
      equalLength: Number(params.equalLength),
      equalThreshold: Number(params.equalThreshold),
      showInternalPivots: params.showInternalPivots === true,
      showSwingPivots: params.showSwingPivots === true,
      showInternal: params.showInternal === true,
      showSwing: params.showSwing === true,
      showStrongWeak: params.showStrongWeak === true,
      showPremiumDiscount: params.showPremiumDiscount === true,
      showFib: params.showFib === true,
      showEqualLevels: params.showEqualLevels === true,
      showDailyLevels: params.showDailyLevels === true,
      showWeeklyLevels: params.showWeeklyLevels === true,
      showMonthlyLevels: params.showMonthlyLevels === true,
      showInternalOrderBlocks: params.showInternalOrderBlocks === true,
      showSwingOrderBlocks: params.showSwingOrderBlocks === true,
      internalOrderBlockCount: Number(params.internalOrderBlockCount),
      swingOrderBlockCount: Number(params.swingOrderBlockCount),
      mitigation: String(params.mitigation) as SmcV2Options['mitigation'],
      orderBlockFilter: String(params.orderBlockFilter) as SmcV2Options['orderBlockFilter'],
      showFairValueGaps: params.showFairValueGaps === true,
      filterFairValueGaps: params.filterFairValueGaps === true,
      fvgTimeframe: String(params.fvgTimeframe),
      chartIntervalSeconds: chart.getIntervalSec(),
      chartTimeframe: chartCalendarTimeframe(chart.getIntervalSec()),
      periodUtcOffsetHours: Number(params.periodUtcOffsetHours),
    };
    const display = {
      mode: String(params.mode),
      style: String(params.style),
      internal: params.showInternal === true,
      swing: params.showSwing === true,
      internalLine: params.internalLine === true,
      swingLine: params.swingLine === true,
      internalBullType: String(params.internalBullType),
      internalBearType: String(params.internalBearType),
      swingBullType: String(params.swingBullType),
      swingBearType: String(params.swingBearType),
      internalLineStyle: String(params.internalLineStyle),
      swingLineStyle: String(params.swingLineStyle),
      internalLineColor: String(params.internalLineColor ?? '#ffff00'),
      swingLineColor: String(params.swingLineColor ?? '#800080'),
      internalBullColor: String(params.internalBullColor),
      internalBearColor: String(params.internalBearColor),
      swingBullColor: String(params.swingBullColor),
      swingBearColor: String(params.swingBearColor),
      internalPivots: analysisOptions.showInternalPivots,
      swingPivots: analysisOptions.showSwingPivots,
      strongWeak: params.showStrongWeak === true,
      orderBlocks: analysisOptions.showInternalOrderBlocks || analysisOptions.showSwingOrderBlocks,
      internalOrderBlockCount: analysisOptions.internalOrderBlockCount,
      swingOrderBlockCount: analysisOptions.swingOrderBlockCount,
      bullOrderBlockColor: String(params.bullOrderBlockColor),
      bearOrderBlockColor: String(params.bearOrderBlockColor),
      bullSwingBlockColor: String(params.bullSwingBlockColor),
      bearSwingBlockColor: String(params.bearSwingBlockColor),
      equalLevels: analysisOptions.showEqualLevels,
      fairValueGaps: analysisOptions.showFairValueGaps,
      bullFairValueGapColor: String(params.bullFairValueGapColor),
      bearFairValueGapColor: String(params.bearFairValueGapColor),
      fvgExtend: Number(params.fvgExtend),
      premiumDiscount: params.showPremiumDiscount === true,
      premiumColor: String(params.premiumColor),
      equilibriumColor: String(params.equilibriumColor),
      discountColor: String(params.discountColor),
      fib: params.showFib === true,
      fibDirection: String(params.fibDirection) as 'auto' | 'high-to-low' | 'low-to-high',
      fibExtendRight: params.fibExtendRight === true,
      fibShowLabels: params.fibShowLabels === true,
      fibSettings: fibDefaults.map(([key, ratio, color]) => ({ enabled: params[`showFib${key}`] !== false,
        ratio: Number(params[`fibValue${key}`] ?? ratio), color: String(params[`fibColor${key}`] ?? color) })),
      fibTransparency: Number(params.fibTransparency ?? 90),
      periodStyles: Object.fromEntries(['D', 'W', 'M'].map(frame => [frame, {
        style: String(params[`period${frame}Style`] ?? 'solid'), color: String(params[`period${frame}Color`] ?? '#2157f3'),
      }])) as Record<'D' | 'W' | 'M', { color: string; style: string }>,
      internalTrend: String(params.internalTrend ?? 'none'),
      swingTrend: String(params.swingTrend ?? 'none'),
      internalTrendBull: String(params.internalTrendBull ?? '#089981'),
      internalTrendBear: String(params.internalTrendBear ?? '#f23645'),
      swingTrendBull: String(params.swingTrendBull ?? '#089981'),
      swingTrendBear: String(params.swingTrendBear ?? '#f23645'),
    };
    const requestedFvg = analysisOptions.showFairValueGaps && analysisOptions.fvgTimeframe !== 'chart';
    let data = calculate(chart.getCandles(), {
      ...analysisOptions, showFairValueGaps: analysisOptions.showFairValueGaps && !requestedFvg,
    });
    const overlay = chart.addOverlay({
      title: identity.title,
      draw: (rc) => drawSmcV2(rc, data, display, chart.getCandles()),
    });
    let removed = false;
    let generation = 0;
    let requestKey = '';
    let firstCandle: Candle | undefined;
    const recompute = () => {
      analysisOptions.chartIntervalSeconds = chart.getIntervalSec();
      analysisOptions.chartTimeframe = chartCalendarTimeframe(chart.getIntervalSec());
      const candles = chart.getCandles();
      const key = `${candles.length}:${candles[0]?.time}:${candles[candles.length - 1]?.time}:${chart.getIntervalSec()}`;
      if (key !== requestKey || firstCandle !== candles[0]) {
        const reset = firstCandle !== candles[0];
        requestKey = key;
        firstCandle = candles[0];
        const currentGeneration = ++generation;
        overlay.title = identity.title;
        if (reset) {
          analysisOptions.fvgCandles = undefined;
          analysisOptions.periodCandles = {};
        }
        const frames = new Set<string>();
        if (requestedFvg) frames.add(analysisOptions.fvgTimeframe!);
        if (analysisOptions.showDailyLevels && chart.getIntervalSec() <= 86400) frames.add('D');
        if (analysisOptions.showWeeklyLevels && chart.getIntervalSec() <= 7 * 86400) frames.add('W');
        if (analysisOptions.showMonthlyLevels && chart.getIntervalSec() <= 30 * 86400) frames.add('M');
        for (const frame of frames) {
          const request = chart.getIndicatorCandles?.(frame);
          if (!request) {
            if (requestedFvg && frame === analysisOptions.fvgTimeframe) overlay.title = `${identity.title} · timeframe provider unavailable`;
            continue;
          }
          void request.then(bars => {
            if (removed || generation !== currentGeneration) return;
            if (!bars.length) throw new Error(`No provider candles for ${frame}`);
            if (frame === analysisOptions.fvgTimeframe) analysisOptions.fvgCandles = bars;
            if (frame === 'D' || frame === 'W' || frame === 'M') analysisOptions.periodCandles![frame] = bars;
            updateData();
            chart.invalidate();
          }).catch(error => {
            if (removed || generation !== currentGeneration) return;
            overlay.title = `${identity.title} · ${String(error instanceof Error ? error.message : error)}`;
            chart.invalidate();
          });
        }
      }
      updateData();
    };
    const updateData = () => {
      // A lower-timeframe request must wait for real provider intrabars.
      data = calculate(chart.getCandles(), {
        ...analysisOptions,
        showFairValueGaps: analysisOptions.showFairValueGaps && (!requestedFvg || !!analysisOptions.fvgCandles),
      });
    };
    recompute();
    return {
      recompute,
      getDebugSnapshot: () => ({
        result: data,
        calculation: {
          ...analysisOptions,
          // The model gates FVG computation until provider bars arrive.
          showFairValueGaps: analysisOptions.showFairValueGaps && (!requestedFvg || !!analysisOptions.fvgCandles),
          requestedFairValueGaps: analysisOptions.showFairValueGaps,
          fvgProviderState: !requestedFvg ? 'not-required' : analysisOptions.fvgCandles ? 'loaded' : 'waiting-or-unavailable',
        },
      }),
      remove: () => { removed = true; ++generation; chart.removeSeries(overlay); },
    };
  },
};
return def;
}

export default createSmcIndicator({
  id: 'smart-money-concepts-v2', name: 'SMC V2 · Ductri style', title: 'SMC V2', order: 14,
});
