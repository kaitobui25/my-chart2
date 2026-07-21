import type { IndicatorDef } from '../registry';
import { volumes } from '../index';

const def: IndicatorDef = {
  id: 'volume',
  name: 'Volume',
  category: 'volume',
  order: 1,
  params: [
    { key: 'height', label: 'Height', type: 'float', default: 0.22, min: 0.05, max: 0.5, step: 0.01 },
  ],
  create(chart, params) {
    const s = chart.addHistogram({
      title: 'Vol',
      ownScaleFraction: Number(params.height),
      compact: true,
      colorFor: (i) => {
        const c = chart.getCandles()[i];
        return c && c.close >= c.open ? chart.theme.volUp : chart.theme.volDown;
      },
    });
    return {
      recompute: () => s.setData(volumes(chart.getCandles())),
      remove: () => chart.removeSeries(s),
    };
  },
};

export default def;
