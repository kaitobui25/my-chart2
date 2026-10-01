export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

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

export interface AssistantResponse {
  message: string;
}

export interface CodexModelOption {
  id: string;
  label: string;
  defaultReasoningEffort: ReasoningEffort;
  supportedReasoningEfforts: ReasoningEffort[];
}

export interface CodexOptionsResponse {
  models: CodexModelOption[];
  reasoningEfforts: ReasoningEffort[];
}

export interface CodexRateLimitBucket {
  slot: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
  limitId: string | null;
}

export interface CodexStatusResponse {
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
    primary: CodexRateLimitBucket | null;
    secondary: CodexRateLimitBucket | null;
    reachedType: string | null;
    individualLimit: unknown;
    spendControlReached: boolean | null;
  };
  resetCredits: {
    availableCount: number;
    credits: unknown[] | null;
  } | null;
}

export interface AssistantBridge {
  getContext(): AssistantChartContext | null;
  resolveContext(message: string): Promise<AssistantChartContext | null>;
}

declare global {
  interface Window {
    __L2CHART_ASSISTANT__?: AssistantBridge;
  }
}
