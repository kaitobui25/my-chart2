export type ReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra'
  | 'pro';

export type AssistantProvider = 'chatgpt' | 'codex';

export interface AssistantCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface AssistantIndicator {
  id: string;
  params: Record<string, unknown>;
}

export interface AssistantQuote {
  last: number;
  bid: number | null;
  ask: number | null;
  time: number;
}

export interface AssistantTimeframeContext {
  timeframe: string;
  candleCount: number;
  range: { from: number; to: number } | null;
  candles: AssistantCandle[];
  error?: string;
}

export interface AssistantChartContext {
  version: 2;
  generatedAt: string;
  symbol: string;
  timeframe: string;
  mode: string;
  replay: Record<string, unknown>;
  historyRange: { from: number; to: number } | null;
  visibleRange: { from: number; to: number } | null;
  candleCount: number;
  candles: AssistantCandle[];
  indicators: AssistantIndicator[];
  quote: AssistantQuote | null;
  additionalTimeframes: AssistantTimeframeContext[];
}

export interface AssistantConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** The model may ask the chart for one or more read-only data queries. */
export interface AssistantDataRequest {
  tool: 'get_candles' | 'get_indicator';
  timeframe: string;
  id: string;
  limit: number;
  paramsJson: string;
}

export interface AssistantDataResult {
  request: AssistantDataRequest;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface AssistantResponse {
  message: string;
  requests?: AssistantDataRequest[];
}

export interface AssistantModelOption {
  id: string;
  label: string;
  defaultReasoningEffort: ReasoningEffort;
  supportedReasoningEfforts: ReasoningEffort[];
  aliases?: string[];
}

export interface AssistantOptionsResponse {
  models: AssistantModelOption[];
  reasoningEfforts: ReasoningEffort[];
}

/** @deprecated Kept for the Excel demo while the shared assistant API becomes provider-neutral. */
export type CodexModelOption = AssistantModelOption;
/** @deprecated Kept for the Excel demo while the shared assistant API becomes provider-neutral. */
export type CodexOptionsResponse = AssistantOptionsResponse;

export interface AssistantHealthResponse {
  ok: boolean;
  apiVersion: number;
  provider: AssistantProvider;
  assistantAvailable: boolean;
  bridgeConnected: boolean;
  detail: string;
  /** @deprecated Compatibility with the existing Excel demo. */
  codexAvailable: boolean;
}

export interface AssistantRateLimitBucket {
  slot: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
  limitId: string | null;
}

export interface AssistantStatusResponse {
  account: {
    type: string | null;
    email: string | null;
    planType: string | null;
  } | null;
  requiresOpenaiAuth: boolean | null;
  selected: {
    model: string | null;
    reasoningEffort: ReasoningEffort;
  };
  rateLimits: {
    primary: AssistantRateLimitBucket | null;
    secondary: AssistantRateLimitBucket | null;
    reachedType: string | null;
    individualLimit: unknown;
    spendControlReached: boolean | null;
  };
  resetCredits: {
    availableCount: number;
    credits: unknown[] | null;
  } | null;
  provider?: AssistantProvider;
  bridgeConnected?: boolean;
  conversationId?: string | null;
  detail?: string;
}

/** @deprecated Legacy alias retained for the Excel demo. */
export type CodexRateLimitBucket = AssistantRateLimitBucket;
/** @deprecated Legacy alias retained for the Excel demo. */
export type CodexStatusResponse = AssistantStatusResponse;

export interface AssistantNewConversationResponse {
  sessionId: string;
  conversationId: string | null;
  selection: {
    model: string;
    reasoningEffort: ReasoningEffort;
  } | null;
}

export interface AssistantBridge {
  getContext(): AssistantChartContext | null;
  resolveContext(message: string, options?: { includeAdditionalTimeframes?: boolean }): Promise<AssistantChartContext | null>;
  queryData?(request: AssistantDataRequest, anchor: AssistantChartContext): Promise<AssistantDataResult>;
}

declare global {
  interface Window {
    __L2CHART_ASSISTANT__?: AssistantBridge;
  }
}
