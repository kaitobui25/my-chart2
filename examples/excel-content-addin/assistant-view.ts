import type { CodexModelOption, ReasoningEffort } from '../assistant/types';
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
    this.settings.hidden = !this.settings.hidden;
    this.settingsToggle.setAttribute('aria-expanded', String(!this.settings.hidden));
  }

  setConnectionStatus(message: string, connected: boolean): void {
    this.status.textContent = message;
    this.status.dataset.state = connected ? 'connected' : 'error';
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
    this.model.disabled = busy;
    this.reasoning.disabled = busy;
  }

  setModels(options: readonly CodexModelOption[], selected: string): void {
    const nodes: HTMLOptionElement[] = [];
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Codex default';
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
    const item = document.createElement('article');
    item.className = `assistant-message assistant-message-${role}`;
    const label = document.createElement('small');
    label.className = 'assistant-role';
    label.textContent = role === 'user' ? 'Bạn' : 'Trợ lý';
    const body = document.createElement('div');
    body.className = 'assistant-message-text';
    body.textContent = text;
    item.append(label, body);
    this.messages.appendChild(item);
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

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing Excel assistant element: ${selector}`);
  return element;
}
