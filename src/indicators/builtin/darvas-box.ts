import type { RenderContext } from '../../core/series';
import type { IndicatorDef } from '../registry';
import { calculateDarvasBoxes, type DarvasBox } from './darvas-box-model';

function drawBoxes(rc: RenderContext, boxes: readonly DarvasBox[], params: Record<string, string | number | boolean>): void {
  if (!params.showBoxes) return;
  const { ctx, ts, ps, from, to, paneWidth, paneHeight } = rc;
  const style = String(params.borderStyle);
  const width = Number(params.borderWidth);
  const dash = style === 'dotted' ? [1, 3] : style === 'dashed' ? [6, 4] : [];
  const fillAlpha = Number(params.fillOpacity) / 100;
  const halfBar = ts.barSpacing * 0.5;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, paneWidth, paneHeight);
  ctx.clip();
  ctx.lineWidth = width;
  ctx.setLineDash(dash);

  // Completed boxes are ordered and never overlap. Skip history outside the
  // viewport without walking every old rectangle on every pan/zoom frame.
  let lower = 0;
  let upper = boxes.length;
  while (lower < upper) {
    const mid = (lower + upper) >>> 1;
    if (boxes[mid].endIndex < from) lower = mid + 1;
    else upper = mid;
  }
  for (let i = lower; i < boxes.length; i++) {
    const box = boxes[i];
    if (box.startIndex > to) break;
    const color = String(params[box.state === 'bull' ? 'bullColor' : box.state === 'bear' ? 'bearColor' : 'formingColor']);
    const left = ts.xForIndex(box.startIndex) - halfBar;
    const right = ts.xForIndex(box.endIndex) + halfBar;
    const top = ps.yFor(box.top);
    const bottom = ps.yFor(box.bottom);
    const y = Math.min(top, bottom);
    const height = Math.max(1, Math.abs(bottom - top));
    const rectWidth = Math.max(1, right - left);

    ctx.globalAlpha = fillAlpha;
    ctx.fillStyle = color;
    ctx.fillRect(left, y, rectWidth, height);
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = color;
    ctx.strokeRect(left, y, rectWidth, height);
  }
  ctx.restore();
}

const def: IndicatorDef = {
  id: 'darvas-box',
  name: 'Hộp Darvas',
  category: 'overlay',
  order: 14,
  styleControls: 'custom',
  formula: 'Confirmed high/low pivots define boxes. A close outside the box ends it; breakout color requires volume greater than the prior 20-bar average when volume data is available.',
  params: [
    { key: 'pivotSize', label: 'Số Nến Xác Định Đỉnh/Đáy', type: 'int', default: 3, min: 1, max: 50, section: 'Cài đặt hộp Darvas' },
    { key: 'showBoxes', label: 'Vẽ Hộp Khung Hiện Tại', type: 'boolean', default: true, section: 'Cài đặt khung hiện tại' },
    { key: 'borderStyle', label: 'Kiểu Viền', type: 'select', default: 'dotted', options: [
      { value: 'solid', label: 'solid' }, { value: 'dashed', label: 'dashed' }, { value: 'dotted', label: 'dotted' },
    ] },
    { key: 'borderWidth', label: 'Độ Dày Viền', type: 'int', default: 1, min: 1, max: 5 },
    { key: 'formingColor', label: 'Màu Hộp (Đang Tạo)', type: 'color', default: '#9499a3' },
    { key: 'bullColor', label: 'Phá Vỡ Tăng', type: 'color', default: '#4c9c88' },
    { key: 'bearColor', label: 'Phá Vỡ Giảm', type: 'color', default: '#d4494b' },
    { key: 'fillOpacity', label: 'Độ đậm nền (%)', type: 'int', default: 16, min: 0, max: 100 },
  ],
  create(chart, params) {
    const compute = () => calculateDarvasBoxes(chart.getCandles(), Number(params.pivotSize), chart.getIntervalSec());
    let boxes = compute();
    const overlay = chart.addOverlay({ title: 'Hộp Darvas', draw: rc => drawBoxes(rc, boxes, params) });
    overlay.legendColor = String(params.formingColor);
    return {
      recompute() { boxes = compute(); },
      getDebugSnapshot: () => ({ result: boxes, calculation: { pivotSize: Number(params.pivotSize) } }),
      remove() { chart.removeSeries(overlay); },
    };
  },
};

export default def;
