import { SOURCE_PARAM, type IndicatorDef, type Params, type ParamDef } from '../registry';
import type { Source } from '../index';
import type { Candle } from '../../core/types';
import { getIndicatorChartProvider, getIndicatorChartSymbol, onIndicatorChartProviderChange, onIndicatorChartSymbolChange } from '../runtime-context';
import { calculateSuperEma, type EmaOptions } from './super-ema-model';
import { drawMiniCharts, type MiniChart } from './super-ema-mini-chart';

const frames = [
  ['1', '1m', 60], ['3', '3m', 180], ['5', '5m', 300], ['15', '15m', 900],
  ['30', '30m', 1800], ['60', '1H', 3600], ['120', '2H', 7200], ['240', '4H', 14400],
  ['D', 'D', 86400], ['W', 'W', 604800], ['M', 'M', 2678400],
] as const;
const lengths = [20, 50, 100, 200];
const colors = ['#ffcc00', '#ff9900', '#ff6600', '#ff0000'];
function emaOptions(params: Params): EmaOptions[] {
  return lengths.map((_, i) => ({
    length: Number(params[`length${i}`]), source: String(params[`source${i}`]) as Source,
    visible: Boolean(params[`show${i}`]), color: String(params[`color${i}`]), width: Number(params[`width${i}`]),
  }));
}
const params: ParamDef[] = lengths.flatMap((length, i): ParamDef[] => [
  { key: `show${i}`, label: `Show EMA ${i + 1}`, type: 'boolean', default: true, section: `EMA ${i + 1}` },
  { key: `length${i}`, label: 'Length', type: 'int', default: length, min: 1, max: 5000 },
  { ...SOURCE_PARAM, key: `source${i}` },
  { key: `color${i}`, label: 'Color', type: 'color', default: colors[i] },
  { key: `width${i}`, label: 'Line width', type: 'int', default: i < 2 ? 1 : i, min: 1, max: 5 },
]);
params.push(
  { key: 'bull', label: 'BULL labels', type: 'boolean', default: true, section: 'MA structure · closed bars' },
  { key: 'bear', label: 'BEAR labels', type: 'boolean', default: true },
);
for (let i = 0; i < 3; i++) params.push(
  { key: `mini${i}`, label: `Show mini-chart ${i + 1}`, type: 'boolean', default: true, section: `Mini-chart ${i + 1}` },
  { key: `frame${i}`, label: 'Timeframe', type: 'select', default: ['15', '60', '240'][i], options: frames.map(([value, label]) => ({ value, label })) },
);
params.push(
  { key: 'count', label: 'Visible candles', type: 'int', default: 50, min: 10, max: 200, section: 'Mini-chart layout' },
  { key: 'offset', label: 'Offset (main bars)', type: 'int', default: 20, min: 1, max: 200 },
  { key: 'spacing', label: 'Candle spacing (px)', type: 'int', default: 3, min: 2, max: 12 },
  { key: 'height', label: 'Height (%)', type: 'int', default: 22, min: 5, max: 80 },
  { key: 'gap', label: 'Chart gap (px)', type: 'int', default: 16, min: 0, max: 100 },
);

const def: IndicatorDef = {
  id: 'super-ema', name: 'Super EMA', category: 'overlay', order: 12, params, styleControls: 'custom',
  formula: 'Four SMA-seeded EMA lines. BULL: EMA1 > EMA2 > EMA3 > EMA4; BEAR: reverse order. Labels confirm on the following bar.',
  calculate(candles, params) {
    const result = calculateSuperEma(candles, emaOptions(params));
    return Object.fromEntries(result.lines.map((line, i) => [`EMA${i + 1}`, line]));
  },
  create(chart, params) {
    const options = emaOptions(params);
    let result = calculateSuperEma(chart.getCandles(), options);
    const lines = options.map((option) => {
      const line = chart.addLine({ color: option.color, lineWidth: option.width });
      // Per-line settings take precedence over the host's generic appearance palette.
      line.color = line.legendColor = option.color;
      line.lineWidth = option.width;
      line.visible = option.visible;
      return line;
    });
    const minis: MiniChart[] = [];
    for (let i = 0; i < 3; i++) {
      if (!params[`mini${i}`]) continue;
      const frame = frames.find(([value]) => value === params[`frame${i}`])!;
      minis.push({ timeframe: frame[0], label: frame[1], seconds: frame[2], candles: [], status: 'loading' });
    }
    const overlay = chart.addOverlay({ title: 'Super EMA', draw(rc) {
      const candles = chart.getCandles();
      const { ctx, theme } = rc;
      ctx.save(); ctx.font = 'bold 11px sans-serif';
      for (const signal of result.signals) {
        if (signal.index < rc.from || signal.index > rc.to || !params[signal.state]) continue;
        const candle = candles[signal.index];
        const text = signal.state === 'bull' ? 'BULL🔥' : 'BEAR🔥';
        const x = rc.ts.xForIndex(signal.index);
        const y = rc.ps.yFor(signal.state === 'bull' ? candle.low : candle.high) + (signal.state === 'bull' ? 20 : -12);
        const width = ctx.measureText(text).width + 10;
        ctx.fillStyle = signal.state === 'bull' ? theme.up : theme.down;
        ctx.fillRect(x - width / 2, y - 12, width, 17);
        ctx.fillStyle = '#ffffff'; ctx.fillText(text, x - width / 2 + 5, y);
      }
      ctx.restore();
      drawMiniCharts(rc, minis, options, { lastIndex: candles.length - 1, count: Number(params.count),
        offset: Number(params.offset), spacing: Number(params.spacing), height: Number(params.height), gap: Number(params.gap) });
    } });
    let removed = false, generation = 0, pending = false, context = '';
    let lastBarTime: number | undefined;
    const releaseMargin = minis.length ? chart.timeScale.reserveRightMargin(() =>
      Number(params.offset) * chart.timeScale.barSpacing + Number(params.count) * Number(params.spacing) + 24) : () => {};
    function useChartData(mini: MiniChart): boolean {
      const candles = chart.getCandles();
      if (mini.seconds !== chart.getIntervalSec() || candles.length < Math.max(...options.map(option => option.length)) + Number(params.count)) return false;
      mini.candles = candles;
      mini.result = result;
      mini.status = '';
      mini.error = undefined;
      return true;
    }
    function refresh(reset = false): void {
      const candles = chart.getCandles();
      const last = candles[candles.length - 1];
      if (removed) return;
      if (pending && !reset) return;
      const token = ++generation;
      if (reset) for (const mini of minis) { mini.candles = []; mini.result = undefined; mini.status = 'loading'; }
      pending = Boolean(last);
      if (!last) return;
      const warmup = Math.max(...options.map(option => option.length)) * 3 + Number(params.count);
      const requests = new Map<string, Promise<readonly Candle[]> | undefined>();
      void Promise.all(minis.map(async mini => {
        if (mini.seconds < chart.getIntervalSec()) { mini.status = 'lower timeframe'; return; }
        try {
          if (useChartData(mini)) return;
          if (!requests.has(mini.timeframe)) requests.set(mini.timeframe,
            chart.getIndicatorCandles(mini.timeframe, { from: last.time - warmup * mini.seconds, to: last.time, limit: warmup }));
          const request = requests.get(mini.timeframe);
          if (!request) throw new Error('timeframe provider unavailable');
          const bars = await request;
          if (removed || token !== generation) return;
          if (!bars.length) throw new Error('no data / unsupported timeframe');
          mini.candles = bars;
          mini.error = undefined;
          mini.result = calculateSuperEma(bars, options);
          mini.status = bars.length < Math.max(...options.map(option => option.length)) ? 'insufficient EMA history' : '';
        } catch (error) {
          if (removed || token !== generation) return;
          mini.status = mini.candles.length ? 'stale data' : 'data unavailable';
          mini.error = error instanceof Error ? error.message : String(error);
        }
      })).then(() => { if (!removed && token === generation) { pending = false; chart.invalidate(); } });
    }
    function recompute(): void {
      result = calculateSuperEma(chart.getCandles(), options);
      lines.forEach((line, i) => line.setData(result.lines[i]));
      overlay.legendText = (result.states[result.states.length - 2] ?? 'warming').toUpperCase();
      const candles = chart.getCandles();
      const key = `${getIndicatorChartSymbol(chart)}:${getIndicatorChartProvider(chart)}:${chart.getIntervalSec()}:${candles[0]?.time}`;
      if (key !== context) { context = key; refresh(true); }
      else if (lastBarTime !== candles[candles.length - 1]?.time) refresh();
      lastBarTime = candles[candles.length - 1]?.time;
      minis.forEach(useChartData);
    }
    const unsubscribers = [onIndicatorChartSymbolChange(chart, () => refresh(true)), onIndicatorChartProviderChange(chart, () => refresh(true))];
    const timer = minis.length ? setInterval(() => refresh(), 30_000) : undefined;
    recompute();
    return {
      recompute,
      getDebugSnapshot: () => ({ result, calculation: { options, minis } }),
      remove() { removed = true; generation++; clearInterval(timer); releaseMargin(); unsubscribers.forEach(unsubscribe => unsubscribe());
        lines.forEach(line => chart.removeSeries(line)); chart.removeSeries(overlay); },
    };
  },
};
export default def;
