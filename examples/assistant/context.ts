import type { Candle, Datafeed } from '../../src/index';
import type {
  AssistantCandle,
  AssistantChartContext,
  AssistantDataRequest,
  AssistantDataResult,
  AssistantQuote,
  AssistantTimeframeContext,
} from './types';
import { ASSISTANT_TIMEFRAMES, loadAssistantCandles } from './candle-query';
import { queryIndicator } from './indicator-query';

const MAX_PRIMARY_CANDLES = 240;
const PRIMARY_CONTEXT_BUFFER = 12;
const FALLBACK_PRIMARY_CANDLES = 120;
const REQUESTED_TIMEFRAME_CANDLES = 160;
const REQUESTED_TIMEFRAME_FETCH_PADDING = 8;

const TIMEFRAME_ALIASES: Array<[RegExp, string]> = [
  [/\b1\s*(?:m|min|minute|p|ph(?:u|ú)t)\b/giu, '1m'],
  [/\b3\s*(?:m|min|minute|p|ph(?:u|ú)t)\b/giu, '3m'],
  [/\b5\s*(?:m|min|minute|p|ph(?:u|ú)t)\b/giu, '5m'],
  [/\b15\s*(?:m|min|minute|p|ph(?:u|ú)t)\b/giu, '15m'],
  [/\b30\s*(?:m|min|minute|p|ph(?:u|ú)t)\b/giu, '30m'],
  [/\b1\s*(?:h|hr|hour|gi(?:o|ờ))\b/giu, '1h'],
  [/\b2\s*(?:h|hr|hour|gi(?:o|ờ))\b/giu, '2h'],
  [/\b4\s*(?:h|hr|hour|gi(?:o|ờ))\b/giu, '4h'],
  [/\b(?:1d|daily|day|ng(?:a|à)y)\b/giu, '1d'],
  [/\b(?:1w|weekly|week|tu(?:a|ầ)n)\b/giu, '1w'],
  [/\b(?:1mo|1month|monthly|month|th(?:a|á)ng)\b/giu, '1M'],
];

const FRAMED_TIMEFRAME_ALIASES: Array<[RegExp, string]> = [
  [/\b(?:khung|timeframe|tf)\s*1\b/giu, '1m'],
  [/\b(?:khung|timeframe|tf)\s*3\b/giu, '3m'],
  [/\b(?:khung|timeframe|tf)\s*5\b/giu, '5m'],
  [/\b(?:khung|timeframe|tf)\s*15\b/giu, '15m'],
  [/\b(?:khung|timeframe|tf)\s*30\b/giu, '30m'],
  [/\b(?:khung|timeframe|tf)\s*(?:ng(?:a|à)y|daily|day)\b/giu, '1d'],
  [/\b(?:khung|timeframe|tf)\s*(?:tu(?:a|ầ)n|weekly|week)\b/giu, '1w'],
  [/\b(?:khung|timeframe|tf)\s*(?:th(?:a|á)ng|monthly|month)\b/giu, '1M'],
];

const APPROX_INTERVAL_SECONDS: Record<string, number> = {
  '1m': 60,
  '3m': 180,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '2h': 7200,
  '4h': 14400,
  '1d': 86400,
  '1w': 604800,
  '1M': 30 * 86400,
};

export interface AssistantPrimarySource {
  symbol: string;
  timeframe: string;
  mode: string;
  replay: Record<string, unknown>;
  historyRange: { from: number; to: number } | null;
  candles: readonly Candle[];
  visibleIndices: { from: number; to: number } | null;
  indicators: Array<{ id: string; params: Record<string, unknown> }>;
  quote: AssistantQuote | null;
}

export interface AssistantBridgeDependencies {
  getPrimarySource(): AssistantPrimarySource | null;
  getDatafeed(): Datafeed | null;
}

function toAssistantCandle(candle: Candle): AssistantCandle {
  return {
    time: candle.time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    ...(candle.volume === undefined ? {} : { volume: candle.volume }),
  };
}

export function extractRequestedTimeframes(message: string, currentTimeframe: string): string[] {
  const matches: Array<{ index: number; timeframe: string }> = [];
  for (const [pattern, timeframe] of [...TIMEFRAME_ALIASES, ...FRAMED_TIMEFRAME_ALIASES]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(message);
    while (match) {
      matches.push({ index: match.index, timeframe: match[0] === '1M' ? '1M' : timeframe });
      match = pattern.exec(message);
    }
  }
  matches.sort((left, right) => left.index - right.index);
  const requested = new Set<string>();
  for (const match of matches) {
    if (match.timeframe !== currentTimeframe) requested.add(match.timeframe);
  }
  return [...requested];
}

function visibleSlice(
  candles: readonly Candle[],
  visibleIndices: { from: number; to: number } | null,
): readonly Candle[] {
  if (candles.length === 0) return [];
  if (!visibleIndices) return candles.slice(-FALLBACK_PRIMARY_CANDLES);

  const from = Math.max(0, Math.floor(visibleIndices.from) - PRIMARY_CONTEXT_BUFFER);
  const to = Math.min(candles.length - 1, Math.ceil(visibleIndices.to) + PRIMARY_CONTEXT_BUFFER);
  const visible = candles.slice(from, to + 1);
  if (visible.length <= MAX_PRIMARY_CANDLES) return visible;

  const visibleCenter = Math.round((visibleIndices.from + visibleIndices.to) / 2);
  const half = Math.floor(MAX_PRIMARY_CANDLES / 2);
  const boundedFrom = Math.max(0, Math.min(candles.length - MAX_PRIMARY_CANDLES, visibleCenter - half));
  return candles.slice(boundedFrom, boundedFrom + MAX_PRIMARY_CANDLES);
}

function candleRange(candles: readonly AssistantCandle[]): { from: number; to: number } | null {
  if (candles.length === 0) return null;
  return { from: candles[0].time, to: candles[candles.length - 1].time };
}

export function buildPrimaryContext(source: AssistantPrimarySource): AssistantChartContext {
  const candles = visibleSlice(source.candles, source.visibleIndices).map(toAssistantCandle);
  const visibleCandles = source.visibleIndices && source.candles.length > 0
    ? source.candles.slice(
      Math.max(0, Math.floor(source.visibleIndices.from)),
      Math.min(source.candles.length, Math.ceil(source.visibleIndices.to) + 1),
    ).map(toAssistantCandle)
    : candles;

  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    symbol: source.symbol,
    timeframe: source.timeframe,
    mode: source.mode,
    replay: source.replay,
    historyRange: source.historyRange,
    visibleRange: candleRange(visibleCandles),
    candleCount: candles.length,
    candles,
    indicators: source.indicators,
    quote: source.quote,
    additionalTimeframes: [],
  };
}

function timeframeHistorySlack(timeframe: string): number {
  const seconds = APPROX_INTERVAL_SECONDS[timeframe] ?? 86400;
  return seconds < 86400 ? 4 : seconds < 604800 ? 3 : 2;
}

function requestedHistoryRange(anchorTime: number, timeframe: string): { from: number; to: number } {
  const seconds = APPROX_INTERVAL_SECONDS[timeframe] ?? 86400;
  const calendarSlack = timeframeHistorySlack(timeframe);
  const lookback = REQUESTED_TIMEFRAME_CANDLES * seconds * calendarSlack;
  return { from: Math.max(0, anchorTime - lookback), to: anchorTime };
}

function requestedHistoryFetchLimit(timeframe: string): number {
  return REQUESTED_TIMEFRAME_CANDLES * timeframeHistorySlack(timeframe) + REQUESTED_TIMEFRAME_FETCH_PADDING;
}

async function loadTimeframe(
  feed: Datafeed,
  symbol: string,
  timeframe: string,
  anchorTime: number,
): Promise<AssistantTimeframeContext> {
  const range = requestedHistoryRange(anchorTime, timeframe);
  const rangeFetchLimit = requestedHistoryFetchLimit(timeframe);
  let rangeError: unknown = null;
  let loaded: Candle[] = [];
  try {
    loaded = await feed.getHistory(symbol, timeframe, rangeFetchLimit, range);
  } catch (error) {
    rangeError = error;
  }

  let filtered = loaded.filter((candle) => candle.time <= anchorTime);
  if (filtered.length === 0) {
    try {
      const latest = await feed.getHistory(symbol, timeframe, REQUESTED_TIMEFRAME_CANDLES);
      filtered = latest.filter((candle) => candle.time <= anchorTime);
    } catch (error) {
      if (rangeError === null) rangeError = error;
    }
  }

  const candles = filtered
    .sort((a, b) => a.time - b.time)
    .slice(-REQUESTED_TIMEFRAME_CANDLES)
    .map(toAssistantCandle);
  if (candles.length > 0) {
    return { timeframe, candleCount: candles.length, range: candleRange(candles), candles };
  }

  return {
    timeframe,
    candleCount: 0,
    range: null,
    candles: [],
    error: rangeError instanceof Error
      ? rangeError.message
      : rangeError === null
        ? `Không có dữ liệu ${timeframe} cho ${symbol}.`
        : String(rangeError),
  };
}

export function createAssistantBridge(dependencies: AssistantBridgeDependencies) {
  const getContext = (): AssistantChartContext | null => {
    const source = dependencies.getPrimarySource();
    return source ? buildPrimaryContext(source) : null;
  };

  const resolveContext = async (message: string): Promise<AssistantChartContext | null> => {
    const context = getContext();
    if (!context) return null;

    const requested = extractRequestedTimeframes(message, context.timeframe);
    if (requested.length === 0) return context;

    const feed = dependencies.getDatafeed();
    if (!feed) {
      context.additionalTimeframes = requested.map((timeframe) => ({
        timeframe,
        candleCount: 0,
        range: null,
        candles: [],
        error: 'Nguồn dữ liệu hiện tại không khả dụng.',
      }));
      return context;
    }

    const anchorTime = context.visibleRange?.to
      ?? context.candles[context.candles.length - 1]?.time
      ?? Math.floor(Date.now() / 1000);
    context.additionalTimeframes = await Promise.all(
      requested.map((timeframe) => loadTimeframe(feed, context.symbol, timeframe, anchorTime)),
    );
    return context;
  };

  const queryData = async (
    request: AssistantDataRequest,
    anchor: AssistantChartContext,
  ): Promise<AssistantDataResult> => {
    try {
      const source = dependencies.getPrimarySource();
      if (!source || source.symbol !== anchor.symbol || source.timeframe !== anchor.timeframe) {
        throw new Error('Chart changed while AI was requesting data. Please ask again.');
      }
      const timeframe = request.timeframe === 'current' || !request.timeframe
        ? anchor.timeframe : request.timeframe;
      if (timeframe !== 'sheet' && !ASSISTANT_TIMEFRAMES.has(timeframe)) {
        throw new Error(`Unsupported timeframe: ${timeframe}`);
      }
      const limit = Number.isInteger(request.limit) && request.limit > 0
        ? Math.min(120, request.limit) : 30;
      const until = anchor.visibleRange?.to
        ?? anchor.candles[anchor.candles.length - 1]?.time;
      if (!Number.isFinite(until)) throw new Error('No chart timestamp available.');
      let params: Record<string, unknown> = {};
      if (request.tool === 'get_indicator' && request.paramsJson) {
        if (request.paramsJson.length > 1000) throw new Error('Indicator params too large.');
        const parsed: unknown = JSON.parse(request.paramsJson);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Indicator params must be a JSON object.');
        }
        params = parsed as Record<string, unknown>;
      }
      const calculationCount = request.tool === 'get_indicator'
        ? Math.min(2000, Math.max(500, limit + 3 * Math.max(
          50, ...Object.entries(params)
            .filter(([key]) => ['length', 'fast', 'slow', 'signal'].includes(key))
            .map(([, value]) => Number(value) || 0),
        )))
        : limit;
      const candles = timeframe === anchor.timeframe
        ? (request.tool === 'get_candles'
            ? source.candles.filter(candle => candle.time <= until).slice(-limit)
            : source.candles.filter(candle => candle.time <= until))
        : await (async () => {
            const feed = dependencies.getDatafeed();
            if (!feed) throw new Error('No datafeed for additional timeframes.');
            return loadAssistantCandles(feed, anchor.symbol, timeframe, until, calculationCount);
          })();
      if (!candles.length) throw new Error(`No candles available for ${timeframe}.`);
      if (request.tool === 'get_candles') {
        return {
          request, ok: true,
          data: {
            symbol: anchor.symbol, timeframe, until,
            candles: candles.map(toAssistantCandle),
          },
        };
      }
      if (request.tool !== 'get_indicator') throw new Error('Unknown data request.');
      const data = queryIndicator({ id: request.id, params, candles, limit });
      return { request, ok: true, data: { symbol: anchor.symbol, timeframe, until, ...data } };
    } catch (error) {
      return { request, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  return Object.freeze({ getContext, resolveContext, queryData });
}
