import { describe, expect, it, vi } from 'vitest';
import type { Candle, Datafeed } from '../../src/index';
import { createAssistantBridge, type AssistantPrimarySource } from '../../examples/assistant/context';
import { resolveIndicatorParams } from '../../examples/assistant/indicator-query';
import { calculateDarvasBoxes } from '../../src/indicators/builtin/darvas-box-model';
import { calculateSmartMoneyConceptsV3 } from '../../src/indicators/builtin/smart-money-concepts-v3-model';
import { smcAnalysisOptions } from '../../src/indicators/builtin/smart-money-concepts-v2';
import type { IndicatorDebugSnapshot } from '../../src/indicators/registry';
import type { AssistantDataRequest } from '../../examples/assistant/types';
import { runAssistantTurn } from '../../examples/assistant/chat-runner';
import type { AssistantApiClient, ChatRequest } from '../../examples/assistant/client';

const start = 1700002800; // hour boundary
function bars(count = 400): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const price = 100 + 10 * Math.sin(i / 7) + i / 20;
    return { time: start + i * 3600, open: price, high: price + 2, low: price - 2, close: price + Math.sin(i), volume: 1000 + i };
  });
}
function harness(options: { indicators?: AssistantPrimarySource['indicators']; snapshot?: IndicatorDebugSnapshot; end?: number; feed?: Datafeed; replay?: Record<string, unknown> } = {}) {
  const source: AssistantPrimarySource = {
    symbol: '7203.T', timeframe: '1h', intervalSeconds: 3600, utcOffsetMinutes: 540,
    candles: bars(), mode: 'candles', historyRange: null,
    visibleIndices: { from: 0, to: options.end ?? 399 },
    indicators: options.indicators ?? [], quote: null, replay: options.replay ?? { phase: 'idle' },
  };
  const snapshot = vi.fn(() => options.snapshot);
  const bridge = createAssistantBridge({ getPrimarySource: () => source, getDatafeed: () => options.feed ?? null, getIndicatorSnapshot: snapshot });
  const request = (id: string, params = {}, limit = 5): AssistantDataRequest => ({ tool: 'get_indicator', id, timeframe: 'current', limit, paramsJson: JSON.stringify(params) });
  return { source, bridge, snapshot, request };
}

describe('structured AI indicator data', () => {
  it('uses active SMA parameters and allows explicit overrides', async () => {
    const h = harness({ indicators: [{ id: 'sma', params: { length: 50, source: 'high', __color1: '#fff' } }] });
    const anchor = h.bridge.getContext()!;
    const result = await h.bridge.queryData(h.request('sma'), anchor);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ params: { length: 50, source: 'high' } });
    const values = (result.data as { values: { SMA: { value: number }[] } }).values.SMA;
    const expected = h.source.candles.slice(-50).reduce((sum, b) => sum + b.high, 0) / 50;
    expect(values[values.length - 1].value).toBeCloseTo(expected);
    const override = await h.bridge.queryData(h.request('sma', { length: 20 }), anchor);
    expect(override.data).toMatchObject({ params: { length: 20, source: 'high' } });
    expect(h.snapshot).not.toHaveBeenCalled();
    expect((await h.bridge.queryData(h.request('sma', { length: -1 }), anchor)).ok).toBe(false);
  });

  it('exposes a small catalog without attaching snapshots or candles from external indicators', () => {
    const h = harness();
    const context = h.bridge.getContext()!;
    expect(context.indicatorCatalog?.map(i => i.id)).toEqual(expect.arrayContaining(['darvas-box', 'smart-money-concepts-v3', 'nikkei-225', 'sma', 'rsi']));
    expect(h.snapshot).not.toHaveBeenCalled();
    expect(JSON.stringify(context)).not.toContain('rawCandles');
  });

  it('Darvas uses the chart model and excludes future breakouts', async () => {
    const h = harness({ end: 5, indicators: [{ id: 'darvas-box', params: { pivotSize: 1 } }] });
    h.source.candles = [[10, 8, 9], [11, 9, 10], [14, 10, 12], [12, 9, 11], [10, 7, 8], [11, 9, 10], [13, 10, 13], [15, 12, 15]]
      .map(([high, low, close], i) => ({ time: start + i * 3600, open: close, high, low, close }));
    const anchor = h.bridge.getContext()!;
    const expected = calculateDarvasBoxes(h.source.candles.slice(0, 6), 1, 3600);
    expect(expected.length).toBeGreaterThan(0);
    const first = await h.bridge.queryData(h.request('darvas'), anchor);
    expect(first.data).toMatchObject({ id: 'darvas-box', kind: 'boxes', totalCount: expected.length,
      boxes: expected.slice(-5), calculationSource: 'anchored-calculation' });
    h.source.candles = h.source.candles.map((bar, i) => i > 5 ? { ...bar, high: 9999, close: 9999 } : bar);
    expect(await h.bridge.queryData(h.request('darvas'), anchor)).toEqual(first);
  });

  it('reuses current model snapshots, bounds output, and recalculates historical SMC', async () => {
    const params = resolveIndicatorParams('smart-money-concepts-v3', { internalLength: 3, swingLength: 10 });
    const result = calculateSmartMoneyConceptsV3(bars(), smcAnalysisOptions(params, 3600));
    expect(result.structures.length).toBeGreaterThan(0);
    const snapshot = { result, calculation: {} };
    const h = harness({ indicators: [{ id: 'smart-money-concepts-v3', params }], snapshot });
    const current = await h.bridge.queryData(h.request('smc', {}, 2), h.bridge.getContext()!);
    expect(current.data).toMatchObject({ calculationSource: 'chart-snapshot', structures: result.structures.slice(-2) });
    const payload = current.data as { structures: object[]; pivots: object[] };
    expect(payload.structures.length).toBeLessThanOrEqual(2);
    expect(payload.pivots.length).toBeLessThanOrEqual(2);
    h.source.visibleIndices = { from: 0, to: 180 };
    const historical = await h.bridge.queryData(h.request('smc'), h.bridge.getContext()!);
    const expected = calculateSmartMoneyConceptsV3(bars().slice(0, 181), smcAnalysisOptions(params, 3600));
    expect(historical.data).toMatchObject({ calculationSource: 'anchored-calculation', structures: expected.structures.slice(-5) });
    expect(snapshot.result).toBe(result);
  });

  it('does not reuse snapshots for different parameters or guess between SMC versions', async () => {
    const h = harness({ indicators: [{ id: 'smart-money-concepts-v3', params: {} }], snapshot: { result: {}, calculation: {} } });
    const result = await h.bridge.queryData(h.request('smc-v3', { swingLength: 20 }), h.bridge.getContext()!);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ calculationSource: 'anchored-calculation', params: { swingLength: 20 } });
    h.source.indicators.push({ id: 'smart-money-concepts-v2', params: {} });
    expect(await h.bridge.queryData(h.request('smc'), h.bridge.getContext()!)).toMatchObject({ ok: false, error: expect.stringContaining('Multiple SMC') });
  });

  it('reports unavailable external FVG instead of inventing an empty signal', async () => {
    const h = harness({ end: 100, indicators: [{ id: 'smart-money-concepts-v3', params: { showFairValueGaps: true, fvgTimeframe: '15' } }] });
    const result = await h.bridge.queryData(h.request('smc'), h.bridge.getContext()!);
    expect(result.ok).toBe(true);
    expect((result.data as { limitations: string[] }).limitations.join(' ')).toContain('FVG is unavailable');
  });

  it('clips external SMC timeframe inputs before historical calculation', async () => {
    const raw = Array.from({ length: 200 }, (_, i) => ({ time: start + i * 900, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i }));
    const h = harness({ end: 10,
      indicators: [{ id: 'smart-money-concepts-v3', params: { showFairValueGaps: true, fvgTimeframe: '15', periodUtcOffsetHours: 0 } }],
      snapshot: { result: {}, calculation: { fvgCandles: raw } } });
    const anchor = h.bridge.getContext()!;
    const before = await h.bridge.queryData(h.request('smc-v3'), anchor);
    expect(before.ok).toBe(true);
    expect(before.data).toMatchObject({ features: { fairValueGaps: 'available' } });
    for (const bar of raw) if (bar.time + 900 > start + 11 * 3600) { bar.high = 100000; bar.close = 100000; }
    expect(await h.bridge.queryData(h.request('smc-v3'), anchor)).toEqual(before);
  });

  it('rejects snapshot reuse when its provider bars extend beyond the chart anchor', async () => {
    const raw = [{ time: start, open: 100, high: 102, low: 99, close: 101 },
      { time: start + 500 * 3600, open: 100, high: 100000, low: 99, close: 100000 }];
    const h = harness({ indicators: [{ id: 'smart-money-concepts-v3', params: { showFairValueGaps: true, fvgTimeframe: '15' } }],
      snapshot: { result: {}, calculation: { fvgTimeframe: '15', fvgCandles: raw } } });
    const result = await h.bridge.queryData(h.request('smc-v3'), h.bridge.getContext()!);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ calculationSource: 'anchored-calculation' });
  });

  it('returns actual Nikkei prices and never aggregates future intrabars into replay', async () => {
    const raw = Array.from({ length: 12 }, (_, i) => ({ time: start + i * 900, open: 30000 + i, high: 30010 + i, low: 29990 + i, close: 30005 + i }));
    const h = harness({ end: 1, replay: { phase: 'paused', currentTime: start + 5400 }, indicators: [{ id: 'nikkei-225', params: {} }],
      snapshot: { result: [], calculation: { rawCandles: raw, rawInterval: '15m', status: '^N225' } } });
    const anchor = h.bridge.getContext()!;
    const first = await h.bridge.queryData(h.request('nikkei'), anchor);
    expect(first.ok).toBe(true);
    const values = (first.data as { values: { chartTime: number; candle: Candle | null }[] }).values;
    expect(values[values.length - 1].candle!.close).toBe(30010); // intrabar 5 closes exactly at the replay cursor
    raw[6].high = 999999;
    raw[6].close = 999999;
    expect(await h.bridge.queryData(h.request('nikkei'), anchor)).toEqual(first);
  });

  it('loads Nikkei using the allowlisted symbol when no snapshot exists', async () => {
    const getHistory = vi.fn(async () => bars());
    const feed: Datafeed = { name: 'mock', getHistory, subscribe: () => () => undefined };
    const h = harness({ feed });
    const result = await h.bridge.queryData(h.request('nikkei-225'), h.bridge.getContext()!);
    expect(result.ok).toBe(true);
    expect(getHistory.mock.calls[0]).toEqual(expect.arrayContaining(['^N225', '1h']));
  });

  it('rejects a replay change while provider data is loading', async () => {
    const h = harness();
    const feed: Datafeed = { name: 'mock', subscribe: () => () => undefined, getHistory: async () => {
      h.source.replay = { phase: 'paused', currentTime: start };
      return bars();
    } };
    const bridge = createAssistantBridge({ getPrimarySource: () => h.source, getDatafeed: () => feed });
    const result = await bridge.queryData(h.request('nikkei'), bridge.getContext()!);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Chart/Replay changed') });
  });

  it('reports older Nikkei history separately from page size and pages without overlap', async () => {
    const raw = bars(600).map((bar, i) => ({ ...bar, time: Date.UTC(2025, 0, 1) / 1000 + i * 86400 }));
    const h = harness({ indicators: [{ id: 'nikkei-225', params: {} }],
      snapshot: { result: [], calculation: { rawCandles: raw, rawInterval: '1d' } } });
    Object.assign(h.source, { timeframe: '1d', intervalSeconds: 86400, candles: raw, visibleIndices: { from: 0, to: 599 } });
    const anchor = h.bridge.getContext()!;
    const result = await h.bridge.queryData(h.request('nikkei', {}, 120), anchor);
    expect(result.ok).toBe(true);
    const first = result.data as { history: { availableCount: number; availableRange: { from: number }; nextBeforeTime: number; monthly: { period: string }[] }; values: { chartTime: number }[] };
    expect(first.values).toHaveLength(120);
    expect(first.history.availableCount).toBe(600);
    expect(first.history.availableRange.from).toBe(raw[0].time);
    expect(first.history.monthly[0].period).toBe('2025-01');
    const older = await h.bridge.queryData({ ...h.request('nikkei', {}, 120), beforeTime: first.history.nextBeforeTime }, anchor);
    expect(older.ok).toBe(true);
    const second = older.data as typeof first;
    expect(second.values).toHaveLength(120);
    expect(second.values[second.values.length - 1].chartTime).toBe(raw[479].time);
    expect(second.values.every(point => point.chartTime < first.history.nextBeforeTime)).toBe(true);
    const future = await h.bridge.queryData({ ...h.request('nikkei', {}, 120), beforeTime: raw[599].time + 1000000 }, anchor);
    expect((future.data as typeof first).values).toEqual(first.values);
  });

  it('fetches an older requested window when both chart memory and Nikkei snapshot are newer', async () => {
    const old = bars(200).map(bar => ({ ...bar, time: bar.time - 365 * 86400 }));
    const getHistory = vi.fn(async () => old);
    const feed: Datafeed = { name: 'mock', getHistory, subscribe: () => () => undefined };
    const h = harness({ feed, indicators: [{ id: 'nikkei-225', params: {} }],
      snapshot: { result: [], calculation: { rawCandles: bars(), rawInterval: '1h' } } });
    const beforeTime = old[199].time + 3600;
    const result = await h.bridge.queryData({ ...h.request('nikkei', {}, 120), beforeTime }, h.bridge.getContext()!);
    expect(result.ok).toBe(true);
    const values = (result.data as { values: { chartTime: number }[] }).values;
    expect(values).toHaveLength(120);
    expect(values.every(point => point.chartTime < beforeTime)).toBe(true);
    expect(getHistory).toHaveBeenCalledTimes(2);
    expect(getHistory.mock.calls[1]).toEqual(expect.arrayContaining(['^N225', '1h']));
  });

  it.each(['codex', 'chatgpt'] as const)('executes real indicator tools through the %s turn loop', async provider => {
    const h = harness({ indicators: [{ id: 'darvas-box', params: {} }, { id: 'smart-money-concepts-v3', params: {} }] });
    const chat = vi.fn(async (payload: ChatRequest) => {
      if (!payload.toolResults) return { message: '', requests: [h.request('darvas-box'), h.request('smart-money-concepts-v3')] };
      expect(payload.toolResults.every(result => result.ok)).toBe(true);
      expect(payload.toolResults.map(result => (result.data as { kind: string }).kind)).toEqual(['boxes', 'smc']);
      return { message: 'Answer based on verified boxes and structures.' };
    });
    const answer = await runAssistantTurn({ client: { chat } as unknown as AssistantApiClient,
      bridge: h.bridge, context: h.bridge.getContext()!, message: 'Phân tích Darvas và SMC V3',
      conversation: [], provider, model: null, reasoningEffort: 'medium', setRequestId() {}, cancelled: () => false });
    expect(answer).toContain('verified');
    expect(chat).toHaveBeenCalledTimes(2);
  });
});
