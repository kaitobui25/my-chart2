import './history-actions.css';
import type { AssistantHistoryEntry } from '../excel-content-addin/assistant-chat-history';

/** Sibling controls keep the archive entry and its actions independently clickable. */
export function withHistoryActions(entry: AssistantHistoryEntry, content: HTMLButtonElement): HTMLElement {
  const row = document.createElement('div');
  row.className = 'assistant-history-row';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'assistant-history-more';
  toggle.textContent = '…';
  toggle.setAttribute('aria-label', 'Tùy chọn cuộc trò chuyện');
  toggle.setAttribute('aria-expanded', 'false');
  const panel = document.createElement('div');
  panel.className = 'assistant-history-session';
  panel.id = `history-session-${entry.id}`;
  panel.hidden = true;
  toggle.setAttribute('aria-controls', panel.id);
  const label = document.createElement('small');
  label.textContent = entry.nativeSessionId ? 'Session ID · bấm để sao chép' : 'ID lịch sử · chưa lưu Session ID';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = entry.nativeSessionId ?? entry.id;
  copy.title = 'Sao chép ID';
  const status = document.createElement('small');
  status.setAttribute('role', 'status');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(entry.nativeSessionId ?? entry.id);
      status.textContent = 'Đã sao chép';
    } catch {
      status.textContent = 'Không thể truy cập clipboard. Hãy chọn và sao chép ID.';
    }
  });
  const close = () => { panel.hidden = true; toggle.setAttribute('aria-expanded', 'false'); };
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
  });
  row.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) { event.stopPropagation(); close(); toggle.focus(); }
  });
  panel.append(label, copy, status);
  row.append(content, toggle, panel);
  return row;
}
