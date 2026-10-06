import type { IndicatorDef, ParamDef } from '../registry';
import type { RenderContext } from '../../core/series';
import type { SmcPriceZone, SmcResult, SmcStructureEvent } from './smart-money-concepts-model';
import { calculateSmartMoneyConcepts } from './smart-money-concepts-model';

const onOffOptions = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

const toggleParam = (key: string, label: string, defaultValue: string): ParamDef => ({
  key,
  label,
  type: 'select',
  default: defaultValue,
  options: onOffOptions,
});

function drawZone(
  rc: RenderContext,
  zone: SmcPriceZone,
  color: string,
): void {
  const { ctx, ts, ps, from, to } = rc;
  if (zone.endIndex < from || zone.startIndex > to) return;
  const halfBar = ts.barSpacing / 2;
  const left = ts.xForIndex(zone.startIndex) - halfBar;
  const right = ts.xForIndex(Math.min(zone.endIndex, to)) + halfBar;
  const top = ps.yFor(zone.top);
  const bottom = ps.yFor(zone.bottom);
  const y = Math.min(top, bottom);
  const height = Math.max(1, Math.abs(bottom - top));

  ctx.save();
  ctx.globalAlpha *= 0.12;
  ctx.fillStyle = color;
  ctx.fillRect(left, y, right - left, height);
  ctx.restore();

  ctx.save();
  ctx.globalAlpha *= 0.45;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.strokeRect(left, y, right - left, height);
  ctx.restore();
}

function drawStructure(rc: RenderContext, event: SmcStructureEvent): void {
  const { ctx, ts, ps, from, to, theme } = rc;
  if (event.index < from || event.index > to) return;
  const color = event.direction === 'bullish' ? theme.up : theme.down;
  const x1 = ts.xForIndex(event.originIndex);
  const x2 = ts.xForIndex(event.index);
  const y = ps.yFor(event.price);

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = event.scope === 'swing' ? 1.25 : 1;
  ctx.setLineDash(event.scope === 'swing' ? [] : [3, 3]);
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.font = `600 ${event.scope === 'swing' ? 10 : 8}px Manrope, -apple-system, BlinkMacSystemFont, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = event.direction === 'bullish' ? 'bottom' : 'top';
  ctx.fillText(event.kind, (x1 + x2) / 2, y + (event.direction === 'bullish' ? -2 : 2));
  ctx.restore();
}

function drawSmartMoneyConcepts(
  rc: RenderContext,
  data: SmcResult,
  options: {
    showInternal: boolean;
    showSwing: boolean;
    showSwingPoints: boolean;
    showOrderBlocks: boolean;
    showFairValueGaps: boolean;
  },
): void {
  const { ctx, ts, ps, from, to, theme } = rc;
  if (options.showFairValueGaps) {
    for (const gap of data.fairValueGaps) {
      drawZone(rc, gap, gap.direction === 'bullish' ? theme.up : theme.down);
    }
  }
  if (options.showOrderBlocks) {
    for (const block of data.orderBlocks) {
      drawZone(rc, block, block.direction === 'bullish' ? theme.up : theme.down);
    }
  }
  for (const event of data.structures) {
    if (event.scope === 'internal' ? options.showInternal : options.showSwing) {
      drawStructure(rc, event);
    }
  }
  if (!options.showSwingPoints) return;
  ctx.save();
  ctx.font = '600 9px Manrope, -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'center';
  for (const point of data.swingPoints) {
    if (point.index < from || point.index > to) continue;
    const y = ps.yFor(point.price);
    ctx.fillStyle = point.direction === 'bullish' ? theme.up : theme.down;
    ctx.textBaseline = point.direction === 'bullish' ? 'top' : 'bottom';
    ctx.fillText(
      point.label,
      ts.xForIndex(point.index),
      y + (point.direction === 'bullish' ? 3 : -3),
    );
  }
  ctx.restore();
}

const def: IndicatorDef = {
  id: 'smart-money-concepts',
  name: 'Smart Money Concepts',
  category: 'overlay',
  order: 13,
  params: [
    { key: 'swingLength', label: 'Swing pivot length', type: 'int', default: 12, min: 2, max: 100 },
    { key: 'internalLength', label: 'Internal pivot length', type: 'int', default: 4, min: 1, max: 50 },
    toggleParam('showSwing', 'Swing structure', 'on'),
    toggleParam('showInternal', 'Internal structure', 'on'),
    toggleParam('showSwingPoints', 'Swing points', 'on'),
    toggleParam('showOrderBlocks', 'Order blocks', 'on'),
    toggleParam('showFairValueGaps', 'Fair value gaps', 'off'),
  ],
  create(chart, params) {
    const swingLength = Number(params.swingLength);
    const internalLength = Number(params.internalLength);
    const options = {
      showSwing: params.showSwing === 'on',
      showInternal: params.showInternal === 'on',
      showSwingPoints: params.showSwingPoints === 'on',
      showOrderBlocks: params.showOrderBlocks === 'on',
      showFairValueGaps: params.showFairValueGaps === 'on',
    };
    let data = calculateSmartMoneyConcepts(chart.getCandles(), swingLength, internalLength);
    const overlay = chart.addOverlay({
      title: 'SMC',
      draw: (rc) => drawSmartMoneyConcepts(rc, data, options),
    });

    return {
      recompute: () => {
        data = calculateSmartMoneyConcepts(chart.getCandles(), swingLength, internalLength);
      },
      remove: () => chart.removeSeries(overlay),
    };
  },
};

export default def;
