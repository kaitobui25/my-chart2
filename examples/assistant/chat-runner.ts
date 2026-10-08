import type { ChatRequest } from './client';
import { AssistantApiClient } from './client';
import type {
  AssistantBridge,
  AssistantChartContext,
  AssistantConversationMessage,
  AssistantDataResult,
  AssistantProvider,
  ReasoningEffort,
} from './types';

const MAX_DATA_ROUNDS = 3;

/** One user turn may request verified chart data before producing its final answer. */
export async function runAssistantTurn(options: {
  client: AssistantApiClient;
  bridge: AssistantBridge;
  context: AssistantChartContext;
  message: string;
  conversation: AssistantConversationMessage[];
  provider: AssistantProvider;
  model: string | null;
  reasoningEffort: ReasoningEffort;
  setRequestId(id: string | null): void;
  cancelled(): boolean;
}): Promise<string> {
  let latestResults: AssistantDataResult[] = [];
  const queried = new Map<string, Promise<AssistantDataResult>>();
  for (let round = 0; round <= MAX_DATA_ROUNDS; round += 1) {
    if (options.cancelled()) throw new Error('Request cancelled.');
    const requestId = crypto.randomUUID();
    options.setRequestId(requestId);
    const payload: ChatRequest = {
      requestId,
      provider: options.provider,
      message: options.message,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      conversation: options.conversation,
      context: options.context,
      ...(latestResults.length ? { toolResults: latestResults } : {}),
    };
    const reply = await options.client.chat(payload);
    if (options.cancelled()) throw new Error('Request cancelled.');
    if (!reply.requests?.length) {
      if (!reply.message?.trim()) throw new Error('AI returned an empty answer.');
      return reply.message.trim();
    }
    if (round === MAX_DATA_ROUNDS) throw new Error('AI exceeded the chart data request limit.');
    const requests = reply.requests.slice(0, 2);
    const next = await Promise.all(requests.map((request): Promise<AssistantDataResult> => {
      const key = JSON.stringify(request);
      const existing = queried.get(key);
      if (existing) return existing;
      const task = (async (): Promise<AssistantDataResult> => {
        if (!options.bridge.queryData) {
          return { request, ok: false, error: 'Chart data queries are not available.' };
        }
        try {
          return await options.bridge.queryData(request, options.context);
        } catch (error) {
          return { request, ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      })();
      queried.set(key, task);
      return task;
    }));
    latestResults = next;
  }
  throw new Error('AI did not produce an answer.');
}
