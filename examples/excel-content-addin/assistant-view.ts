import type { AssistantProvider, CodexModelOption, ReasoningEffort } from '../assistant/types';
import type { AssistantHistoryEntry } from './assistant-chat-history';
import { ALL_REASONING_EFFORTS, REASONING_LABELS } from './assistant-config';

export type AssistantMessageRole = 'user' | 'assistant';

export class AssistantPanelView {
  readonly toggle = requiredElement<HTMLButtonElement>('#assistant-toggle');
  readonly panel = requiredElement<HTMLElement>('#assistant-panel');
  readonly quota = requiredElement<HTMLElement>('#assistant-quota');
  readonly status = requiredElement<HTMLElement>('#assistant-status');
  readonly context = requiredElement<HTMLElement>('#assistant-context');
  readonly messages = requiredElement<HTMLElement>('#assistant-messages');
  readonly input = requiredElement<HTMLTextAreaElement>('#assistant-input');
  readonly send = requiredElement<HTMLButtonElement>('#assistant-send');
  readonly cancel = requiredElement<HTMLButtonElement>('#assistant-cancel');
  readonly close = requiredElement<HTMLButtonElement>('#assistant-close');
  readonly fresh = requiredElement<HTMLButtonElement>('#assistant-new');
  readonly settingsToggle = requiredElement<HTMLButtonElement>('#assistant-settings-toggle');
  readonly settings = requiredElement<HTMLElement>('#assistant-settings');
  readonly historyToggle = requiredElement<HTMLButtonElement>('#assistant-history-toggle');
  readonly historyPanel = requiredElement<HTMLElement>('#assistant-history');
  readonly historyBack = requiredElement<HTMLButtonElement>('#assistant-history-back');
  readonly historyClose = requiredElement<HTMLButtonElement>('#assistant-history-close');
  readonly historyHeading = requiredElement<HTMLElement>('#assistant-history-heading');
  readonly historyItems = requiredElement<HTMLElement>('#assistant-history-items');
  readonly form = requiredElement<HTMLFormElement>('#assistant-form');
  readonly provider = requiredElement<HTMLSelectElement>('#assistant-provider');
  readonly model = requiredElement<HTMLSelectElement>('#assistant-model');
  readonly reasoning = requiredElement<HTMLSelectElement>('#assistant-reasoning');
  private thinking: HTMLElement | null = null;

  constructor() {
    this.renderReasoningOptions(ALL_REASONING_EFFORTS, 'medium');
  }

  get isOpen(): boolean {
    return !this.panel.hidden;
  }

  open(): void {
    this.panel.hidden = false;
    this.toggle.setAttribute('aria-expanded', 'true');
    this.setUnread(false);
    this.input.focus({ preventScroll: true });
  }

  hide(): void {
    this.closeHistory();
    this.panel.hidden = true;
    this.toggle.setAttribute('aria-expanded', 'false');
    this.settings.hidden = true;
    this.settingsToggle.setAttribute('aria-expanded', 'false');
    this.toggle.focus({ preventScroll: true });
  }

  togglePanel(): void {
    if (this.isOpen) this.hide();
    else this.open();
  }

  toggleSettings(): void {
    if (this.isHistoryOpen) this.closeHistory();
    this.settings.hidden = !this.settings.hidden;
    this.settingsToggle.setAttribute('aria-expanded', String(!this.settings.hidden));
  }

  setConnectionStatus(message: string, connected: boolean, pending = false): void {
    this.status.setAttribute('aria-label', message);
    this.status.title = message;
    this.status.dataset.state = pending ? 'pending' : connected ? 'connected' : 'error';
  }

  get isHistoryOpen(): boolean {
    return !this.historyPanel.hidden;
  }

  openHistory(): void {
    this.historyPanel.hidden = false;
    this.messages.hidden = true;
    this.form.hidden = true;
    this.settings.hidden = true;
    this.settingsToggle.setAttribute('aria-expanded', 'false');
    this.historyToggle.setAttribute('aria-expanded', 'true');
  }

  closeHistory(): void {
    this.historyPanel.hidden = true;
    this.messages.hidden = false;
    this.form.hidden = false;
    this.historyToggle.setAttribute('aria-expanded', 'false');
  }

  renderHistoryList(entries: AssistantHistoryEntry[], activeIds: Partial<Record<AssistantProvider, string>>,
    onSelect: (id: string) => void): void {
    this.historyHeading.textContent = 'Lịch sử';
    this.historyBack.hidden = true;
    const nodes: HTMLElement[] = [];
    for (const entry of entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'assistant-history-entry';
      const title = document.createElement('strong');
      title.textContent = entry.messages.find(item => item.role === 'user')?.content ?? '';
      const details = document.createElement('small');
      const provider = entry.provider === 'codex' ? 'Codex' : 'ChatGPT';
      details.textContent = `${provider} · ${new Date(entry.updatedAt).toLocaleString('vi-VN')}${activeIds[entry.provider] === entry.id ? ' · Hiện tại' : ''}`;
      const preview = document.createElement('span');
      preview.textContent = entry.messages[entry.messages.length - 1]?.content ?? '';
      button.append(title, details, preview);
      button.addEventListener('click', () => onSelect(entry.id));
      nodes.push(button);
    }
    if (!nodes.length) {
      const empty = document.createElement('p');
      empty.className = 'assistant-history-empty';
      empty.textContent = 'Chưa có cuộc trò chuyện nào được lưu.';
      nodes.push(empty);
    }
    this.historyItems.replaceChildren(...nodes);
  }

  renderHistoryDetail(entry: AssistantHistoryEntry): void {
    this.historyHeading.textContent = entry.provider === 'codex' ? 'Codex' : 'ChatGPT';
    this.historyBack.hidden = false;
    this.historyItems.replaceChildren(...entry.messages.map(message => createMessage(message.role, message.content)));
    this.historyItems.scrollTop = 0;
  }

  setQuota(message: string | null): void {
    this.quota.textContent = message ?? '';
    this.quota.hidden = !message;
  }

  setContext(message: string): void {
    this.context.textContent = message;
  }

  setBusy(busy: boolean, cancellable = false): void {
    this.send.disabled = busy;
    this.cancel.hidden = !busy || !cancellable;
    this.cancel.disabled = !cancellable;
    this.fresh.disabled = busy;
    this.provider.disabled = busy;
    this.model.disabled = busy;
    this.reasoning.disabled = busy;
    this.historyToggle.disabled = busy;
  }

  setModels(
    options: readonly CodexModelOption[],
    selected: string,
    provider: AssistantProvider,
  ): void {
    const nodes: HTMLOptionElement[] = [];
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = provider === 'codex' ? 'Codex default' : 'ChatGPT current';
    nodes.push(defaultOption);
    for (const item of options) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.label === item.id ? item.id : `${item.label} (${item.id})`;
      nodes.push(option);
    }
    if (selected && !options.some((item) => item.id === selected)) {
      const saved = document.createElement('option');
      saved.value = selected;
      saved.textContent = `${selected} (saved)`;
      nodes.push(saved);
    }
    this.model.replaceChildren(...nodes);
    this.model.value = selected;
  }

  renderReasoningOptions(
    efforts: readonly ReasoningEffort[],
    selected: ReasoningEffort,
  ): void {
    const available = efforts.length > 0 ? efforts : ALL_REASONING_EFFORTS;
    this.reasoning.replaceChildren(...available.map((effort) => {
      const option = document.createElement('option');
      option.value = effort;
      option.textContent = REASONING_LABELS[effort];
      return option;
    }));
    this.reasoning.value = available.includes(selected) ? selected : available[0];
  }

  appendMessage(role: AssistantMessageRole, text: string, markUnread = true): void {
    this.messages.appendChild(createMessage(role, text));
    this.scrollToLatest();
    if (markUnread && !this.isOpen && role === 'assistant') this.setUnread(true);
  }

  showThinking(): void {
    this.removeThinking();
    const item = document.createElement('article');
    item.className = 'assistant-message assistant-message-assistant assistant-thinking';
    item.setAttribute('aria-label', 'Trợ lý đang xử lý');
    const label = document.createElement('small');
    label.className = 'assistant-role';
    label.textContent = 'Trợ lý';
    const dots = document.createElement('span');
    dots.className = 'assistant-thinking-dots';
    dots.textContent = '•••';
    item.append(label, dots);
    this.messages.appendChild(item);
    this.thinking = item;
    this.scrollToLatest();
  }

  removeThinking(): void {
    this.thinking?.remove();
    this.thinking = null;
  }

  clearMessages(): void {
    this.removeThinking();
    this.messages.replaceChildren();
  }

  clearInput(): void {
    this.input.value = '';
  }

  focusInput(): void {
    if (this.isOpen) this.input.focus({ preventScroll: true });
  }

  private setUnread(value: boolean): void {
    this.toggle.dataset.unread = String(value);
    this.toggle.setAttribute(
      'aria-label',
      value ? 'Mở trợ lý, có phản hồi mới' : 'Mở trợ lý',
    );
  }

  private scrollToLatest(): void {
    this.messages.scrollTop = this.messages.scrollHeight;
  }
}

function createMessage(role: AssistantMessageRole, text: string): HTMLElement {
  const item = document.createElement('article');
  item.className = `assistant-message assistant-message-${role}`;
  const label = document.createElement('small');
  label.className = 'assistant-role';
  label.textContent = role === 'user' ? 'Bạn' : 'Trợ lý';
  const body = document.createElement('div');
  body.className = 'assistant-message-text';
  body.textContent = text;
  item.append(label, body);
  return item;
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing Excel assistant element: ${selector}`);
  return element;
}
