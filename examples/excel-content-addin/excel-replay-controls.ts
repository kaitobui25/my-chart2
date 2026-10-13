export type ReplayControlsPhase = 'idle' | 'selecting' | 'paused' | 'playing';

export interface ReplayControlsSnapshot {
  phase: ReplayControlsPhase;
  cursor: number;
  total: number;
  speed: number;
  currentTime: number | null;
  error?: string | null;
}

export interface ReplayControlsActions {
  onToggle(): void;
  onPlayPause(): void;
  onStep(): void;
  onSpeed(): void;
  onStop(): void;
  onCancelSelection(): void;
}

export interface ReplayControlsBinding {
  render(snapshot: ReplayControlsSnapshot): void;
  dispose(): void;
}

/** Binds the Excel chart's Replay toolbar without owning replay state or timers. */
export function bindExcelReplayControls(
  actions: ReplayControlsActions,
  root: ParentNode = document,
): ReplayControlsBinding {
  const toggle = requiredButton(root, '#replay-toggle');
  const controls = requiredElement<HTMLElement>(root, '#replay-controls');
  const actionRow = requiredElement<HTMLElement>(root, '#replay-actions');
  const playPause = requiredButton(root, '#replay-play-pause');
  const step = requiredButton(root, '#replay-step');
  const speed = requiredButton(root, '#replay-speed');
  const stop = requiredButton(root, '#replay-stop');
  const cancel = requiredButton(root, '#replay-cancel');
  const status = requiredElement<HTMLElement>(root, '#replay-status');
  let phase: ReplayControlsPhase = 'idle';
  let disposed = false;

  const onToggle = () => actions.onToggle();
  const onPlayPause = () => actions.onPlayPause();
  const onStep = () => actions.onStep();
  const onSpeed = () => actions.onSpeed();
  const onStop = () => actions.onStop();
  const onCancel = () => {
    actions.onCancelSelection();
    toggle.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || phase !== 'selecting' || event.defaultPrevented) return;
    // The Excel task pane also contains forms and menus which use Escape.
    if (event.target instanceof Element &&
        event.target.closest('input, textarea, select, [contenteditable], [role="dialog"], [role="menu"]')) {
      return;
    }
    if (document.querySelector(
      '#indicator-menu:not([hidden]), #symbol-menu:not([hidden]), #watchlist-symbol-menu:not([hidden]), #param-overlay:not([hidden])',
    )) return;
    event.preventDefault();
    onCancel();
  };

  toggle.addEventListener('click', onToggle);
  playPause.addEventListener('click', onPlayPause);
  step.addEventListener('click', onStep);
  speed.addEventListener('click', onSpeed);
  stop.addEventListener('click', onStop);
  cancel.addEventListener('click', onCancel);
  document.addEventListener('keydown', onKeyDown);

  return {
    render(snapshot) {
      if (disposed) return;
      phase = snapshot.phase;
      const active = phase === 'playing' || phase === 'paused';
      const selecting = phase === 'selecting';
      const hasNext = snapshot.cursor < snapshot.total - 1;
      const error = snapshot.error?.trim();

      toggle.disabled = phase !== 'idle';
      toggle.setAttribute('aria-pressed', String(phase !== 'idle'));
      toggle.setAttribute('aria-expanded', String(phase !== 'idle'));
      controls.hidden = phase === 'idle' && !error;
      actionRow.hidden = !active;
      cancel.hidden = !selecting;

      playPause.disabled = !hasNext && phase !== 'playing';
      step.disabled = !hasNext;
      const playing = phase === 'playing';
      const playLabel = playing ? 'Tạm dừng Replay' : 'Phát Replay';
      playPause.textContent = playing ? 'Tạm dừng' : 'Phát';
      playPause.title = playLabel;
      playPause.setAttribute('aria-label', playLabel);

      speed.textContent = `${snapshot.speed}×`;
      speed.title = `Tốc độ ${snapshot.speed}x · bấm để đổi (1x, 2x, 5x, 10x)`;
      speed.setAttribute('aria-label', speed.title);

      status.dataset.state = error ? 'error' : phase;
      status.setAttribute('aria-live', phase === 'playing' && !error ? 'off' : 'polite');
      if (error) {
        status.textContent = error;
      } else if (selecting) {
        status.textContent = 'Chọn nến bắt đầu trên biểu đồ · Esc để hủy';
      } else if (active) {
        const progress = `${Math.max(0, snapshot.cursor + 1).toLocaleString('vi-VN')}/${snapshot.total.toLocaleString('vi-VN')} nến`;
        const time = formatReplayTime(snapshot.currentTime);
        const finished = !hasNext ? ' · Đã đến nến cuối' : '';
        status.textContent = `Replay · ${progress}${time ? ` · ${time}` : ''}${finished}`;
      } else {
        status.textContent = '';
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      toggle.removeEventListener('click', onToggle);
      playPause.removeEventListener('click', onPlayPause);
      step.removeEventListener('click', onStep);
      speed.removeEventListener('click', onSpeed);
      stop.removeEventListener('click', onStop);
      cancel.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKeyDown);
    },
  };
}

function requiredButton(root: ParentNode, selector: string): HTMLButtonElement {
  return requiredElement<HTMLButtonElement>(root, selector);
}

function requiredElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Replay UI element missing: ${selector}`);
  return element;
}

function formatReplayTime(timestamp: number | null): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('vi-VN', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}
