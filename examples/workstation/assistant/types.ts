export type AssistantMode = 'chat' | 'analyze';
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

export interface AssistantChartContext {
  version: 1;
  generatedAt: string;
  symbol: string;
  timeframe: string;
  mode: string;
  replay: Record<string, unknown>;
  historyRange: { from: number; to: number } | null;
  candleCount: number;
  candles: AssistantCandle[];
  indicators: AssistantIndicator[];
}

export interface AssistantConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TradePlan {
  decision: 'LONG' | 'SHORT' | 'WAIT';
  confidence: number;
  marketRegime: string;
  entryZone: { from: number; to: number } | null;
  stopLoss: number | null;
  targets: number[];
  riskReward: number | null;
  expiryBars: number;
  invalidation: string;
  reasons: string[];
  warnings: string[];
}

export interface AssistantResponse {
  message: string;
  tradePlan: TradePlan | null;
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
}

declare global {
  interface Window {
    __L2CHART_ASSISTANT__?: AssistantBridge;
  }
}
