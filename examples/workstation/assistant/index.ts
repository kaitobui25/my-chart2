import './style.css';
import { AssistantApiClient } from './client';
import { runAssistantTurn } from '../../assistant/chat-runner';
import { AssistantChatHistory } from '../../excel-content-addin/assistant-chat-history';
import { AssistantHistoryView } from './history-view';
import type {
  AssistantChartContext,
  AssistantConversationMessage,
  AssistantModelOption,
  AssistantProvider,
  AssistantStatusResponse,
  ReasoningEffort,
} from './types';

const PROVIDER_STORAGE_KEY = 'l2chart.assistant.provider.v1';
const MAX_CONVERSATION_MESSAGES = 10;
const ALL_REASONING_EFFORTS: ReasoningEffort[] = [
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'pro',
];
const CODEX_REASONING_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];
const providerLabel = (provider: AssistantProvider): string => provider === 'codex' ? 'Codex' : 'ChatGPT Web';
const REASONING_LABELS: Record<ReasoningEffort, string> = {
  none: 'Instant',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
  pro: 'Pro',
};

interface StoredSettings {
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

function readSettings(provider: AssistantProvider): StoredSettings {
  try {
    const value = JSON.parse(localStorage.getItem(`l2chart.assistant.${provider}.settings.v1`) ?? '{}');
    return value && typeof value === 'object' ? value as StoredSettings : {};
  } catch {
    return {};
  }
}

function writeSettings(provider: AssistantProvider, settings: StoredSettings): void {
  try {
    localStorage.setItem(`l2chart.assistant.${provider}.settings.v1`, JSON.stringify(settings));
    localStorage.setItem(PROVIDER_STORAGE_KEY, provider);
  } catch {
    // The assistant still works when browser storage is unavailable.
  }
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function formatAssistantStatus(payload: AssistantStatusResponse, provider: AssistantProvider): string {
  const lines = [
    provider === 'codex' ? 'Codex CLI: connected' : `ChatGPT Bridge: ${payload.bridgeConnected === false ? 'offline' : 'connected'}`,
    'Model: ' + (payload.selected.model || (provider === 'codex' ? 'Codex default' : 'ChatGPT current')),
    'Reasoning: ' + payload.selected.reasoningEffort,
  ];
  if (payload.account?.planType) lines.push('Plan: ' + payload.account.planType);
  for (const bucket of [payload.rateLimits.primary, payload.rateLimits.secondary]) {
    if (bucket?.remainingPercent != null) lines.push(`${bucket.slot}: ${bucket.remainingPercent}% remaining`);
  }
  if (payload.conversationId) lines.push('Conversation: ' + payload.conversationId);
  if (payload.detail) lines.push(payload.detail);
  return lines.join('\n');
}

function mountAssistant(): void {
  const tabs = document.getElementById('right-tabs');
  const rightPanel = document.getElementById('right-panel');
  const dock = document.getElementById('workspace-dock');
  if (!tabs || !rightPanel || !dock || document.getElementById('assistant-view')) return;

  let provider: AssistantProvider = 'codex';
  try {
    if (localStorage.getItem(PROVIDER_STORAGE_KEY) === 'chatgpt') provider = 'chatgpt';
  } catch { /* Default to Codex when storage is unavailable. */ }
  const allowedEfforts = (): ReasoningEffort[] => provider === 'codex' ? CODEX_REASONING_EFFORTS : ALL_REASONING_EFFORTS;
  const saved = readSettings(provider);
  let reasoningEffort: ReasoningEffort = saved.reasoningEffort && allowedEfforts().includes(saved.reasoningEffort)
    ? saved.reasoningEffort as ReasoningEffort
    : 'medium';
  let model = saved.model?.trim() ?? '';
  let requestId: string | null = null;
  let cancelRequested = false;
  let busy = false;
  let modelsLoading = true;
  let modelOptions: AssistantModelOption[] = [];
  const history = new AssistantChatHistory(undefined, undefined, 'l2chart.workstation.assistant');
  const transcripts = new Map<AssistantProvider, AssistantConversationMessage[]>();
  for (const source of ['codex', 'chatgpt'] as const) {
    transcripts.set(source, history.get(history.activeId(source))?.messages ?? []);
  }
  let conversation: AssistantConversationMessage[] = transcripts.get(provider) ?? [];
  let connectionGeneration = 0;

  const dockToggle = createElement('button', 'workspace-dock-button');
  dockToggle.id = 'assistant-toggle';
  dockToggle.type = 'button';
  dockToggle.dataset.label = 'AI';
  dockToggle.title = 'Mở AI Chart Assistant';
  dockToggle.setAttribute('aria-label', 'Mở AI Chart Assistant');
  dockToggle.setAttribute('aria-pressed', 'false');
  dockToggle.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z"/><path d="M18.5 15l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6Z"/><path d="M5 14l.8 2.2L8 17l-2.2.8L5 20l-.8-2.2L2 17l2.2-.8L5 14Z"/></svg>';
  dock.appendChild(dockToggle);

  const placeDockToggleAfterScanner = () => {
    const scannerToggle = document.getElementById('scanner-toggle');
    if (scannerToggle?.parentElement === dock && scannerToggle.nextElementSibling !== dockToggle) {
      scannerToggle.insertAdjacentElement('afterend', dockToggle);
    }
  };
  placeDockToggleAfterScanner();
  const dockObserver = new MutationObserver(placeDockToggleAfterScanner);
  dockObserver.observe(dock, { childList: true });

  const view = createElement('section', 'right-view assistant-view');
  view.id = 'assistant-view';
  view.hidden = true;
  view.innerHTML = `
    <div class="assistant-head">
      <div>
        <strong>AI Chart Assistant</strong>
        <span id="assistant-status">Đang kiểm tra Codex…</span>
      </div>
      <div class="assistant-header-actions">
        <button id="assistant-history-toggle" type="button" aria-expanded="false" aria-controls="assistant-history">Lịch sử</button>
        <button id="assistant-new" type="button" title="Cuộc trò chuyện mới">New</button>
      </div>
    </div>
    <div class="assistant-settings">
      <label class="assistant-provider-setting">Provider
        <select id="assistant-provider">
          <option value="codex">Codex</option>
          <option value="chatgpt">ChatGPT Web</option>
        </select>
      </label>
      <label>Model
        <select id="assistant-model">
          <option value="">Đang tải model…</option>
        </select>
      </label>
      <label>Reasoning
        <select id="assistant-reasoning">
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="xhigh">Extra high</option>
        </select>
      </label>
    </div>
    <div id="assistant-context" class="assistant-context">Chưa có chart context</div>
    <div id="assistant-messages" class="assistant-messages" aria-live="polite"></div>
    <form id="assistant-form" class="assistant-form">
      <textarea id="assistant-input" rows="4" placeholder="Hỏi về chart đang chọn…"></textarea>
      <div class="assistant-actions">
        <button id="assistant-cancel" type="button" disabled>Cancel</button>
        <button id="assistant-send" type="submit">Send</button>
      </div>
    </form>
    <small class="assistant-hint">Enter để gửi · Shift+Enter xuống dòng · /status xem kết nối · AI không gửi lệnh.</small>
  `;
  rightPanel.appendChild(view);

  const status = view.querySelector<HTMLElement>('#assistant-status')!;
  const contextBadge = view.querySelector<HTMLElement>('#assistant-context')!;
  const messages = view.querySelector<HTMLElement>('#assistant-messages')!;
  const input = view.querySelector<HTMLTextAreaElement>('#assistant-input')!;
  const send = view.querySelector<HTMLButtonElement>('#assistant-send')!;
  const cancel = view.querySelector<HTMLButtonElement>('#assistant-cancel')!;
  const fresh = view.querySelector<HTMLButtonElement>('#assistant-new')!;
  const modelSelect = view.querySelector<HTMLSelectElement>('#assistant-model')!;
  const providerSelect = view.querySelector<HTMLSelectElement>('#assistant-provider')!;
  providerSelect.value = provider;
  const reasoningSelect = view.querySelector<HTMLSelectElement>('#assistant-reasoning')!;
  const form = view.querySelector<HTMLFormElement>('#assistant-form')!;
  const client = new AssistantApiClient();
  const historyToggle = view.querySelector<HTMLButtonElement>('#assistant-history-toggle')!;
  const settings = view.querySelector<HTMLElement>('.assistant-settings')!;
  const historyView = new AssistantHistoryView(history, () => setHistoryOpen(false));
  historyView.element.id = 'assistant-history';
  view.insertBefore(historyView.element, messages);
  function setHistoryOpen(open: boolean): void {
    historyToggle.setAttribute('aria-expanded', String(open));
    messages.hidden = open;
    form.hidden = open;
    settings.hidden = open;
    historyView.element.hidden = !open;
    if (open) historyView.showList();
    else historyToggle.focus({ preventScroll: true });
  }
  historyToggle.addEventListener('click', () => setHistoryOpen(Boolean(historyView.element.hidden)));
  historyView.element.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setHistoryOpen(false);
    }
  });

  const setConnectionStatus = (text: string, connected: boolean) => {
    status.textContent = text;
    status.classList.toggle('connected', connected);
    status.classList.toggle('error', !connected);
  };

  reasoningSelect.value = reasoningEffort;

  const persist = () => writeSettings(provider, { model, reasoningEffort });

  const appendMessage = (role: 'user' | 'assistant', text: string) => {
    const item = createElement('article', `assistant-message assistant-message-${role}`);
    item.appendChild(createElement('small', 'assistant-role', role === 'user' ? 'Bạn' : 'AI'));
    item.appendChild(createElement('div', 'assistant-message-text', text));
    messages.appendChild(item);
    messages.scrollTop = messages.scrollHeight;
  };

  const appendThinking = (): HTMLElement => {
    const item = createElement('article', 'assistant-message assistant-message-assistant assistant-message-thinking');
    item.setAttribute('aria-label', 'AI đang suy nghĩ');
    item.appendChild(createElement('small', 'assistant-role', 'AI'));
    const dots = createElement('div', 'assistant-thinking-dots');
    dots.append(createElement('span'), createElement('span'), createElement('span'));
    item.appendChild(dots);
    messages.appendChild(item);
    messages.scrollTop = messages.scrollHeight;
    return item;
  };

  const setBusy = (value: boolean) => {
    busy = value;
    input.disabled = value;
    send.disabled = value || modelsLoading;
    fresh.disabled = value || modelsLoading;
    modelSelect.disabled = value || modelsLoading;
    reasoningSelect.disabled = value || modelsLoading;
    providerSelect.disabled = value;
    cancel.disabled = !value || requestId === null;
  };

  const renderReasoningOptions = (
    allowed: ReasoningEffort[] = allowedEfforts(),
    preferred: ReasoningEffort = reasoningEffort,
  ) => {
    const available = allowed.length > 0 ? allowed : allowedEfforts();
    const next = available.includes(reasoningEffort)
      ? reasoningEffort
      : available.includes(preferred)
        ? preferred
        : available[0];
    reasoningSelect.replaceChildren(...available.map((effort) => {
      const option = document.createElement('option');
      option.value = effort;
      option.textContent = REASONING_LABELS[effort];
      return option;
    }));
    reasoningEffort = next;
    reasoningSelect.value = reasoningEffort;
  };

  const selectedModelOption = (): AssistantModelOption | undefined => (
    modelOptions.find((option) => option.id === model)
  );

  const applyModelSelection = () => {
    model = modelSelect.value;
    const selected = selectedModelOption();
    renderReasoningOptions(
      selected?.supportedReasoningEfforts ?? allowedEfforts(),
      selected?.defaultReasoningEffort ?? reasoningEffort,
    );
    persist();
  };

  const renderModelOptions = () => {
    const options: HTMLOptionElement[] = [];
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = provider === 'codex' ? 'Codex default' : 'ChatGPT current';
    options.push(defaultOption);

    for (const item of modelOptions) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.label === item.id ? item.id : `${item.label} (${item.id})`;
      options.push(option);
    }

    if (model && !modelOptions.some((item) => item.id === model)) {
      const savedOption = document.createElement('option');
      savedOption.value = model;
      savedOption.textContent = `${model} (saved)`;
      options.push(savedOption);
    }

    modelSelect.replaceChildren(...options);
    modelSelect.value = model;
    applyModelSelection();
  };

  const loadModelOptions = async () => {
    const selectedProvider = provider;
    const generation = connectionGeneration;
    modelsLoading = true;
    modelOptions = [];
    renderModelOptions();
    setBusy(busy);
    try {
      const response = await client.options(selectedProvider);
      if (generation !== connectionGeneration) return;
      modelOptions = Array.isArray(response.models) ? response.models : [];
      modelSelect.title = `${modelOptions.length} model từ ${providerLabel(provider)}`;
    } catch (error) {
      if (generation !== connectionGeneration) return;
      modelOptions = [];
      modelSelect.title = error instanceof Error ? error.message : String(error);
      setConnectionStatus(modelSelect.title, false);
    } finally {
      if (generation === connectionGeneration) {
        modelsLoading = false;
        renderModelOptions();
        setBusy(busy);
      }
    }
  };

  const checkHealth = async () => {
    const selectedProvider = provider;
    const generation = ++connectionGeneration;
    setConnectionStatus(`Đang kiểm tra ${providerLabel(provider)}…`, false);
    try {
      const health = await client.health(selectedProvider);
      if (generation !== connectionGeneration) return;
      setConnectionStatus(
        health.assistantAvailable ? `${providerLabel(selectedProvider)} connected` : health.detail,
        health.assistantAvailable,
      );
    } catch (error) {
      if (generation !== connectionGeneration) return;
      setConnectionStatus(error instanceof Error ? error.message : String(error), false);
    }
  };

  const currentContext = (): AssistantChartContext | null => {
    const context = window.__L2CHART_ASSISTANT__?.getContext() ?? null;
    contextBadge.textContent = context
      ? `${context.symbol} · ${context.timeframe} · ${context.candleCount} nến${String(context.replay.phase ?? 'idle') !== 'idle' ? ' · REPLAY' : ''}`
      : 'Không lấy được chart context';
    return context;
  };

  const openAssistant = () => {
    setHistoryOpen(false);
    if (rightPanel.hidden) document.getElementById('right-panel-toggle')?.click();
    tabs.querySelectorAll<HTMLButtonElement>('button[data-right-tab]').forEach((button) => {
      button.classList.remove('active');
    });
    rightPanel.querySelectorAll<HTMLElement>('.right-view').forEach((section) => {
      section.hidden = section !== view;
    });
    dockToggle.classList.add('active');
    dockToggle.setAttribute('aria-pressed', 'true');
    currentContext();
    input.focus({ preventScroll: true });
  };

  dockToggle.addEventListener('click', () => {
    if (!rightPanel.hidden && !view.hidden) {
      document.getElementById('right-panel-toggle')?.click();
      dockToggle.classList.remove('active');
      dockToggle.setAttribute('aria-pressed', 'false');
      return;
    }
    openAssistant();
  });

  tabs.querySelectorAll<HTMLButtonElement>('button[data-right-tab]')
    .forEach((button) => button.addEventListener('click', () => {
      view.hidden = true;
      dockToggle.classList.remove('active');
      dockToggle.setAttribute('aria-pressed', 'false');
    }));

  const rightPanelObserver = new MutationObserver(() => {
    if (!rightPanel.hidden) return;
    dockToggle.classList.remove('active');
    dockToggle.setAttribute('aria-pressed', 'false');
  });
  rightPanelObserver.observe(rightPanel, { attributes: true, attributeFilter: ['hidden'] });

  modelSelect.addEventListener('change', applyModelSelection);
  providerSelect.addEventListener('change', () => {
    transcripts.set(provider, conversation);
    persist();
    provider = providerSelect.value === 'chatgpt' ? 'chatgpt' : 'codex';
    const settings = readSettings(provider);
    model = settings.model?.trim() ?? '';
    reasoningEffort = settings.reasoningEffort && allowedEfforts().includes(settings.reasoningEffort)
      ? settings.reasoningEffort : 'medium';
    conversation = transcripts.get(provider) ?? [];
    messages.replaceChildren();
    for (const message of conversation) appendMessage(message.role, message.content);
    if (!conversation.length) appendMessage('assistant', `${providerLabel(provider)} · Sẵn sàng nhận câu hỏi về chart.`);
    persist();
    void checkHealth();
    void loadModelOptions();
  });
  reasoningSelect.addEventListener('change', () => {
    reasoningEffort = reasoningSelect.value as ReasoningEffort;
    persist();
  });

  fresh.addEventListener('click', () => {
    if (busy) return;
    void (async () => {
      setBusy(true);
      try {
        const response = await client.newConversation({ provider, model: model || null, reasoningEffort });
        if (response.selection && ALL_REASONING_EFFORTS.includes(response.selection.reasoningEffort)) {
          reasoningEffort = response.selection.reasoningEffort;
          renderReasoningOptions(
            selectedModelOption()?.supportedReasoningEfforts ?? allowedEfforts(),
            reasoningEffort,
          );
          persist();
        }
        conversation = [];
        history.newChat(provider);
        setHistoryOpen(false);
        messages.replaceChildren();
        appendMessage('assistant', `Đã mở cuộc trò chuyện ${providerLabel(provider)} mới cho chart hiện tại.`);
        setConnectionStatus(`${providerLabel(provider)} connected`, true);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        appendMessage('assistant', 'Lỗi tạo chat mới: ' + text);
        setConnectionStatus(text, false);
      } finally {
        setBusy(false);
        input.focus({ preventScroll: true });
      }
    })();
  });

  async function showStatus(command: string): Promise<void> {
    appendMessage('user', command);
    history.append(provider, 'user', command);
    input.value = '';
    requestId = null;
    setBusy(true);
    const thinking = appendThinking();
    try {
      const response = await client.status({ provider, model: model || null, reasoningEffort });
      thinking.remove();
      appendMessage('assistant', formatAssistantStatus(response, provider));
      history.append(provider, 'assistant', formatAssistantStatus(response, provider));
      setConnectionStatus(
        provider === 'chatgpt' && response.bridgeConnected === false ? 'ChatGPT Bridge offline' : `${providerLabel(provider)} connected`,
        provider === 'codex' || response.bridgeConnected !== false,
      );
    } catch (error) {
      thinking.remove();
      const text = error instanceof Error ? error.message : String(error);
      appendMessage('assistant', `Lỗi: ${text}`);
      history.append(provider, 'assistant', `Lỗi: ${text}`);
      setConnectionStatus(text, false);
    } finally {
      setBusy(false);
      input.focus({ preventScroll: true });
    }
  }

  async function submitMessage(rawMessage: string): Promise<void> {
    const message = rawMessage.trim();
    if (!message || busy) return;
    if (message.toLowerCase() === '/status') {
      await showStatus(message);
      return;
    }

    const baseContext = currentContext();
    if (!baseContext) {
      appendMessage('assistant', 'Không lấy được dữ liệu chart đang chọn. Hãy tải chart xong rồi thử lại.');
      return;
    }

    appendMessage('user', message);
    history.append(provider, 'user', message);
    input.value = '';
    cancelRequested = false;
    setBusy(true);
    const thinking = appendThinking();
    try {
      const context = await window.__L2CHART_ASSISTANT__?.resolveContext(message, {
        includeAdditionalTimeframes: conversation.length === 0,
      }) ?? baseContext;
      if (context.additionalTimeframes.length > 0) {
        const extras = context.additionalTimeframes.map((item) => (
          item.error ? `${item.timeframe} lỗi` : `${item.timeframe} ${item.candleCount} nến`
        )).join(', ');
        contextBadge.textContent = `${context.symbol} · ${context.timeframe} · ${context.candleCount} nến · + ${extras}`;
      }
      const answer = await runAssistantTurn({
        client,
        bridge: window.__L2CHART_ASSISTANT__!,
        context,
        provider,
        message,
        model: model || null,
        reasoningEffort,
        conversation: conversation.slice(-MAX_CONVERSATION_MESSAGES),
        setRequestId: (id) => {
          requestId = id;
          setBusy(true);
        },
        cancelled: () => cancelRequested,
      });
      thinking.remove();
      appendMessage('assistant', answer);
      history.append(provider, 'assistant', answer);
      const nextConversation: AssistantConversationMessage[] = [
        ...conversation,
        { role: 'user', content: message },
        { role: 'assistant', content: answer },
      ];
      conversation = nextConversation.slice(-MAX_CONVERSATION_MESSAGES);
      setConnectionStatus(`${providerLabel(provider)} connected`, true);
    } catch (error) {
      thinking.remove();
      const text = error instanceof Error ? error.message : String(error);
      appendMessage('assistant', `Lỗi: ${text}`);
      history.append(provider, 'assistant', `Lỗi: ${text}`);
      setConnectionStatus(text, false);
    } finally {
      thinking.remove();
      requestId = null;
      cancelRequested = false;
      setBusy(false);
      input.focus({ preventScroll: true });
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitMessage(input.value);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  cancel.addEventListener('click', () => {
    if (requestId) {
      cancelRequested = true;
      void client.cancel(requestId).catch(() => undefined);
    }
  });

  const observer = new MutationObserver(() => {
    if (!view.hidden) currentContext();
  });
  observer.observe(document.getElementById('charts') ?? document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'hidden'],
  });

  void checkHealth();
  void loadModelOptions();

  currentContext();
  for (const message of conversation) appendMessage(message.role, message.content);
  if (!conversation.length) appendMessage('assistant', `${providerLabel(provider)} · Sẵn sàng. Dùng /status để xem kết nối và quota.`);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountAssistant, { once: true });
} else {
  mountAssistant();
}
