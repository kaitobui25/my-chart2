import type { Candle } from '../../core/types';
import type { Datafeed, HistoryRange } from '../../datafeed';
import type { RenderContext } from '../../core/series';
import { intervalApproxSeconds, nextIntervalStart } from '../../interval';
import type { IndicatorDef } from '../registry';
import type { L2Chart } from '../../core/chart';
import { ema } from '../index';
import { getIndicatorChartProvider, getIndicatorMarketContext, getIndicatorChartSymbol, onIndicatorChartSymbolChange, onIndicatorChartProviderChange } from '../runtime-context';
import { alignComparisonCandles, projectComparisonCandles } from './comparison-overlay-model';

const REFRESH_MS = 60_000;
const requests = new WeakMap<Datafeed, Map<string, { promise: Promise<Candle[]>; at: number }>>();
function loadComparison(feed: Datafeed, symbol: string, interval: string, range: HistoryRange, live: boolean): Promise<Candle[]> {
  let cache = requests.get(feed);
  if (!cache) { cache = new Map(); requests.set(feed, cache); }
  const key = `${symbol}:${live ? 'live' : 'replay'}:${interval}:${range.from}:${range.to}`;
  const existing = cache.get(key);
  if (existing && Date.now() - existing.at < REFRESH_MS) return existing.promise;
  const history = feed.getHistory(symbol, interval, 50_000, range);
  const request = live ? history.then(async candles => {
    // Range coverage can already be cached while the current live bar changes.
    const latest = await feed.getHistory(symbol, interval, 2);
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
export function drawComparisonOverlay(rc: RenderContext, candles: readonly (Candle | null)[], color: string, opacity: number, values: readonly (number | null)[] = [], mode = 'candles', lineWidth = 1.5): void {
  const visible = candles.slice(Math.max(0, rc.from), rc.to + 1).filter((c): c is Candle => c !== null);
  if (!visible.length) return;
  const visibleEma = values.slice(Math.max(0, rc.from), rc.to + 1).filter((v): v is number => v !== null);
  const low = Math.min(...visible.map(c => c.low), ...visibleEma);
  const high = Math.max(...visible.map(c => c.high), ...visibleEma);
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
    if (!candle || mode === 'ema') continue;
    const x = rc.ts.xForIndex(index);
    ctx.beginPath(); ctx.moveTo(x, y(candle.high)); ctx.lineTo(x, y(candle.low)); ctx.stroke();
    ctx.fillRect(x - width / 2, Math.min(y(candle.open), y(candle.close)), width,
      Math.max(1, Math.abs(y(candle.open) - y(candle.close))));
  }
  if (mode !== 'candles') {
    ctx.lineWidth = lineWidth; ctx.beginPath(); let connected = false;
    for (let i = Math.max(0, rc.from); i <= rc.to; i++) {
      const value = values[i];
      if (value == null) { connected = false; continue; }
      const x = rc.ts.xForIndex(i), priceY = y(value);
      if (connected) ctx.lineTo(x, priceY); else ctx.moveTo(x, priceY);
      connected = true;
    }
    ctx.stroke();
  }
  ctx.restore();
}

export interface ComparisonOverlayConfig {
  id: string; name: string; symbol?: string; withEma?: boolean;
  available?(chart: L2Chart): boolean;
  resolveSymbol?(chart: L2Chart): Promise<{ symbol: string; label: string } | null>;
}
export function createComparisonOverlay(config: ComparisonOverlayConfig): IndicatorDef {
return {
  id: config.id, name: config.name, category: 'overlay', styleControls: 'custom', available: config.available,
  params: [
    { key: 'color', label: 'Màu nến', type: 'color', default: '#9ca3af' },
    { key: 'opacity', label: 'Độ hiển thị (%)', type: 'int', default: 20, min: 0, max: 100, step: 1 },
    ...(config.withEma ? [
      { key: 'display', label: 'Hiển thị', type: 'select' as const, default: 'candles', options: [{ value: 'candles', label: 'Nến' }, { value: 'ema', label: 'EMA20' }, { value: 'both', label: 'Nến + EMA20' }] },
      { key: 'emaWidth', label: 'Độ dày EMA20', type: 'float' as const, default: 1.5, min: 0.5, max: 5, step: 0.5 },
    ] : []),
  ],
  create(chart, params) {
    let aligned: (Candle | null)[] = [];
    let alignedEma: (number | null)[] = [];
    let instrument = config.symbol ? { symbol: config.symbol, label: config.symbol } : null;
    let instrumentKey = '';
    let resolution = 0;
    let raw: Candle[] = [];
    let rawInterval = '';
    let key = '';
    let generation = 0;
    let requestedAt = 0;
    let removed = false;
    const color = String(params.color ?? '#9ca3af');
    const opacity = Math.min(100, Math.max(0, Number(params.opacity ?? 20))) / 100;
    const overlay = chart.addOverlay({ title: config.name, draw: rc => drawComparisonOverlay(rc, aligned, color, opacity, alignedEma, String(params.display ?? 'candles'), Number(params.emaWidth ?? 1.5)) });
    overlay.legendColor = color;
    function present(): void {
      const context = getIndicatorMarketContext(chart);
      const projected = context ? projectComparisonCandles(raw, rawInterval, context.interval, context.replayTime) : [];
      aligned = context ? alignComparisonCandles(chart.getCandles(), projected, context.interval) : [];
      alignedEma = [];
      if (context && config.withEma) {
        const values = ema(projected, 20, 'close');
        const byCandle = new Map(projected.map((candle, i) => [candle, values[i]]));
        alignedEma = aligned.map(candle => candle ? byCandle.get(candle) ?? null : null);
      }
      overlay.legendText = aligned.some(Boolean) ? instrument?.label ?? '' : 'No data';
      chart.invalidate();
    }
    function recompute(): void {
      const context = getIndicatorMarketContext(chart);
      const bars = chart.getCandles();
      if (!context?.feed || getIndicatorChartProvider(chart) !== 'yfinance-jp' || !bars.length) {
        generation++; key = ''; raw = []; aligned = []; alignedEma = [];
        overlay.legendText = 'Cần nguồn Yahoo Japan'; chart.invalidate(); return;
      }
      if (config.resolveSymbol) {
        const identity = `${getIndicatorChartProvider(chart)}:${getIndicatorChartSymbol(chart)}`;
        if (identity !== instrumentKey) {
          instrumentKey = identity; instrument = null; raw = []; aligned = []; alignedEma = []; key = ''; generation++;
          const token = ++resolution;
          overlay.legendText = 'Loading sector...'; chart.invalidate();
          void config.resolveSymbol(chart).then(selected => {
            if (removed || token !== resolution || identity !== `${getIndicatorChartProvider(chart)}:${getIndicatorChartSymbol(chart)}`) return;
            instrument = selected; recompute();
          }).catch(() => { if (!removed && token === resolution) { instrumentKey = ''; overlay.legendText = 'Sector unavailable'; chart.invalidate(); } });
        }
        if (!instrument) { overlay.legendText = 'No TOPIX-17 classification'; chart.invalidate(); return; }
      }
      const replayRaw = [context.interval, context.replayInterval ?? context.interval, '15m']
        .sort((a, b) => intervalApproxSeconds(a) - intervalApproxSeconds(b))[0];
      const interval = context.replayTime === null ? context.interval : replayRaw;
      const step = intervalApproxSeconds(context.interval);
      const warmup = config.withEma ? (step >= 86400 ? 40 * step * 2 : Math.max(10 * 86400, 40 * step * 8)) : 0;
      const range = { from: Math.max(0, bars[0].time - warmup), to: nextIntervalStart(bars[bars.length - 1].time, context.interval, 540) - 1 };
      const nextKey = `${instrument!.symbol}:${context.interval}:${interval}:${range.from}:${range.to}`;
      if (nextKey === key && (context.replayTime !== null || Date.now() - requestedAt < REFRESH_MS)) {
        present(); return;
      }
      if (rawInterval !== interval) raw = [];
      rawInterval = interval; key = nextKey;
      requestedAt = Date.now();
      const token = ++generation;
      present(); overlay.legendText = 'Đang tải…';
      void loadComparison(context.feed, instrument!.symbol, interval, range, context.replayTime === null).then(candles => {
        if (removed || token !== generation) return;
        raw = candles; present();
      }).catch(error => {
        if (removed || token !== generation) return;
        key = ''; overlay.legendText = `${config.name} · Không tải được dữ liệu`;
        console.warn('Unable to load comparison overlay', error); chart.invalidate();
      });
    }
    const unsubscribers = config.resolveSymbol ? [onIndicatorChartSymbolChange(chart, recompute), onIndicatorChartProviderChange(chart, recompute)] : [];
    recompute();
    const timer = setInterval(() => {
      if (getIndicatorMarketContext(chart)?.replayTime === null) recompute();
    }, REFRESH_MS);
    return {
      recompute,
      getDebugSnapshot: () => ({ result: aligned, calculation: {
        symbol: instrument?.symbol, alignedEma, rawInterval, rawCount: raw.length, status: overlay.legendText, color, opacity,
        replayTime: getIndicatorMarketContext(chart)?.replayTime,
      } }),
      remove() { removed = true; generation++; resolution++; unsubscribers.forEach(unsubscribe => unsubscribe()); clearInterval(timer); chart.removeSeries(overlay); },
    };
  },
};
}
