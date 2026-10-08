import type {
  AssistantChartContext,
  AssistantConversationMessage,
  AssistantDataResult,
  AssistantHealthResponse,
  AssistantNewConversationResponse,
  AssistantOptionsResponse,
  AssistantProvider,
  AssistantResponse,
  AssistantStatusResponse,
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
  provider?: AssistantProvider;
  message: string;
  model: string | null;
  reasoningEffort: ReasoningEffort;
  conversation: AssistantConversationMessage[];
  context: AssistantChartContext;
  toolResults?: AssistantDataResult[];
}

const CLIENT_SESSION_STORAGE_KEY = 'l2chart.assistant.clientSessionId.v1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function newClientSessionId(): string {
  return crypto.randomUUID();
}

function resolveClientSessionId(): string {
  const generated = newClientSessionId();
  try {
    const existing = sessionStorage.getItem(CLIENT_SESSION_STORAGE_KEY);
    if (existing && UUID_PATTERN.test(existing)) return existing;
    sessionStorage.setItem(CLIENT_SESSION_STORAGE_KEY, generated);
  } catch {
    // Storage can be unavailable in embedded/private contexts. This instance still
    // gets a stable id for its own lifetime.
  }
  return generated;
}

export class AssistantApiClient {
  private readonly clientSessionId: string;

  constructor(
    private readonly baseUrl = '/assistant-api',
    clientSessionId = resolveClientSessionId(),
  ) {
    this.clientSessionId = UUID_PATTERN.test(clientSessionId) ? clientSessionId : newClientSessionId();
  }

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

  health(provider: AssistantProvider = 'chatgpt'): Promise<AssistantHealthResponse> {
    return this.request(`/health?provider=${encodeURIComponent(provider)}`);
  }

  options(provider: AssistantProvider = 'chatgpt'): Promise<AssistantOptionsResponse> {
    return this.request(`/options?provider=${encodeURIComponent(provider)}`);
  }

  status(payload: {
    provider?: AssistantProvider;
    model: string | null;
    reasoningEffort: ReasoningEffort;
  }): Promise<AssistantStatusResponse> {
    return this.request('/status', {
      method: 'POST',
      body: JSON.stringify({
        ...payload,
        provider: payload.provider ?? 'chatgpt',
        clientSessionId: this.clientSessionId,
      }),
    });
  }

  chat(payload: ChatRequest): Promise<AssistantResponse> {
    return this.request('/chat', {
      method: 'POST',
      body: JSON.stringify({
        ...payload,
        provider: payload.provider ?? 'chatgpt',
        clientSessionId: this.clientSessionId,
      }),
    });
  }

  newConversation(payload: {
    provider?: AssistantProvider;
    model: string | null;
    reasoningEffort: ReasoningEffort;
  }): Promise<AssistantNewConversationResponse> {
    return this.request('/new', {
      method: 'POST',
      body: JSON.stringify({
        ...payload,
        provider: payload.provider ?? 'chatgpt',
        clientSessionId: this.clientSessionId,
      }),
    });
  }

  cancel(requestId: string): Promise<{ cancelled: boolean }> {
    return this.request('/cancel', {
      method: 'POST',
      body: JSON.stringify({ requestId, clientSessionId: this.clientSessionId }),
    });
  }
}
