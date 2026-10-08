import { AssistantApiClient } from '../assistant/client';
import { runAssistantTurn } from '../assistant/chat-runner';
import type {
  AssistantBridge,
  AssistantChartContext,
  AssistantConversationMessage,
  AssistantProvider,
  CodexModelOption,
  CodexRateLimitBucket,
  CodexStatusResponse,
  ReasoningEffort,
} from '../assistant/types';
import {
  ALL_REASONING_EFFORTS,
  ASSISTANT_PROVIDERS,
  EXCEL_ASSISTANT_CONFIG,
} from './assistant-config';
import { AssistantPanelView } from './assistant-view';

interface StoredSettings {
  provider?: AssistantProvider;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

const QUOTA_REFRESH_MS = 60_000;
const FIVE_HOUR_WINDOW_MINUTES = 5 * 60;
const WEEK_WINDOW_MINUTES = 7 * 24 * 60;

export function formatCodexQuotaSummary(response: CodexStatusResponse): string {
  const buckets = [response.rateLimits.primary, response.rateLimits.secondary].filter(
    (bucket): bucket is CodexRateLimitBucket => bucket !== null,
  );
  const fiveHour = buckets.find((bucket) => bucket.windowDurationMins === FIVE_HOUR_WINDOW_MINUTES);
  const week = buckets.find((bucket) => bucket.windowDurationMins === WEEK_WINDOW_MINUTES);
  return `5h ${formatRemainingPercent(fiveHour)} · tuần ${formatRemainingPercent(week)}`;
}

export class ExcelAssistantController {
  private readonly client = new AssistantApiClient(EXCEL_ASSISTANT_CONFIG.apiBaseUrl);
  private readonly view = new AssistantPanelView();
  private conversation: AssistantConversationMessage[] = [];
  private modelOptions: CodexModelOption[] = [];
  private defaultReasoningEfforts: ReasoningEffort[] = [...ALL_REASONING_EFFORTS];
  private provider: AssistantProvider = EXCEL_ASSISTANT_CONFIG.defaultProvider;
  private model = '';
  private reasoningEffort: ReasoningEffort = EXCEL_ASSISTANT_CONFIG.defaultReasoningEffort;
  private requestId: string | null = null;
  private busy = false;
  private cancelRequested = false;
  private assistantConnected = false;
  private providerGeneration = 0;
  private quotaRefreshInFlight = false;
  private quotaRefreshTimer: number | null = null;
  private readonly cleanup: Array<() => void> = [];

  constructor(private readonly bridge: AssistantBridge) {
    this.restoreSettings();
    this.view.provider.value = this.provider;
    this.bindEvents();
    this.view.appendMessage('assistant', 'Sẵn sàng. Hỏi trực tiếp về vùng chart đang xem.', false);
    this.refreshContext();
    void this.initializeConnection();
  }

  dispose(): void {
    this.stopQuotaRefresh();
    for (const dispose of this.cleanup.splice(0)) dispose();
    if (this.requestId) void this.client.cancel(this.requestId).catch(() => undefined);
  }

  refreshContext(): void {
    const context = this.bridge.getContext();
    this.view.setContext(context
      ? `${context.symbol} · ${context.timeframe} · ${context.candleCount} nến`
      : 'Chưa có dữ liệu chart');
  }

  private bindEvents(): void {
    this.listen(this.view.toggle, 'click', () => {
      this.view.togglePanel();
      if (this.view.isOpen) {
        this.refreshContext();
        void this.checkHealth();
      }
    });
    this.listen(this.view.close, 'click', () => this.view.hide());
    this.listen(this.view.settingsToggle, 'click', () => this.view.toggleSettings());
    this.listen(this.view.fresh, 'click', () => {
      void this.newConversation();
    });
    this.listen(this.view.provider, 'change', () => {
      void this.applyProviderSelection(this.view.provider.value);
    });
    this.listen(this.view.model, 'change', () => this.applyModelSelection(this.view.model.value));
    this.listen(this.view.reasoning, 'change', () => {
      this.reasoningEffort = this.view.reasoning.value as ReasoningEffort;
      this.persistSettings();
    });
    this.listen(this.view.cancel, 'click', () => this.cancel());
    this.listen(this.view.panel, 'keydown', (event) => {
      const keyboard = event as KeyboardEvent;
      if (keyboard.key === 'Escape' && !keyboard.isComposing && this.view.isOpen) {
        keyboard.preventDefault();
        keyboard.stopPropagation();
        this.view.hide();
      }
    });
    this.listen(this.view.input, 'keydown', (event) => {
      const keyboard = event as KeyboardEvent;
      if (keyboard.key === 'Enter' && !keyboard.shiftKey && !keyboard.isComposing) {
        keyboard.preventDefault();
        void this.submit(this.view.input.value);
      }
    });
    const form = requiredElement<HTMLFormElement>('#assistant-form');
    this.listen(form, 'submit', (event) => {
      event.preventDefault();
      void this.submit(this.view.input.value);
    });
  }

  private listen(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    target.addEventListener(type, listener);
    this.cleanup.push(() => target.removeEventListener(type, listener));
  }

  private async initializeConnection(): Promise<void> {
    await Promise.allSettled([this.checkHealth(), this.loadModels()]);
  }

  private async checkHealth(): Promise<void> {
    const provider = this.provider;
    const generation = this.providerGeneration;
    try {
      const health = await this.client.health(provider);
      if (provider !== this.provider || generation !== this.providerGeneration) return;
      if (health.provider !== provider) {
        this.view.setConnectionStatus(
          `Sidecar không khớp provider (${health.provider ?? 'cũ'}). Hãy khởi động lại Excel dev server.`,
          false,
        );
        this.setAssistantConnected(false);
        return;
      }
      this.view.setConnectionStatus(
        health.assistantAvailable ? `${providerLabel(provider)} sẵn sàng` : health.detail,
        health.assistantAvailable,
      );
      this.setAssistantConnected(health.assistantAvailable);
    } catch (error) {
      if (provider !== this.provider || generation !== this.providerGeneration) return;
      this.view.setConnectionStatus(errorMessage(error), false);
      this.setAssistantConnected(false);
    }
  }

  private setAssistantConnected(connected: boolean): void {
    this.assistantConnected = connected;
    if (!connected || this.provider !== 'codex') {
      this.stopQuotaRefresh();
      this.view.setQuota(null);
      return;
    }
    this.stopQuotaRefresh();
    void this.refreshQuota();
    this.quotaRefreshTimer = window.setInterval(() => void this.refreshQuota(), QUOTA_REFRESH_MS);
  }

  private stopQuotaRefresh(): void {
    if (this.quotaRefreshTimer !== null) window.clearInterval(this.quotaRefreshTimer);
    this.quotaRefreshTimer = null;
  }

  private async refreshQuota(): Promise<void> {
    if (this.provider !== 'codex' || !this.assistantConnected || this.quotaRefreshInFlight) return;
    const provider = this.provider;
    const generation = this.providerGeneration;
    this.quotaRefreshInFlight = true;
    try {
      const response = await this.client.status({
        provider,
        model: this.model || null,
        reasoningEffort: this.reasoningEffort,
      });
      if (provider !== this.provider || generation !== this.providerGeneration) return;
      if (response.provider === 'chatgpt') {
        this.view.setQuota(null);
        return;
      }
      this.view.setQuota(formatCodexQuotaSummary(response));
    } catch {
      this.view.setQuota(null);
    } finally {
      this.quotaRefreshInFlight = false;
    }
  }

  private async loadModels(): Promise<void> {
    const provider = this.provider;
    const generation = this.providerGeneration;
    try {
      const response = await this.client.options(provider);
      if (provider !== this.provider || generation !== this.providerGeneration) return;
      this.modelOptions = Array.isArray(response.models) ? response.models : [];
      this.defaultReasoningEfforts = Array.isArray(response.reasoningEfforts)
        ? response.reasoningEfforts.filter(isReasoningEffort)
        : [...ALL_REASONING_EFFORTS];
      if (this.defaultReasoningEfforts.length === 0) {
        this.defaultReasoningEfforts = [...ALL_REASONING_EFFORTS];
      }
      if (this.model && !this.modelOptions.some((option) => option.id === this.model)) {
        this.model = '';
      }
    } catch {
      if (provider !== this.provider || generation !== this.providerGeneration) return;
      this.modelOptions = [];
      this.defaultReasoningEfforts = [...ALL_REASONING_EFFORTS];
    }
    this.view.setModels(this.modelOptions, this.model, provider);
    this.applyModelSelection(this.model, false);
    this.persistSettings();
  }

  private async applyProviderSelection(value: string): Promise<void> {
    const next = isAssistantProvider(value) ? value : EXCEL_ASSISTANT_CONFIG.defaultProvider;
    this.view.provider.value = next;
    if (next === this.provider) return;
    this.provider = next;
    this.providerGeneration += 1;
    this.model = '';
    this.reasoningEffort = EXCEL_ASSISTANT_CONFIG.defaultReasoningEffort;
    this.modelOptions = [];
    this.defaultReasoningEfforts = [...ALL_REASONING_EFFORTS];
    this.conversation = [];
    this.stopQuotaRefresh();
    this.view.setQuota(null);
    this.view.setModels([], '', this.provider);
    this.view.renderReasoningOptions(this.defaultReasoningEfforts, this.reasoningEffort);
    this.view.clearMessages();
    this.view.appendMessage('assistant', `Đã chuyển sang ${providerLabel(this.provider)}. Context vẫn theo chart hiện tại.`);
    this.view.setConnectionStatus(`Đang kết nối ${providerLabel(this.provider)}…`, false);
    this.persistSettings();
    void this.checkHealth();
    void this.loadModels();
    this.view.focusInput();
  }

  private applyModelSelection(value: string, persist = true): void {
    this.model = value;
    const selected = this.modelOptions.find((option) => option.id === this.model);
    const supported = selected?.supportedReasoningEfforts?.filter(isReasoningEffort).length
      ? selected.supportedReasoningEfforts.filter(isReasoningEffort)
      : this.defaultReasoningEfforts;
    const preferred = selected?.defaultReasoningEffort ?? this.reasoningEffort;
    this.reasoningEffort = supported.includes(this.reasoningEffort)
      ? this.reasoningEffort
      : supported.includes(preferred)
        ? preferred
        : supported[0] ?? EXCEL_ASSISTANT_CONFIG.defaultReasoningEffort;
    this.view.renderReasoningOptions(supported, this.reasoningEffort);
    if (persist) this.persistSettings();
  }

  private async newConversation(): Promise<void> {
    if (this.busy) return;
    this.setBusy(true, false);
    try {
      const response = await this.client.newConversation({
        provider: this.provider,
        model: this.model || null,
        reasoningEffort: this.reasoningEffort,
      });
      if (response.selection && isReasoningEffort(response.selection.reasoningEffort)) {
        this.reasoningEffort = response.selection.reasoningEffort;
        this.applyModelSelection(this.model, false);
      }
      this.conversation = [];
      this.view.clearMessages();
      this.view.appendMessage(
        'assistant',
        `Cuộc trò chuyện ${providerLabel(this.provider)} mới. Context vẫn theo chart hiện tại.`,
      );
      this.refreshContext();
      this.view.setConnectionStatus(`${providerLabel(this.provider)} sẵn sàng`, true);
      this.setAssistantConnected(true);
      this.persistSettings();
    } catch (error) {
      this.view.appendMessage('assistant', `Lỗi tạo cuộc trò chuyện mới: ${errorMessage(error)}`);
      this.view.setConnectionStatus(errorMessage(error), false);
    } finally {
      this.setBusy(false, false);
      this.view.focusInput();
    }
  }

  private async submit(raw: string): Promise<void> {
    const message = raw.trim();
    if (!message || this.busy) return;
    this.view.clearInput();
    if (message.toLowerCase() === '/status') {
      await this.showStatus(message);
      return;
    }

    const baseContext = this.bridge.getContext();
    if (!baseContext) {
      this.view.appendMessage('assistant', 'Chưa có dữ liệu chart để gửi cho trợ lý.');
      return;
    }

    this.view.appendMessage('user', message);
    this.cancelRequested = false;
    this.setBusy(true, false);
    this.view.showThinking();
    try {
      const context = await this.bridge.resolveContext(message) ?? baseContext;
      if (this.cancelRequested) throw new Error('Request cancelled.');
      this.renderContext(context);
      const answer = await runAssistantTurn({
        client: this.client,
        bridge: this.bridge,
        context,
        provider: this.provider,
        message,
        model: this.model || null,
        reasoningEffort: this.reasoningEffort,
        conversation: this.conversation.slice(-EXCEL_ASSISTANT_CONFIG.maxConversationMessages),
        setRequestId: (id) => {
          this.requestId = id;
          this.setBusy(true, id !== null);
        },
        cancelled: () => this.cancelRequested,
      });
      this.view.removeThinking();
      if (this.cancelRequested) {
        this.view.appendMessage('assistant', 'Đã dừng chờ phản hồi.');
        return;
      }
      this.view.appendMessage('assistant', answer);
      const nextConversation: AssistantConversationMessage[] = [
        ...this.conversation,
        { role: 'user', content: message },
        { role: 'assistant', content: answer },
      ];
      this.conversation = nextConversation.slice(-EXCEL_ASSISTANT_CONFIG.maxConversationMessages);
      this.view.setConnectionStatus(`${providerLabel(this.provider)} sẵn sàng`, true);
      this.setAssistantConnected(true);
      void this.refreshQuota();
    } catch (error) {
      this.view.removeThinking();
      this.view.appendMessage(
        'assistant',
        this.cancelRequested ? 'Đã dừng chờ phản hồi.' : `Lỗi: ${errorMessage(error)}`,
      );
      if (!this.cancelRequested) this.view.setConnectionStatus(errorMessage(error), false);
    } finally {
      this.requestId = null;
      this.cancelRequested = false;
      this.setBusy(false, false);
    }
  }

  private async showStatus(command: string): Promise<void> {
    this.view.appendMessage('user', command);
    this.setBusy(true, false);
    this.view.showThinking();
    try {
      const response = await this.client.status({
        provider: this.provider,
        model: this.model || null,
        reasoningEffort: this.reasoningEffort,
      });
      this.view.removeThinking();
      if (response.provider === 'chatgpt') {
        const selected = response.selected.model || 'ChatGPT current';
        const conversation = response.conversationId ? ` · ${response.conversationId}` : '';
        this.view.appendMessage(
          'assistant',
          `ChatGPT Bridge · ${selected} · ${response.selected.reasoningEffort}${conversation}`,
        );
        return;
      }
      const account = response.account?.email ?? response.account?.planType ?? 'Codex';
      const primary = response.rateLimits.primary;
      const remaining = primary?.remainingPercent;
      const quota = remaining === null || remaining === undefined
        ? 'quota không khả dụng'
        : `còn ${Math.round(remaining)}%`;
      this.view.appendMessage('assistant', `${account} · ${quota}`);
    } catch (error) {
      this.view.removeThinking();
      this.view.appendMessage('assistant', `Lỗi: ${errorMessage(error)}`);
    } finally {
      this.setBusy(false, false);
    }
  }

  private cancel(): void {
    if (!this.requestId) return;
    this.cancelRequested = true;
    this.setBusy(true, false);
    void this.client.cancel(this.requestId).catch(() => undefined);
  }

  private setBusy(value: boolean, cancellable = false): void {
    this.busy = value;
    this.view.setBusy(value, cancellable);
  }

  private renderContext(context: AssistantChartContext): void {
    const extras = context.additionalTimeframes.length > 0
      ? ` · +${context.additionalTimeframes.map((item) => item.timeframe).join(', ')}`
      : '';
    this.view.setContext(`${context.symbol} · ${context.timeframe} · ${context.candleCount} nến${extras}`);
  }

  private restoreSettings(): void {
    try {
      const value = JSON.parse(localStorage.getItem(EXCEL_ASSISTANT_CONFIG.storageKey) ?? '{}') as StoredSettings;
      this.provider = isAssistantProvider(value.provider)
        ? value.provider
        : EXCEL_ASSISTANT_CONFIG.defaultProvider;
      this.model = typeof value.model === 'string' ? value.model : '';
      this.reasoningEffort = ALL_REASONING_EFFORTS.includes(value.reasoningEffort ?? EXCEL_ASSISTANT_CONFIG.defaultReasoningEffort)
        ? value.reasoningEffort as ReasoningEffort
        : EXCEL_ASSISTANT_CONFIG.defaultReasoningEffort;
    } catch {
      this.provider = EXCEL_ASSISTANT_CONFIG.defaultProvider;
      this.model = '';
      this.reasoningEffort = EXCEL_ASSISTANT_CONFIG.defaultReasoningEffort;
    }
  }

  private persistSettings(): void {
    try {
      localStorage.setItem(EXCEL_ASSISTANT_CONFIG.storageKey, JSON.stringify({
        provider: this.provider,
        model: this.model,
        reasoningEffort: this.reasoningEffort,
      } satisfies StoredSettings));
    } catch {
      // Storage is optional; the assistant remains usable without persistence.
    }
  }
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing Excel assistant element: ${selector}`);
  return element;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && ALL_REASONING_EFFORTS.includes(value as ReasoningEffort);
}

function isAssistantProvider(value: unknown): value is AssistantProvider {
  return typeof value === 'string' && ASSISTANT_PROVIDERS.includes(value as AssistantProvider);
}

function providerLabel(provider: AssistantProvider): string {
  return provider === 'codex' ? 'Codex' : 'ChatGPT';
}

function formatRemainingPercent(bucket: CodexRateLimitBucket | undefined): string {
  const remaining = bucket?.remainingPercent;
  return remaining === null || remaining === undefined || !Number.isFinite(remaining)
    ? '--'
    : `${Math.round(remaining)}%`;
}
