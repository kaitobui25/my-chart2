import { SOURCE_PARAM, type IndicatorDef } from '../registry';
import { sma, type Source } from '../index';

const def: IndicatorDef = {
  id: 'sma',
  name: 'SMA',
  category: 'overlay',
  order: 10,
  params: [
    { key: 'length', label: 'Length', type: 'int', default: 20, min: 1, max: 5000 },
    SOURCE_PARAM,
  ],
  create(chart, params) {
    const length = Number(params.length);
    const source = String(params.source) as Source;
    const s = chart.addLine({ title: `SMA ${length}`, color: chart.theme.palette[0] });
    return {
      recompute: () => s.setData(sma(chart.getCandles(), length, source)),
      remove: () => chart.removeSeries(s),
    };
  },
};

export default def;
