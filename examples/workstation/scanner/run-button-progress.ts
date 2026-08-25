import './run-button-progress.css';
import type { ScannerRun } from './types';

const PROGRESS_EVENT = 'l2chart:scanner-run-progress';

function scanButton(): HTMLButtonElement | null {
  const element = document.getElementById('scanner-run');
  return element instanceof HTMLButtonElement ? element : null;
}

function ensureFill(button: HTMLButtonElement): HTMLElement {
  const existing = button.querySelector<HTMLElement>(':scope > .scanner-run-fill');
  if (existing) return existing;
  const fill = document.createElement('i');
  fill.className = 'scanner-run-fill';
  fill.setAttribute('aria-hidden', 'true');
  button.prepend(fill);
  return fill;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function renderButtonProgress(value: number, status: ScannerRun['status']): void {
  const button = scanButton();
  if (!button) return;
  ensureFill(button);

  const percent = status === 'complete' ? 100 : clampPercent(value);
  button.style.setProperty('--scanner-run-progress', `${percent}%`);

  const label = button.querySelector<HTMLSpanElement>(':scope > span');
  if (!label) return;
  if (status === 'running') {
    label.textContent = `Đang quét… ${percent}%`;
  } else if (status === 'complete') {
    label.textContent = 'Đang quét… 100%';
  }
}

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element) || !target.closest('#scanner-run')) return;
  const button = scanButton();
  if (!button || button.disabled) return;
  ensureFill(button);
  button.style.setProperty('--scanner-run-progress', '0%');
}, true);

window.addEventListener(PROGRESS_EVENT, (event) => {
  const run = (event as CustomEvent<ScannerRun>).detail;
  if (!run) return;
  renderButtonProgress(run.progressPct ?? 0, run.status);
});
