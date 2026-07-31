import type {
  AssistantChartContext,
  AssistantConversationMessage,
  AssistantMode,
  AssistantResponse,
  CodexOptionsResponse,
  CodexStatusResponse,
  ReasoningEffort,
} from './types';

export class AssistantApiError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly code = 'ASSISTANT_ERROR',
  ) {
    super(message);
    this.name = 'AssistantApiError';
  }
}

export interface ChatRequest {
  requestId: string;
  mode: AssistantMode;
  message: string;
  model: string | null;
  reasoningEffort: ReasoningEffort;
  conversation: AssistantConversationMessage[];
  context: AssistantChartContext;
  screenshotDataUrl: string | null;
}

export class AssistantApiClient {
  constructor(private readonly baseUrl = '/assistant-api') {}

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        headers: {
          'content-type': 'application/json',
          ...(options.headers ?? {}),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AssistantApiError(`AI sidecar đang offline: ${message}`, 0, 'SIDECAR_OFFLINE');
    }

    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      throw new AssistantApiError(
        typeof payload.error === 'string' ? payload.error : `AI request failed (${response.status}).`,
        response.status,
        typeof payload.code === 'string' ? payload.code : 'ASSISTANT_ERROR',
      );
    }
    return payload as T;
  }

  health(): Promise<{ ok: boolean; codexAvailable: boolean; detail: string }> {
    return this.request('/health');
  }

  options(): Promise<CodexOptionsResponse> {
    return this.request('/options');
  }

  status(payload: { model: string | null; reasoningEffort: ReasoningEffort }): Promise<CodexStatusResponse> {
    return this.request('/status', { method: 'POST', body: JSON.stringify(payload) });
  }

  chat(payload: ChatRequest): Promise<AssistantResponse> {
    return this.request('/chat', { method: 'POST', body: JSON.stringify(payload) });
  }

  cancel(requestId: string): Promise<{ cancelled: boolean }> {
    return this.request('/cancel', { method: 'POST', body: JSON.stringify({ requestId }) });
  }
}
