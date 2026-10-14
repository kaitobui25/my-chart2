/** Native popover handles outside clicks, Escape and focus without a modal. */
export function bindReplaySettings(
  after: HTMLElement, enabled: () => boolean, onChange: (enabled: boolean) => void,
): void {
  const button = document.createElement('button');
  button.type = 'button'; button.id = 'replay-settings-button';
  button.className = 'replay-icon-button';
  button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>';
  button.setAttribute('aria-label', 'Cài đặt Replay');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', 'replay-settings-popup');
  const popup = document.createElement('div');
  popup.id = 'replay-settings-popup'; popup.className = 'replay-settings-popup';
  popup.setAttribute('popover', 'auto'); popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', 'Cài đặt Replay');
  const label = document.createElement('label');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox'; checkbox.checked = enabled();
  label.append(checkbox, ' Hiện số đếm cuối ngày'); popup.append(label);
  checkbox.addEventListener('change', () => onChange(checkbox.checked));
  button.addEventListener('click', () => {
    checkbox.checked = enabled();
    const bounds = button.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(innerWidth - 280, bounds.right - 260))}px`;
    popup.style.top = `${bounds.bottom + 8}px`;
    popup.togglePopover();
  });
  popup.addEventListener('toggle', () => {
    button.setAttribute('aria-expanded', String(popup.matches(':popover-open')));
  });
  after.after(button); document.body.append(popup);
}
