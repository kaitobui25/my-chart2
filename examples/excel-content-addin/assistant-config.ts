import type { ReasoningEffort } from '../assistant/types';

export const EXCEL_ASSISTANT_CONFIG = Object.freeze({
  apiBaseUrl: '/assistant-api',
  storageKey: 'l2chart.excel.assistant.settings.v1',
  maxConversationMessages: 10,
  defaultReasoningEffort: 'medium' as ReasoningEffort,
});

export const REASONING_LABELS: Readonly<Record<ReasoningEffort, string>> = Object.freeze({
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
});

export const ALL_REASONING_EFFORTS: readonly ReasoningEffort[] = Object.freeze([
  'low', 'medium', 'high', 'xhigh',
]);
