/** A non-interactive notice scoped to one chart. CSS owns fading and removal. */
export function showHistoryEndNotice(container: HTMLElement, source: string): void {
  container.querySelector('.history-end-notice')?.remove();
  const notice = document.createElement('div');
  notice.className = 'history-end-notice';
  notice.setAttribute('role', 'status');
  notice.textContent = `Đã hết dữ liệu lịch sử từ nguồn ${source}.`;
  notice.addEventListener('animationend', () => notice.remove(), { once: true });
  container.appendChild(notice);
}
