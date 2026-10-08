import { SOURCE_PARAM, type IndicatorDef } from '../registry';
import { ema, type Source } from '../index';

const def: IndicatorDef = {
  id: 'ema',
  name: 'EMA',
  category: 'overlay',
  order: 11,
  formula: 'EMA = exponential moving average of the selected source, seeded by its length-period SMA; smoothing factor 2/(length+1).',
  params: [
    { key: 'length', label: 'Length', type: 'int', default: 50, min: 1, max: 5000 },
    SOURCE_PARAM,
  ],
  calculate: (candles, params) => ({ EMA: ema(candles, Number(params.length), String(params.source) as Source) }),
  create(chart, params) {
    const length = Number(params.length);
    const source = String(params.source) as Source;
    const s = chart.addLine({ title: `EMA ${length}`, color: chart.theme.palette[1] });
    return {
      recompute: () => s.setData(ema(chart.getCandles(), length, source)),
      remove: () => chart.removeSeries(s),
    };
  },
};

export default def;
