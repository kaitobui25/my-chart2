import { hexToRgba } from '../../core/utils';
import { SOURCE_PARAM, type IndicatorDef } from '../registry';
import { bollinger, type Source } from '../index';

const def: IndicatorDef = {
  id: 'bollinger',
  name: 'Bollinger Bands',
  category: 'overlay',
  order: 12,
  params: [
    { key: 'length', label: 'Length', type: 'int', default: 20, min: 1, max: 5000 },
    { key: 'mult', label: 'StdDev', type: 'float', default: 2, min: 0.1, max: 50, step: 0.5 },
    SOURCE_PARAM,
  ],
  create(chart, params) {
    const length = Number(params.length);
    const mult = Number(params.mult);
    const source = String(params.source) as Source;
    const color = chart.theme.palette[2];
    const band = chart.addBand({ fillColor: hexToRgba(color, 0.07) });
    const upper = chart.addLine({ title: `BB (${length}, ${mult})`, color, lineWidth: 1 });
    const middle = chart.addLine({ color: chart.theme.textDim, lineWidth: 1 });
    const lower = chart.addLine({ color, lineWidth: 1 });
    const all = [band, upper, middle, lower];
    return {
      recompute: () => {
        const bb = bollinger(chart.getCandles(), length, mult, source);
        band.setData(bb.upper, bb.lower);
        upper.setData(bb.upper);
        middle.setData(bb.middle);
        lower.setData(bb.lower);
      },
      remove: () => all.forEach((s) => chart.removeSeries(s)),
    };
  },
};

export default def;
