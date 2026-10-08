import { describe, expect, it, vi } from 'vitest';
import type { Datafeed, Candle, HistoryRange } from '../../src/index';
import { createAssistantBridge } from '../../examples/assistant/context';
import { runAssistantTurn } from '../../examples/assistant/chat-runner';
import type { AssistantApiClient, ChatRequest } from '../../examples/assistant/client';
import type { AssistantDataRequest } from '../../examples/assistant/types';

function candles(count: number, start = 1700000000, spacing = 86400): Candle[] {
  return Array.from({ length: count }, (_, index) => ({
    time: start + index * spacing,
    open: 100 + index, high: 102 + index, low: 99 + index, close: 101 + index,
    volume: 1000 + index,
  }));
}

const request = (tool: AssistantDataRequest['tool'], timeframe = 'current'): AssistantDataRequest => ({
  tool, timeframe, id: tool === 'get_indicator' ? 'rsi' : '',
  limit: 5, paramsJson: '{"length":14}',
});

describe('AI read-only chart data requests', () => {
  it('serves the selected chart history and indicator results without future candles', async () => {
    const data = candles(100);
    const bridge = createAssistantBridge({
      getPrimarySource: () => ({
        symbol: '7203.T', timeframe: '1d', mode: 'candles',
        replay: { phase: 'paused' }, historyRange: null,
        candles: data, visibleIndices: { from: 45, to: 50 },
        indicators: [], quote: null,
      }),
      getDatafeed: () => null,
    });
    const anchor = bridge.getContext()!;
    const result = await bridge.queryData(request('get_indicator'), anchor);
    expect(result.ok).toBe(true);
    const values = (result.data as { values: Record<string, { time: number; value: number | null }[]> }).values;
    expect(values.RSI).toHaveLength(5);
    expect(values.RSI.every(point => point.time <= data[50].time)).toBe(true);
    expect(values.RSI[4].value).toBeTypeOf('number');
  });

  it('loads extra timeframe candles only up to the visible anchor', async () => {
    const data = candles(100);
    const weekly = [...candles(12, data[50].time - 12 * 604800, 604800), data[80]];
    const getHistory = vi.fn(async (_symbol: string, _interval: string, _limit?: number, _range?: HistoryRange) => weekly);
    const feed: Datafeed = { name: 'mock', getHistory, subscribe: () => () => undefined };
    const bridge = createAssistantBridge({
      getPrimarySource: () => ({
        symbol: '7203.T', timeframe: '1d', mode: 'candles', replay: {},
        historyRange: null, candles: data, visibleIndices: { from: 45, to: 50 },
        indicators: [], quote: null,
      }),
      getDatafeed: () => feed,
    });
    const anchor = bridge.getContext()!;
    const result = await bridge.queryData({ ...request('get_candles', '1w'), limit: 10 }, anchor);
    expect(result.ok).toBe(true);
    const returned = (result.data as { candles: Candle[] }).candles;
    expect(returned.every(bar => bar.time <= data[50].time)).toBe(true);
    expect(getHistory).toHaveBeenCalledOnce();
    expect(getHistory.mock.calls[0][3]?.to).toBe(data[50].time);
  });

  it('runs a Codex data request and uses the returned data in the next model turn', async () => {
    const replies = [
      { message: '', requests: [request('get_indicator')] },
      { message: 'RSI was computed from the chart.' },
    ];
    const chat = vi.fn(async (_payload: ChatRequest) => replies.shift()!);
    const queryData = vi.fn(async (item: AssistantDataRequest) => ({
      request: item, ok: true, data: { values: { RSI: [{ time: 1700000000, value: 55 }] } },
    }));
    const bridge = { getContext: () => null, resolveContext: async () => null, queryData };
    const context = {
      version: 2 as const, generatedAt: '', symbol: '7203.T', timeframe: '1d',
      mode: 'candles', replay: {}, historyRange: null, visibleRange: null,
      candleCount: 0, candles: [], indicators: [], quote: null, additionalTimeframes: [],
    };
    const answer = await runAssistantTurn({
      client: { chat } as unknown as AssistantApiClient, bridge, context,
      message: 'Check RSI', conversation: [], provider: 'codex',
      model: null, reasoningEffort: 'medium',
      setRequestId: () => undefined, cancelled: () => false,
    });
    expect(answer).toBe('RSI was computed from the chart.');
    expect(chat).toHaveBeenCalledTimes(2);
    expect(queryData).toHaveBeenCalledOnce();
    expect(chat.mock.calls[1][0].toolResults).toEqual([
      expect.objectContaining({ ok: true, data: expect.objectContaining({ values: expect.any(Object) }) }),
    ]);
  });

  it('rejects an invalid request without exposing arbitrary files or URLs', async () => {
    const data = candles(100);
    const bridge = createAssistantBridge({
      getPrimarySource: () => ({
        symbol: 'FPT', timeframe: '1d', mode: 'candles', replay: {},
        historyRange: null, candles: data, visibleIndices: null, indicators: [], quote: null,
      }),
      getDatafeed: () => null,
    });
    const result = await bridge.queryData({ ...request('get_indicator'), timeframe: '../private' }, bridge.getContext()!);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unsupported timeframe/);
  });
});
