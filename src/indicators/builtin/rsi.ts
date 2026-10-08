import type { IndicatorDef } from '../registry';
import { rsi } from '../index';

const def: IndicatorDef = {
  id: 'rsi',
  name: 'RSI',
  category: 'oscillator',
  order: 20,
  formula: 'RSI = 100 - 100/(1 + average gain / average loss), with Wilder smoothing over length closes.',
  params: [{ key: 'length', label: 'Length', type: 'int', default: 14, min: 2, max: 500 }],
  calculate: (candles, params) => ({ RSI: rsi(candles, Number(params.length)) }),
  create(chart, params) {
    const length = Number(params.length);
    const pane = chart.addPane(1);
    const s = chart.addLine({ title: `RSI ${length}`, color: chart.theme.palette[2], pane });
    return {
      recompute: () => s.setData(rsi(chart.getCandles(), length)),
      remove: () => chart.removeSeries(s),
    };
  },
};

export default def;
