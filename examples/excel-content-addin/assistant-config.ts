import type { AssistantProvider, ReasoningEffort } from '../assistant/types';

export const EXCEL_ASSISTANT_CONFIG = Object.freeze({
  apiBaseUrl: '/assistant-api',
  storageKey: 'l2chart.excel.assistant.settings.v1',
  maxConversationMessages: 10,
  defaultReasoningEffort: 'medium' as ReasoningEffort,
  defaultProvider: 'chatgpt' as AssistantProvider,
});

export const ASSISTANT_PROVIDERS: readonly AssistantProvider[] = Object.freeze([
  'chatgpt',
  'codex',
]);

export const REASONING_LABELS: Readonly<Record<ReasoningEffort, string>> = Object.freeze({
  none: 'Instant',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
  pro: 'Pro',
});

export const ALL_REASONING_EFFORTS: readonly ReasoningEffort[] = Object.freeze([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'pro',
]);
