import './eod-data-check.css';

const CHECK_ENDPOINT = '/scanner-api/eod/check-data';

type EodDataCheckRow = {
  symbol: string;
  exchange: string;
  latestVolume: number;
  observedSessions: number;
  expectedSessions: number;
  missingCount: number;
  missingTimes: number[];
  status: 'PASS' | 'MISSING';
};

type EodDataCheckResult = {
  provider: string;
  checkedAt: number;
  checkDate: number;
  fromTime: number;
  toTime: number;
  lookbackMonths: number;
  sampleSize: number;
  expectedSessions: number;
  calendarRule: 'weekday';
  allPass: boolean;
  symbols: EodDataCheckRow[];
};

function integer(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

function date(value: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(value * 1000));
}

function ensureDialog(): HTMLDialogElement {
  const existing = document.getElementById('scanner-eod-data-dialog');
  if (existing instanceof HTMLDialogElement) return existing;

  const dialog = document.createElement('dialog');
  dialog.id = 'scanner-eod-data-dialog';
  dialog.className = 'scanner-eod-data-dialog';
  dialog.innerHTML = `
    <div class="scanner-eod-data-head">
      <div>
        <small>EOD LOCAL · DATA CHECK</small>
        <h3>Kiểm tra thiếu ngày</h3>
        <p id="scanner-eod-data-subtitle">40 mã volume lớn nhất · lùi 2 tháng từ ngày check</p>
      </div>
      <button class="scanner-eod-data-close" type="button" aria-label="Đóng">×</button>
    </div>
    <div id="scanner-eod-data-body" class="scanner-eod-data-body"></div>`;
  dialog.querySelector('.scanner-eod-data-close')?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.body.appendChild(dialog);
  return dialog;
}

function showError(message: string): void {
  const dialog = ensureDialog();
  const body = dialog.querySelector<HTMLElement>('#scanner-eod-data-body');
  if (body) {
    body.replaceChildren();
    const error = document.createElement('div');
    error.className = 'scanner-eod-data-error';
    error.textContent = message;
    body.appendChild(error);
  }
  if (!dialog.open) dialog.showModal();
}

function showResult(data: EodDataCheckResult): void {
  const dialog = ensureDialog();
  const subtitle = dialog.querySelector<HTMLElement>('#scanner-eod-data-subtitle');
  const body = dialog.querySelector<HTMLElement>('#scanner-eod-data-body');
  if (!subtitle || !body) return;

  subtitle.textContent = `${date(data.fromTime)} – ${date(data.toTime)} · ${data.sampleSize} mã · ${data.expectedSessions} phiên kỳ vọng`;
  body.replaceChildren();

  const failed = data.symbols.filter((row) => row.missingCount > 0).length;
  const summary = document.createElement('div');
  summary.className = 'scanner-eod-data-summary';
  summary.dataset.tone = data.allPass ? 'pass' : 'fail';
  summary.innerHTML = data.allPass
    ? `<strong>PASS</strong><span>${data.sampleSize}/${data.sampleSize} mã đủ toàn bộ ${data.expectedSessions} phiên.</span>`
    : `<strong>FAILED</strong><span>${failed}/${data.sampleSize} mã đang thiếu nến ngày.</span>`;
  body.appendChild(summary);

  const note = document.createElement('p');
  note.className = 'scanner-eod-data-note';
  note.textContent = `Mốc = ngày bấm Check data, lùi 2 tháng. Nếu phiên hôm nay chưa đóng thì tính đến phiên trước. Mỗi mã được so với cùng ${data.expectedSessions} phiên kỳ vọng.`;
  body.appendChild(note);

  const wrap = document.createElement('div');
  wrap.className = 'scanner-eod-data-table-wrap';
  const table = document.createElement('table');
  table.className = 'scanner-eod-data-table';
  table.innerHTML = '<thead><tr><th>Mã</th><th>Volume</th><th>Data</th><th>Kết quả</th><th>Ngày thiếu</th></tr></thead>';
  const tbody = document.createElement('tbody');

  for (const row of data.symbols) {
    const tr = document.createElement('tr');
    if (row.missingCount > 0) tr.dataset.tone = 'fail';

    const symbol = document.createElement('td');
    symbol.innerHTML = `<strong>${row.symbol}</strong><small>${row.exchange}</small>`;

    const volume = document.createElement('td');
    volume.textContent = integer(row.latestVolume);

    const sessions = document.createElement('td');
    sessions.textContent = `${row.observedSessions}/${row.expectedSessions}`;

    const status = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'scanner-eod-data-status';
    badge.dataset.tone = row.missingCount ? 'fail' : 'pass';
    badge.textContent = row.missingCount ? `FAILED · thiếu ${row.missingCount}` : 'PASS';
    status.appendChild(badge);

    const missing = document.createElement('td');
    missing.className = 'scanner-eod-data-missing';
    missing.textContent = row.missingTimes.length ? row.missingTimes.map(date).join(', ') : '—';

    tr.append(symbol, volume, sessions, status, missing);
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  wrap.appendChild(table);
  body.appendChild(wrap);
  if (!dialog.open) dialog.showModal();
}

async function runCheck(): Promise<void> {
  const response = await fetch(CHECK_ENDPOINT, {
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload?.message === 'string' ? payload.message : `HTTP ${response.status}`;
    throw new Error(message);
  }
  showResult(payload as EodDataCheckResult);
}

function install(): boolean {
  if (document.getElementById('scanner-eod-check-data')) return true;
  const update = document.getElementById('scanner-eod-update');
  if (!(update instanceof HTMLButtonElement)) return false;

  const actions = document.createElement('div');
  actions.className = 'scanner-eod-actions';
  update.insertAdjacentElement('beforebegin', actions);
  actions.appendChild(update);

  const check = document.createElement('button');
  check.id = 'scanner-eod-check-data';
  check.className = 'scanner-secondary-button scanner-eod-check-data';
  check.type = 'button';
  check.title = 'Check 40 cổ phiếu volume lớn nhất, lùi 2 tháng từ thời điểm hiện tại';
  check.textContent = 'Check data';
  actions.appendChild(check);

  let checking = false;
  const syncDisabled = (): void => {
    check.disabled = checking || update.disabled;
  };
  new MutationObserver(syncDisabled).observe(update, { attributes: true, attributeFilter: ['disabled'] });
  syncDisabled();

  check.addEventListener('click', () => {
    if (checking) return;
    checking = true;
    check.textContent = 'Đang check…';
    syncDisabled();
    void runCheck()
      .catch((error) => showError(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        checking = false;
        check.textContent = 'Check data';
        syncDisabled();
      });
  });
  return true;
}

if (!install()) {
  const observer = new MutationObserver(() => {
    if (!install()) return;
    observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}
