import { intervalStart } from '../../src/interval';
import { buildReplaySessionCountdown } from './replay/replay-session-countdown';

export const SESSION_END_COLOR = '#facc15';
export const sessionEndModes = {
  off: 'Tắt', color: 'Tô vàng', arrow: 'Mũi tên xuống', both: 'Vàng + mũi tên',
} as const;
export type SessionEndMode = keyof typeof sessionEndModes;

/** Include native and replay bucket timestamps, using only the source session calendar. */
export function sessionEndTimes(historyTimes: readonly number[], interval: string, provider: string, symbol: string): number[] {
  const offset = provider === 'yfinance-jp' ? 540 : 420;
  const candidates = [...new Set(historyTimes.flatMap(time => [time, intervalStart(time, interval, offset)]))];
  return buildReplaySessionCountdown(candidates, historyTimes, interval, provider, symbol)
    .filter(label => label.text === '1').map(label => label.time);
}

/** One shared popover for all tiles; native light-dismiss handles Escape/outside clicks. */
export function createSessionEndSettings(getMode: () => SessionEndMode, onChange: (mode: SessionEndMode) => void) {
  const popup = document.createElement('div');
  popup.className = 'session-end-settings';
  popup.setAttribute('popover', 'auto');
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', 'Cài đặt nến');
  const label = document.createElement('label');
  label.textContent = 'Đánh dấu nến cuối ngày';
  const select = document.createElement('select');
  select.setAttribute('aria-label', label.textContent);
  for (const [value, text] of Object.entries(sessionEndModes)) select.add(new Option(text, value));
  label.append(select); popup.append(label);
  const note = document.createElement('small');
  note.textContent = 'Áp dụng cho khung intraday có lịch phiên hỗ trợ. Lưu cho tất cả biểu đồ.';
  popup.append(note); document.body.append(popup);
  select.addEventListener('change', () => onChange(select.value as SessionEndMode));
  return (anchor: HTMLElement) => {
    select.value = getMode();
    const bounds = anchor.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(innerWidth - 288, bounds.left))}px`;
    popup.style.top = `${Math.max(8, Math.min(innerHeight - 156, bounds.bottom + 8))}px`;
    popup.showPopover();
  };
}
