import './style.css';
import { AssistantApiClient } from './client';
import type {
  AssistantChartContext,
  AssistantConversationMessage,
  AssistantMode,
  CodexModelOption,
  CodexRateLimitBucket,
  CodexStatusResponse,
  ReasoningEffort,
  TradePlan,
} from './types';

const STORAGE_KEY = 'l2chart.assistant.settings.v1';
const MAX_CONVERSATION_MESSAGES = 10;
const ALL_REASONING_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];
const REASONING_LABELS: Record<ReasoningEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
};

interface StoredSettings {
  mode?: AssistantMode;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

function readSettings(): StoredSettings {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return value && typeof value === 'object' ? value as StoredSettings : {};
  } catch {
    return {};
  }
}

function writeSettings(settings: StoredSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
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

function visibleTiles(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('#charts > .tile')]
    .filter((tile) => !tile.hidden && getComputedStyle(tile).display !== 'none');
}

function activeTileElement(): HTMLElement | null {
  const tiles = visibleTiles();
  return tiles.find((tile) => tile.classList.contains('active')) ?? tiles[0] ?? null;
}

function captureActiveChart(): string | null {
  const tile = activeTileElement();
  const shell = tile?.querySelector<HTMLElement>('.tile-chart-shell');
  if (!tile || !shell) return null;

  const shellRect = shell.getBoundingClientRect();
  if (shellRect.width < 2 || shellRect.height < 2) return null;
  const canvases = [...shell.querySelectorAll<HTMLCanvasElement>('canvas')]
    .filter((canvas) => {
      const rect = canvas.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1;
    });
  if (canvases.length === 0) return null;

  const scale = Math.min(2, window.devicePixelRatio || 1);
  const output = document.createElement('canvas');
  output.width = Math.max(1, Math.round(shellRect.width * scale));
  output.height = Math.max(1, Math.round(shellRect.height * scale));
  const context = output.getContext('2d');
  if (!context) return null;

  const background = getComputedStyle(shell).backgroundColor || getComputedStyle(document.body).backgroundColor;
  context.fillStyle = background === 'rgba(0, 0, 0, 0)' ? '#0b0d10' : background;
  context.fillRect(0, 0, output.width, output.height);
  context.scale(scale, scale);

  for (const canvas of canvases) {
    const rect = canvas.getBoundingClientRect();
    context.drawImage(
      canvas,
      rect.left - shellRect.left,
      rect.top - shellRect.top,
      rect.width,
      rect.height,
    );
  }

  try {
    return output.toDataURL('image/png');
  } catch {
    return null;
  }
}

function planSummary(plan: TradePlan): string {
  const lines = [`${plan.decision} · ${plan.marketRegime} · ${Math.round(plan.confidence)}%`];
  if (plan.entryZone) lines.push(`Entry: ${plan.entryZone.from} – ${plan.entryZone.to}`);
  if (plan.stopLoss !== null) lines.push(`SL: ${plan.stopLoss}`);
  if (plan.targets.length > 0) lines.push(`TP: ${plan.targets.join(' · ')}`);
  if (plan.riskReward !== null) lines.push(`R:R: ${plan.riskReward}`);
  if (plan.invalidation) lines.push(`Invalidation: ${plan.invalidation}`);
  return lines.join('\n');
}

function formatResetTime(timestamp: number | null): string | null {
  if (timestamp === null || !Number.isFinite(timestamp)) return null;
  const milliseconds = timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
  return new Date(milliseconds).toLocaleString();
}

function formatWindowName(bucket: CodexRateLimitBucket): string {
  const minutes = bucket.windowDurationMins;
  if (minutes === 1440) return 'Ngày';
  if (minutes === 10080) return '7 ngày';
  if (minutes === 300) return '5 giờ';
  if (minutes !== null && Number.isFinite(minutes)) {
    if (minutes % 1440 === 0) return `${minutes / 1440} ngày`;
    if (minutes % 60 === 0) return `${minutes / 60} giờ`;
    return `${minutes} phút`;
  }
  return bucket.slot === 'secondary' ? 'Giới hạn phụ' : 'Giới hạn chính';
}

function formatRateLimit(bucket: CodexRateLimitBucket | null): string | null {
  if (!bucket) return null;
  const used = bucket.usedPercent !== null && Number.isFinite(bucket.usedPercent)
    ? `${bucket.usedPercent}% đã dùng`
    : 'đã dùng: không rõ';
  const remaining = bucket.remainingPercent !== null && Number.isFinite(bucket.remainingPercent)
    ? `còn ${bucket.remainingPercent}%`
    : null;
  const reset = formatResetTime(bucket.resetsAt);
  return `${formatWindowName(bucket)}: ${[used, remaining, reset ? `reset ${reset}` : null].filter(Boolean).join(' · ')}`;
}

function formatCodexStatus(payload: CodexStatusResponse): string {
  const lines = ['Codex quota'];
  if (payload.account) {
    const identity = payload.account.email || payload.account.type || 'đã đăng nhập';
    lines.push(`Tài khoản: ${identity}${payload.account.planType ? ` · ${payload.account.planType}` : ''}`);
  } else {
    lines.push('Tài khoản: không có thông tin');
  }
  lines.push(`Model: ${payload.selected.model || 'Codex default'}`);
  lines.push(`Reasoning: ${payload.selected.reasoningEffort}`);

  const limits = [payload.rateLimits.primary, payload.rateLimits.secondary]
    .map(formatRateLimit)
    .filter((value): value is string => Boolean(value));
  lines.push(...(limits.length > 0 ? limits : ['Quota: Codex không trả về dữ liệu giới hạn.']));

  if (payload.rateLimits.reachedType) lines.push(`Limit reached: ${payload.rateLimits.reachedType}`);
  if (payload.rateLimits.spendControlReached === true) lines.push('Spend control: đã chạm giới hạn');
  if (payload.resetCredits) lines.push(`Reset credits: ${payload.resetCredits.availableCount}`);
  return lines.join('\n');
}

function mountAssistant(): void {
  const tabs = document.getElementById('right-tabs');
  const rightPanel = document.getElementById('right-panel');
  if (!tabs || !rightPanel || document.getElementById('assistant-view')) return;

  const saved = readSettings();
  let mode: AssistantMode = saved.mode === 'analyze' ? 'analyze' : 'chat';
  let reasoningEffort: ReasoningEffort = ALL_REASONING_EFFORTS.includes(saved.reasoningEffort ?? 'medium')
    ? saved.reasoningEffort as ReasoningEffort
    : 'medium';
  let model = saved.model?.trim() ?? '';
  let requestId: string | null = null;
  let busy = false;
  let modelsLoading = true;
  let modelOptions: CodexModelOption[] = [];
  let conversation: AssistantConversationMessage[] = [];

  const tab = createElement('button', '', 'AI');
  tab.type = 'button';
  tab.dataset.rightTab = 'assistant';
  const spacer = tabs.querySelector('.spacer');
  tabs.insertBefore(tab, spacer);

  const view = createElement('section', 'right-view assistant-view');
  view.id = 'assistant-view';
  view.hidden = true;
  view.innerHTML = `
    <div class="assistant-head">
      <div>
        <strong>AI Chart Assistant</strong>
        <span id="assistant-status">Đang kiểm tra Codex…</span>
      </div>
      <button id="assistant-new" type="button" title="Cuộc trò chuyện mới">New</button>
    </div>
    <div class="assistant-settings">
      <label class="assistant-mode-field">Chế độ
        <select id="assistant-mode">
          <option value="chat">Chat chart</option>
          <option value="analyze">Phân tích lệnh</option>
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
    <small class="assistant-hint">Enter để gửi · Shift+Enter xuống dòng · /status xem quota · AI không gửi lệnh.</small>
  `;
  rightPanel.appendChild(view);

  const status = view.querySelector<HTMLElement>('#assistant-status')!;
  const contextBadge = view.querySelector<HTMLElement>('#assistant-context')!;
  const messages = view.querySelector<HTMLElement>('#assistant-messages')!;
  const input = view.querySelector<HTMLTextAreaElement>('#assistant-input')!;
  const send = view.querySelector<HTMLButtonElement>('#assistant-send')!;
  const cancel = view.querySelector<HTMLButtonElement>('#assistant-cancel')!;
  const modeSelect = view.querySelector<HTMLSelectElement>('#assistant-mode')!;
  const modelSelect = view.querySelector<HTMLSelectElement>('#assistant-model')!;
  const reasoningSelect = view.querySelector<HTMLSelectElement>('#assistant-reasoning')!;
  const form = view.querySelector<HTMLFormElement>('#assistant-form')!;
  const client = new AssistantApiClient();

  const setConnectionStatus = (text: string, connected: boolean) => {
    status.textContent = text;
    status.classList.toggle('connected', connected);
    status.classList.toggle('error', !connected);
  };

  modeSelect.value = mode;
  reasoningSelect.value = reasoningEffort;

  const persist = () => writeSettings({ mode, model, reasoningEffort });

  const appendMessage = (role: 'user' | 'assistant', text: string, plan: TradePlan | null = null) => {
    const item = createElement('article', `assistant-message assistant-message-${role}`);
    item.appendChild(createElement('small', 'assistant-role', role === 'user' ? 'Bạn' : 'AI'));
    item.appendChild(createElement('div', 'assistant-message-text', text));
    if (plan) item.appendChild(createElement('pre', `assistant-plan assistant-plan-${plan.decision.toLowerCase()}`, planSummary(plan)));
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
    send.disabled = value;
    modeSelect.disabled = value;
    modelSelect.disabled = value || modelsLoading;
    reasoningSelect.disabled = value;
    cancel.disabled = !value || requestId === null;
  };

  const renderReasoningOptions = (
    allowed: ReasoningEffort[] = ALL_REASONING_EFFORTS,
    preferred: ReasoningEffort = reasoningEffort,
  ) => {
    const available = allowed.length > 0 ? allowed : ALL_REASONING_EFFORTS;
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

  const selectedModelOption = (): CodexModelOption | undefined => (
    modelOptions.find((option) => option.id === model)
  );

  const applyModelSelection = () => {
    model = modelSelect.value;
    const selected = selectedModelOption();
    renderReasoningOptions(
      selected?.supportedReasoningEfforts ?? ALL_REASONING_EFFORTS,
      selected?.defaultReasoningEffort ?? reasoningEffort,
    );
    persist();
  };

  const renderModelOptions = () => {
    const options: HTMLOptionElement[] = [];
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Codex default';
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
    modelsLoading = true;
    setBusy(busy);
    try {
      const response = await client.options();
      modelOptions = Array.isArray(response.models) ? response.models : [];
      modelSelect.title = `${modelOptions.length} model từ Codex`;
    } catch (error) {
      modelOptions = [];
      modelSelect.title = error instanceof Error ? error.message : String(error);
    } finally {
      modelsLoading = false;
      renderModelOptions();
      setBusy(busy);
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
    if (rightPanel.hidden) document.getElementById('right-panel-toggle')?.click();
    tabs.querySelectorAll<HTMLButtonElement>('button[data-right-tab]').forEach((button) => {
      button.classList.toggle('active', button === tab);
    });
    rightPanel.querySelectorAll<HTMLElement>('.right-view').forEach((section) => {
      section.hidden = section !== view;
    });
    currentContext();
    input.focus({ preventScroll: true });
  };

  tab.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    openAssistant();
  });

  tabs.querySelectorAll<HTMLButtonElement>('button[data-right-tab]:not([data-right-tab="assistant"])')
    .forEach((button) => button.addEventListener('click', () => {
      view.hidden = true;
      tab.classList.remove('active');
    }));

  modeSelect.addEventListener('change', () => {
    mode = modeSelect.value === 'analyze' ? 'analyze' : 'chat';
    send.textContent = mode === 'analyze' ? 'Analyze' : 'Send';
    input.placeholder = mode === 'analyze'
      ? 'Yêu cầu AI đánh giá setup, entry, SL và TP…'
      : 'Hỏi về chart đang chọn…';
    persist();
  });
  modelSelect.addEventListener('change', applyModelSelection);
  reasoningSelect.addEventListener('change', () => {
    reasoningEffort = reasoningSelect.value as ReasoningEffort;
    persist();
  });

  view.querySelector<HTMLButtonElement>('#assistant-new')!.addEventListener('click', () => {
    conversation = [];
    messages.replaceChildren();
    appendMessage('assistant', 'Đã bắt đầu cuộc trò chuyện mới cho chart hiện tại.');
  });

  async function showStatus(command: string): Promise<void> {
    appendMessage('user', command);
    input.value = '';
    requestId = null;
    setBusy(true);
    const thinking = appendThinking();
    try {
      const response = await client.status({ model: model || null, reasoningEffort });
      thinking.remove();
      appendMessage('assistant', formatCodexStatus(response));
      setConnectionStatus('Codex connected', true);
    } catch (error) {
      thinking.remove();
      const text = error instanceof Error ? error.message : String(error);
      appendMessage('assistant', `Lỗi: ${text}`);
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

    const context = currentContext();
    if (!context) {
      appendMessage('assistant', 'Không lấy được dữ liệu chart đang chọn. Hãy tải chart xong rồi thử lại.');
      return;
    }

    appendMessage('user', message);
    input.value = '';
    requestId = crypto.randomUUID();
    setBusy(true);
    const thinking = appendThinking();
    try {
      const response = await client.chat({
        requestId,
        mode,
        message,
        model: model || null,
        reasoningEffort,
        conversation: conversation.slice(-MAX_CONVERSATION_MESSAGES),
        context,
        screenshotDataUrl: captureActiveChart(),
      });
      thinking.remove();
      appendMessage('assistant', response.message, response.tradePlan);
      const nextConversation: AssistantConversationMessage[] = [
        ...conversation,
        { role: 'user', content: message },
        { role: 'assistant', content: response.message },
      ];
      conversation = nextConversation.slice(-MAX_CONVERSATION_MESSAGES);
      setConnectionStatus('Codex connected', true);
    } catch (error) {
      thinking.remove();
      const text = error instanceof Error ? error.message : String(error);
      appendMessage('assistant', `Lỗi: ${text}`);
      setConnectionStatus(text, false);
    } finally {
      thinking.remove();
      requestId = null;
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
    if (requestId) void client.cancel(requestId).catch(() => undefined);
  });

  const observer = new MutationObserver(() => {
    if (!view.hidden) currentContext();
  });
  observer.observe(document.getElementById('charts') ?? document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'hidden'],
  });

  void client.health().then((health) => {
    setConnectionStatus(health.codexAvailable ? 'Codex connected' : health.detail, health.codexAvailable);
  }).catch((error) => {
    setConnectionStatus(error instanceof Error ? error.message : String(error), false);
  });
  void loadModelOptions();

  modeSelect.dispatchEvent(new Event('change'));
  currentContext();
  appendMessage('assistant', 'Sẵn sàng. Chọn model và reasoning rồi hỏi trực tiếp; dùng /status để xem quota Codex.');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountAssistant, { once: true });
} else {
  mountAssistant();
}
