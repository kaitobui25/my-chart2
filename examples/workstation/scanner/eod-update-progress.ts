import './eod-update-progress.css';

const UPDATE_ENDPOINT = '/scanner-api/eod/import-latest';
const PROGRESS_ENDPOINT = '/scanner-api/eod/update-progress';
const UPDATE_TIMEOUT_MS = 86_000;
const PROGRESS_TIMEOUT_MS = 3_000;
const PROGRESS_POLL_MS = 250;

type EodUpdateProgress = {
  updating: boolean;
  progressPct: number;
  stage: string | null;
};

type EodLogEntry = {
  at: number;
  percent: number | null;
  message: string;
  tone: 'info' | 'error' | 'success';
};

type EodFailureSnapshot = {
  entries: EodLogEntry[];
  startedAt: number;
  errorMessage: string;
};

function requestUrl(value: RequestInfo | URL): string {
  if (typeof value === 'string') return value;
  if (value instanceof URL) return value.toString();
  return value.url;
}

function requestMethod(value: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (value instanceof Request) return value.method.toUpperCase();
  return 'GET';
}

function updateButton(): HTMLButtonElement | null {
  const element = document.getElementById('scanner-eod-update');
  return element instanceof HTMLButtonElement ? element : null;
}

function errorBadge(): HTMLSpanElement | null {
  const element = document.getElementById('scanner-eod-badge');
  return element instanceof HTMLSpanElement ? element : null;
}

function ensureFill(button: HTMLButtonElement): HTMLElement {
  const existing = button.querySelector<HTMLElement>(':scope > .scanner-eod-update-fill');
  if (existing) return existing;
  const fill = document.createElement('i');
  fill.className = 'scanner-eod-update-fill';
  fill.setAttribute('aria-hidden', 'true');
  button.prepend(fill);
  return fill;
}

function buttonLabel(button: HTMLButtonElement): HTMLSpanElement | null {
  const spans = button.querySelectorAll<HTMLSpanElement>(':scope > span');
  return spans.length ? spans.item(spans.length - 1) : null;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function renderProgress(percent: number, stage?: string | null): void {
  const button = updateButton();
  if (!button) return;
  ensureFill(button);
  const value = clampPercent(percent);
  button.classList.add('is-eod-progress');
  button.style.setProperty('--scanner-eod-progress', `${value}%`);
  const label = buttonLabel(button);
  if (label) label.textContent = `Cập nhật EOD · ${value}%`;
  if (stage) button.title = stage;
}

function resetProgress(): void {
  const button = updateButton();
  if (!button) return;
  button.classList.remove('is-eod-progress');
  button.style.setProperty('--scanner-eod-progress', '0%');
  const label = buttonLabel(button);
  if (label) label.textContent = 'Cập nhật EOD';
  button.title = 'Tự kiểm tra và bù dữ liệu EOD thiếu trong 1 năm gần nhất';
}

function pushLog(
  entries: EodLogEntry[],
  message: string,
  percent: number | null,
  tone: EodLogEntry['tone'] = 'info',
): void {
  const previous = entries.length ? entries[entries.length - 1] : undefined;
  if (previous?.message === message && previous.percent === percent && previous.tone === tone) return;
  entries.push({ at: Date.now(), percent, message, tone });
}

function ensureErrorDialog(): HTMLDialogElement {
  const existing = document.getElementById('scanner-eod-update-error-dialog');
  if (existing instanceof HTMLDialogElement) return existing;

  const dialog = document.createElement('dialog');
  dialog.id = 'scanner-eod-update-error-dialog';
  dialog.className = 'scanner-eod-update-error-dialog';
  dialog.innerHTML = `
    <div class="scanner-eod-update-error-head">
      <div>
        <small>EOD UPDATE · ERROR LOG</small>
        <h3>Cập nhật EOD thất bại</h3>
        <p id="scanner-eod-update-error-summary"></p>
      </div>
      <button class="scanner-eod-update-error-close" type="button" aria-label="Đóng">×</button>
    </div>
    <div id="scanner-eod-update-error-body" class="scanner-eod-update-error-body"></div>`;
  dialog.querySelector('.scanner-eod-update-error-close')?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.body.appendChild(dialog);
  return dialog;
}

function clock(value: number): string {
  return new Intl.DateTimeFormat('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function seconds(value: number): string {
  return `${Math.max(0, value / 1000).toFixed(1)}s`;
}

function lastStageEntry(entries: EodLogEntry[]): EodLogEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.tone === 'info' && entry.percent !== null && entry.message !== 'Nhấn Cập nhật EOD') {
      return entry;
    }
  }
  return undefined;
}

function appendDiagnosticRow(container: HTMLElement, labelText: string, valueText: string): void {
  const row = document.createElement('div');
  const label = document.createElement('b');
  label.textContent = labelText;
  const value = document.createElement('span');
  value.textContent = valueText;
  row.append(label, value);
  container.appendChild(row);
}

function showErrorLog(entries: EodLogEntry[], startedAt: number, errorMessage: string): void {
  const dialog = ensureErrorDialog();
  const summary = dialog.querySelector<HTMLElement>('#scanner-eod-update-error-summary');
  const body = dialog.querySelector<HTMLElement>('#scanner-eod-update-error-body');
  if (!summary || !body) return;

  const lastEntry = entries.length ? entries[entries.length - 1] : undefined;
  const endedAt = lastEntry?.at ?? Date.now();
  const elapsedSeconds = Math.max(0, (endedAt - startedAt) / 1000);
  summary.textContent = `Chạy ${elapsedSeconds.toFixed(1)} giây · timeout ${Math.round(UPDATE_TIMEOUT_MS / 1000)} giây · ${entries.length} mốc log`;
  body.replaceChildren();

  const finalError = document.createElement('div');
  finalError.className = 'scanner-eod-update-error-final';
  finalError.textContent = errorMessage;
  body.appendChild(finalError);

  const stage = lastStageEntry(entries);
  const diagnosis = document.createElement('div');
  diagnosis.className = 'scanner-eod-update-diagnosis';
  const diagnosisTitle = document.createElement('strong');
  diagnosisTitle.textContent = 'Chẩn đoán nhanh';
  diagnosis.appendChild(diagnosisTitle);
  if (stage) {
    const stalledMs = Math.max(0, endedAt - stage.at);
    appendDiagnosticRow(
      diagnosis,
      'Kẹt tại',
      `${stage.percent === null ? '—' : `${clampPercent(stage.percent)}%`} · ${stage.message}`,
    );
    appendDiagnosticRow(diagnosis, 'Không chuyển bước', seconds(stalledMs));
    appendDiagnosticRow(diagnosis, 'Progress cuối nhận được', `${clock(stage.at)} · +${seconds(stage.at - startedAt)}`);
  }
  appendDiagnosticRow(diagnosis, 'Request', `POST ${UPDATE_ENDPOINT}`);
  appendDiagnosticRow(
    diagnosis,
    'Theo dõi progress',
    `GET ${PROGRESS_ENDPOINT} mỗi ${PROGRESS_POLL_MS}ms · timeout mỗi lần ${Math.round(PROGRESS_TIMEOUT_MS / 1000)}s`,
  );
  appendDiagnosticRow(diagnosis, 'Timeout tổng', `${Math.round(UPDATE_TIMEOUT_MS / 1000)}s ở frontend`);
  if (errorMessage.startsWith('TIMEOUT')) {
    appendDiagnosticRow(
      diagnosis,
      'Lưu ý',
      'Frontend đã ngừng chờ. Thread Python đang chạy có thể vẫn tiếp tục cho tới khi bước backend hiện tại kết thúc.',
    );
  }
  body.appendChild(diagnosis);

  const timelineTitle = document.createElement('div');
  timelineTitle.className = 'scanner-eod-update-log-title';
  timelineTitle.textContent = 'Timeline chi tiết';
  body.appendChild(timelineTitle);

  const timeline = document.createElement('div');
  timeline.className = 'scanner-eod-update-log';
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const next = index + 1 < entries.length ? entries[index + 1] : undefined;
    const row = document.createElement('div');
    row.className = 'scanner-eod-update-log-row';
    row.dataset.tone = entry.tone;

    const time = document.createElement('time');
    time.textContent = clock(entry.at);

    const elapsed = document.createElement('span');
    elapsed.className = 'scanner-eod-update-log-elapsed';
    elapsed.textContent = `+${seconds(entry.at - startedAt)}`;

    const percent = document.createElement('strong');
    percent.textContent = entry.percent === null ? '—' : `${clampPercent(entry.percent)}%`;

    const messageWrap = document.createElement('span');
    messageWrap.className = 'scanner-eod-update-log-message';
    const message = document.createElement('span');
    message.textContent = entry.message;
    messageWrap.appendChild(message);
    if (next) {
      const detail = document.createElement('small');
      const deltaMs = Math.max(0, next.at - entry.at);
      detail.textContent = next.tone === 'error'
        ? `Không có mốc mới trong ${seconds(deltaMs)} trước khi lỗi.`
        : `Mất ${seconds(deltaMs)} để tới mốc kế tiếp.`;
      messageWrap.appendChild(detail);
    }

    row.append(time, elapsed, percent, messageWrap);
    timeline.appendChild(row);
  }
  body.appendChild(timeline);
  if (!dialog.open) dialog.showModal();
}

const originalFetch = window.fetch.bind(window);
let trackingToken = 0;
let lastFailure: EodFailureSnapshot | null = null;

function syncErrorBadge(): void {
  const badge = errorBadge();
  if (!badge) return;
  if (lastFailure) {
    badge.style.cursor = 'pointer';
    badge.title = 'Bấm để xem log lỗi cập nhật EOD gần nhất';
    badge.tabIndex = 0;
    badge.setAttribute('role', 'button');
    badge.setAttribute('aria-label', 'Cập nhật lỗi. Bấm để xem log lỗi cập nhật EOD gần nhất.');
    return;
  }
  badge.style.removeProperty('cursor');
  badge.removeAttribute('title');
  badge.removeAttribute('tabindex');
  badge.removeAttribute('role');
  badge.removeAttribute('aria-label');
}

function openLastFailure(): void {
  if (!lastFailure) return;
  showErrorLog(lastFailure.entries, lastFailure.startedAt, lastFailure.errorMessage);
}

function installErrorBadge(): boolean {
  const badge = errorBadge();
  if (!badge) return false;
  if (badge.dataset.eodErrorLogInstalled === '1') {
    syncErrorBadge();
    return true;
  }
  badge.dataset.eodErrorLogInstalled = '1';
  badge.addEventListener('click', openLastFailure);
  badge.addEventListener('keydown', (event) => {
    if (!lastFailure || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    openLastFailure();
  });
  syncErrorBadge();
  return true;
}

async function readProgress(): Promise<EodUpdateProgress | null> {
  try {
    const response = await originalFetch(PROGRESS_ENDPOINT, {
      cache: 'no-store',
      signal: AbortSignal.timeout(PROGRESS_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.json() as EodUpdateProgress;
  } catch {
    return null;
  }
}

async function responseError(response: Response): Promise<string> {
  try {
    const payload = await response.clone().json() as { message?: unknown };
    if (typeof payload?.message === 'string' && payload.message.trim()) return payload.message;
  } catch {
    // Fall through to HTTP status below.
  }
  return `HTTP ${response.status}`;
}

function requestErrorMessage(error: unknown): string {
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `TIMEOUT sau ${Math.round(UPDATE_TIMEOUT_MS / 1000)} giây: ${error.message || error.name}`;
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

async function trackProgress(
  token: number,
  request: Promise<Response>,
  startedAt: number,
  entries: EodLogEntry[],
): Promise<void> {
  let settled = false;
  let responseValue: Response | null = null;
  let requestError: unknown = null;
  let lastStage: string | null = null;
  let failedProgressReads = 0;
  let progressOfflineLogged = false;

  void request.then(
    (response) => {
      responseValue = response;
      settled = true;
    },
    (error: unknown) => {
      requestError = error;
      settled = true;
    },
  );

  while (!settled && token === trackingToken) {
    const progress = await readProgress();
    if (progress) {
      failedProgressReads = 0;
      renderProgress(progress.progressPct, progress.stage);
      if (progress.stage && progress.stage !== lastStage) {
        lastStage = progress.stage;
        pushLog(entries, progress.stage, progress.progressPct);
      }
    } else {
      failedProgressReads += 1;
      if (failedProgressReads >= 3 && !progressOfflineLogged) {
        progressOfflineLogged = true;
        pushLog(entries, 'Không đọc được progress từ scanner sidecar sau 3 lần liên tiếp', null, 'error');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, PROGRESS_POLL_MS));
  }
  if (token !== trackingToken) return;

  const finalProgress = await readProgress();
  if (finalProgress) {
    renderProgress(finalProgress.progressPct, finalProgress.stage);
    if (finalProgress.stage && finalProgress.stage !== lastStage) {
      pushLog(entries, finalProgress.stage, finalProgress.progressPct);
    }
  }

  if (responseValue?.ok) {
    pushLog(entries, 'Hoàn tất cập nhật EOD', 100, 'success');
    renderProgress(100, finalProgress?.stage ?? 'Hoàn tất cập nhật EOD');
    window.setTimeout(() => {
      if (token !== trackingToken) return;
      resetProgress();
    }, 650);
    return;
  }

  const message = requestError
    ? requestErrorMessage(requestError)
    : responseValue
      ? await responseError(responseValue)
      : 'Cập nhật EOD kết thúc nhưng không nhận được phản hồi.';
  pushLog(entries, message, finalProgress?.progressPct ?? null, 'error');
  lastFailure = {
    entries: entries.map((entry) => ({ ...entry })),
    startedAt,
    errorMessage: message,
  };
  syncErrorBadge();
  showErrorLog(lastFailure.entries, lastFailure.startedAt, lastFailure.errorMessage);
  resetProgress();
}

window.fetch = (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const isUpdate = requestMethod(request, init) === 'POST'
    && requestUrl(request).includes(UPDATE_ENDPOINT);
  if (!isUpdate) return originalFetch(request, init);

  lastFailure = null;
  syncErrorBadge();
  const token = ++trackingToken;
  const startedAt = Date.now();
  const entries: EodLogEntry[] = [];
  pushLog(entries, 'Nhấn Cập nhật EOD', 0);
  pushLog(entries, `Bắt đầu POST ${UPDATE_ENDPOINT}`, 0);
  renderProgress(0, 'Chuẩn bị cập nhật EOD');
  const response = originalFetch(request, init);
  void trackProgress(token, response, startedAt, entries);
  return response;
};

if (!installErrorBadge()) {
  const observer = new MutationObserver(() => {
    if (!installErrorBadge()) return;
    observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}
