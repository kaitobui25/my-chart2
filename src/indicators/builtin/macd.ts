import type { IndicatorDef } from '../registry';
import { macd } from '../index';

const def: IndicatorDef = {
  id: 'macd',
  name: 'MACD',
  category: 'oscillator',
  order: 21,
  params: [
    { key: 'fast', label: 'Fast Length', type: 'int', default: 12, min: 1, max: 500 },
    { key: 'slow', label: 'Slow Length', type: 'int', default: 26, min: 1, max: 500 },
    { key: 'signal', label: 'Signal', type: 'int', default: 9, min: 1, max: 500 },
  ],
  create(chart, params) {
    const fast = Number(params.fast);
    const slow = Number(params.slow);
    const signalLen = Number(params.signal);
    const pane = chart.addPane(1);
    const hist = chart.addHistogram({ title: `MACD (${fast}, ${slow}, ${signalLen})`, pane });
    const macdLine = chart.addLine({ color: chart.theme.palette[0], pane });
    const signal = chart.addLine({ color: chart.theme.palette[1], pane });
    const all = [hist, macdLine, signal];
    return {
      recompute: () => {
        const m = macd(chart.getCandles(), fast, slow, signalLen);
        hist.setData(m.histogram);
        macdLine.setData(m.macd);
        signal.setData(m.signal);
      },
      remove: () => all.forEach((s) => chart.removeSeries(s)),
    };
  },
};

export default def;
