import { AssistantApiClient } from '../assistant/client';
import type {
  AssistantBridge,
  AssistantChartContext,
  AssistantConversationMessage,
  CodexModelOption,
  ReasoningEffort,
} from '../assistant/types';
import {
  ALL_REASONING_EFFORTS,
  EXCEL_ASSISTANT_CONFIG,
} from './assistant-config';
import { AssistantPanelView } from './assistant-view';

interface StoredSettings {
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export class ExcelAssistantController {
  private readonly client = new AssistantApiClient(EXCEL_ASSISTANT_CONFIG.apiBaseUrl);
  private readonly view = new AssistantPanelView();
  private conversation: AssistantConversationMessage[] = [];
  private modelOptions: CodexModelOption[] = [];
  private defaultReasoningEfforts: ReasoningEffort[] = [...ALL_REASONING_EFFORTS];
  private model = '';
  private reasoningEffort: ReasoningEffort = EXCEL_ASSISTANT_CONFIG.defaultReasoningEffort;
  private requestId: string | null = null;
  private busy = false;
  private cancelRequested = false;
  private readonly cleanup: Array<() => void> = [];

  constructor(private readonly bridge: AssistantBridge) {
    this.restoreSettings();
    this.bindEvents();
    this.view.appendMessage('assistant', 'Sẵn sàng. Hỏi trực tiếp về vùng chart đang xem.', false);
    this.refreshContext();
    void this.initializeConnection();
  }

  dispose(): void {
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
    this.listen(this.view.fresh, 'click', () => this.newConversation());
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
    try {
      const health = await this.client.health();
      this.view.setConnectionStatus(
        health.codexAvailable ? 'Sẵn sàng' : health.detail,
        health.codexAvailable,
      );
    } catch (error) {
      this.view.setConnectionStatus(errorMessage(error), false);
    }
  }

  private async loadModels(): Promise<void> {
    try {
      const response = await this.client.options();
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
      this.modelOptions = [];
      this.defaultReasoningEfforts = [...ALL_REASONING_EFFORTS];
    }
    this.view.setModels(this.modelOptions, this.model);
    this.applyModelSelection(this.model, false);
    this.persistSettings();
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

  private newConversation(): void {
    this.conversation = [];
    this.view.clearMessages();
    this.view.appendMessage('assistant', 'Cuộc trò chuyện mới. Context vẫn theo chart hiện tại.');
    this.refreshContext();
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
      this.requestId = crypto.randomUUID();
      this.setBusy(true, true);
      const response = await this.client.chat({
        requestId: this.requestId,
        message,
        model: this.model || null,
        reasoningEffort: this.reasoningEffort,
        conversation: this.conversation.slice(-EXCEL_ASSISTANT_CONFIG.maxConversationMessages),
        context,
        screenshotDataUrl: null,
      });
      this.view.removeThinking();
      if (this.cancelRequested) {
        this.view.appendMessage('assistant', 'Đã dừng chờ phản hồi.');
        return;
      }
      this.view.appendMessage('assistant', response.message);
      const nextConversation: AssistantConversationMessage[] = [
        ...this.conversation,
        { role: 'user', content: message },
        { role: 'assistant', content: response.message },
      ];
      this.conversation = nextConversation.slice(-EXCEL_ASSISTANT_CONFIG.maxConversationMessages);
      this.view.setConnectionStatus('Sẵn sàng', true);
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
        model: this.model || null,
        reasoningEffort: this.reasoningEffort,
      });
      this.view.removeThinking();
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
      this.model = typeof value.model === 'string' ? value.model : '';
      this.reasoningEffort = ALL_REASONING_EFFORTS.includes(value.reasoningEffort ?? EXCEL_ASSISTANT_CONFIG.defaultReasoningEffort)
        ? value.reasoningEffort as ReasoningEffort
        : EXCEL_ASSISTANT_CONFIG.defaultReasoningEffort;
    } catch {
      this.model = '';
      this.reasoningEffort = EXCEL_ASSISTANT_CONFIG.defaultReasoningEffort;
    }
  }

  private persistSettings(): void {
    try {
      localStorage.setItem(EXCEL_ASSISTANT_CONFIG.storageKey, JSON.stringify({
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
