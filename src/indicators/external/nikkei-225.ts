import type { Candle } from '../../core/types';
import type { Datafeed, HistoryRange } from '../../datafeed';
import type { RenderContext } from '../../core/series';
import { intervalApproxSeconds, nextIntervalStart } from '../../interval';
import type { IndicatorDef } from '../registry';
import { getIndicatorChartProvider, getIndicatorMarketContext } from '../runtime-context';
import { alignNikkeiCandles, projectNikkeiCandles } from './nikkei-225-model';

const REFRESH_MS = 60_000;
const requests = new WeakMap<Datafeed, Map<string, { promise: Promise<Candle[]>; at: number }>>();
function loadNikkei(feed: Datafeed, interval: string, range: HistoryRange, live: boolean): Promise<Candle[]> {
  let cache = requests.get(feed);
  if (!cache) { cache = new Map(); requests.set(feed, cache); }
  const key = `${live ? 'live' : 'replay'}:${interval}:${range.from}:${range.to}`;
  const existing = cache.get(key);
  if (existing && Date.now() - existing.at < REFRESH_MS) return existing.promise;
  const history = feed.getHistory('^N225', interval, 50_000, range);
  const request = live ? history.then(async candles => {
    // Range coverage can already be cached while the current live bar changes.
    const latest = await feed.getHistory('^N225', interval, 2);
    const merged = new Map(candles.map(candle => [candle.time, candle]));
    for (const candle of latest) {
      if (candle.time >= range.from && candle.time <= range.to) merged.set(candle.time, candle);
    }
    return [...merged.values()].sort((a, b) => a.time - b.time);
  }) : history;
  cache.set(key, { promise: request, at: Date.now() });
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  void request.catch(() => { if (cache!.get(key)?.promise === request) cache!.delete(key); });
  return request;
}

/** Pixel-local scale leaves the primary symbol's price axis unchanged. */
export function drawNikkeiCandles(rc: RenderContext, candles: readonly (Candle | null)[], color: string, opacity: number): void {
  const visible = candles.slice(Math.max(0, rc.from), rc.to + 1).filter((c): c is Candle => c !== null);
  if (!visible.length) return;
  const low = Math.min(...visible.map(c => c.low));
  const high = Math.max(...visible.map(c => c.high));
  const span = high - low || Math.max(Math.abs(high) * 0.001, 1);
  const top = rc.legendHeight + 12;
  const height = Math.max(1, rc.paneHeight - top - 16);
  const y = (value: number) => top + (high - value) / span * height;
  const width = Math.max(1, Math.abs(rc.ts.xForIndex(1) - rc.ts.xForIndex(0)) * 0.6);
  const { ctx } = rc;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, rc.paneWidth, rc.paneHeight); ctx.clip();
  ctx.globalAlpha *= opacity;
  ctx.fillStyle = ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (let index = Math.max(0, rc.from); index <= rc.to; index++) {
    const candle = candles[index];
    if (!candle) continue;
    const x = rc.ts.xForIndex(index);
    ctx.beginPath(); ctx.moveTo(x, y(candle.high)); ctx.lineTo(x, y(candle.low)); ctx.stroke();
    ctx.fillRect(x - width / 2, Math.min(y(candle.open), y(candle.close)), width,
      Math.max(1, Math.abs(y(candle.open) - y(candle.close))));
  }
  ctx.restore();
}

const def: IndicatorDef = {
  id: 'nikkei-225', name: 'Nikkei 225', category: 'overlay', styleControls: 'custom',
  params: [
    { key: 'color', label: 'Màu nến', type: 'color', default: '#9ca3af' },
    { key: 'opacity', label: 'Độ hiển thị (%)', type: 'int', default: 20, min: 0, max: 100, step: 1 },
  ],
  create(chart, params) {
    let aligned: (Candle | null)[] = [];
    let raw: Candle[] = [];
    let rawInterval = '';
    let key = '';
    let generation = 0;
    let requestedAt = 0;
    let removed = false;
    const color = String(params.color ?? '#9ca3af');
    const opacity = Math.min(100, Math.max(0, Number(params.opacity ?? 20))) / 100;
    const overlay = chart.addOverlay({ title: 'Nikkei 225', draw: rc => drawNikkeiCandles(rc, aligned, color, opacity) });
    overlay.legendColor = color;
    function present(): void {
      const context = getIndicatorMarketContext(chart);
      aligned = context ? alignNikkeiCandles(chart.getCandles(), projectNikkeiCandles(
        raw, rawInterval, context.interval, context.replayTime,
      ), context.interval) : [];
      overlay.legendText = aligned.some(Boolean) ? '^N225' : 'Chưa có dữ liệu';
      chart.invalidate();
    }
    function recompute(): void {
      const context = getIndicatorMarketContext(chart);
      const bars = chart.getCandles();
      if (!context?.feed || getIndicatorChartProvider(chart) !== 'yfinance-jp' || !bars.length) {
        generation++; key = ''; raw = []; aligned = [];
        overlay.legendText = 'Cần nguồn Yahoo Japan'; chart.invalidate(); return;
      }
      const replayRaw = [context.interval, context.replayInterval ?? context.interval, '15m']
        .sort((a, b) => intervalApproxSeconds(a) - intervalApproxSeconds(b))[0];
      const interval = context.replayTime === null ? context.interval : replayRaw;
      const range = { from: bars[0].time, to: nextIntervalStart(bars[bars.length - 1].time, context.interval, 540) - 1 };
      const nextKey = `${context.interval}:${interval}:${range.from}:${range.to}`;
      if (nextKey === key && (context.replayTime !== null || Date.now() - requestedAt < REFRESH_MS)) {
        present(); return;
      }
      if (rawInterval !== interval) raw = [];
      rawInterval = interval; key = nextKey;
      requestedAt = Date.now();
      const token = ++generation;
      present(); overlay.legendText = 'Đang tải…';
      void loadNikkei(context.feed, interval, range, context.replayTime === null).then(candles => {
        if (removed || token !== generation) return;
        raw = candles; present();
      }).catch(error => {
        if (removed || token !== generation) return;
        key = ''; overlay.legendText = 'Không tải được Nikkei';
        console.warn('Unable to load Nikkei 225 overlay', error); chart.invalidate();
      });
    }
    recompute();
    const timer = setInterval(() => {
      if (getIndicatorMarketContext(chart)?.replayTime === null) recompute();
    }, REFRESH_MS);
    return {
      recompute,
      getDebugSnapshot: () => ({ result: aligned, calculation: {
        rawInterval, rawCount: raw.length, status: overlay.legendText, color, opacity,
        replayTime: getIndicatorMarketContext(chart)?.replayTime,
      } }),
      remove() { removed = true; generation++; clearInterval(timer); chart.removeSeries(overlay); },
    };
  },
};
export default def;
