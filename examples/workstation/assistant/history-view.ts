import { AssistantChatHistory } from '../../excel-content-addin/assistant-chat-history';

/** Read-only archive. Opening an entry never changes the active AI conversation. */
export class AssistantHistoryView {
  readonly element = document.createElement('section');
  private readonly heading = document.createElement('strong');
  private readonly back = document.createElement('button');
  private readonly items = document.createElement('div');

  constructor(private readonly history: AssistantChatHistory, onClose: () => void) {
    this.element.className = 'assistant-history';
    this.element.hidden = true;
    this.element.setAttribute('aria-label', 'Lịch sử trò chuyện AI');
    const header = document.createElement('div');
    header.className = 'assistant-history-header';
    this.back.type = 'button';
    this.back.textContent = '← Danh sách';
    this.back.addEventListener('click', () => this.showList());
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Quay lại chat';
    close.addEventListener('click', onClose);
    header.append(this.back, this.heading, close);
    this.items.className = 'assistant-history-items';
    this.element.append(header, this.items);
  }

  showList(): void {
    this.element.hidden = false;
    this.heading.textContent = 'Lịch sử';
    this.back.hidden = true;
    this.items.replaceChildren();
    for (const entry of this.history.list()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'assistant-history-entry';
      const title = document.createElement('strong');
      title.textContent = entry.messages.find(message => message.role === 'user')?.content ?? '';
      const details = document.createElement('small');
      details.textContent = `${entry.provider === 'codex' ? 'Codex' : 'ChatGPT Web'} · ${new Date(entry.updatedAt).toLocaleString('vi-VN')}`;
      const preview = document.createElement('span');
      preview.textContent = entry.messages[entry.messages.length - 1]?.content ?? '';
      button.append(title, details, preview);
      button.addEventListener('click', () => this.showEntry(entry.id));
      this.items.append(button);
    }
    if (!this.items.childElementCount) this.items.textContent = 'Chưa có lịch sử trò chuyện.';
    this.items.scrollTop = 0;
  }

  private showEntry(id: string): void {
    const entry = this.history.get(id);
    if (!entry) { this.showList(); return; }
    this.heading.textContent = entry.provider === 'codex' ? 'Codex' : 'ChatGPT Web';
    this.back.hidden = false;
    this.items.replaceChildren();
    for (const message of entry.messages) {
      const article = document.createElement('article');
      article.className = `assistant-message assistant-message-${message.role}`;
      const role = document.createElement('small');
      role.className = 'assistant-role';
      role.textContent = message.role === 'user' ? 'Bạn' : 'AI';
      const text = document.createElement('div');
      text.className = 'assistant-message-text';
      text.textContent = message.content;
      article.append(role, text);
      this.items.append(article);
    }
    this.items.scrollTop = 0;
  }
}
