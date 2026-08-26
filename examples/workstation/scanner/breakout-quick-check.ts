import './breakout-quick-check.css';

const CHECK_ENDPOINT = '/scanner-api/breakout/check';

type QuickCheckThresholds = {
  minMedianTradedValue: number;
  minMedianVolume: number;
  minWeeklyChangePct: number;
  minRvol: number;
  strongRvol: number;
};

type BreakoutQuickCheck = {
  symbol: string;
  name: string;
  exchange: string;
  evaluatedAt: number;
  w0Start: number;
  w0End: number;
  w0Closed: boolean;
  closeW1: number;
  closeW0: number;
  weeklyChangePct: number | null;
  weeklyChangePass: boolean;
  breakoutLevel: number;
  breakoutPass: boolean;
  medianVolume: number | null;
  medianVolumePass: boolean;
  medianTradedValue: number | null;
  medianTradedValuePass: boolean;
  volumeW0: number | null;
  rvol: number | null;
  rvolPass: boolean;
  strong: boolean;
  overallPass: boolean;
  baselineCloses: number[];
  baselineVolumes: Array<number | null>;
  baselineTradedValues: Array<number | null>;
  thresholds: QuickCheckThresholds;
};

function input(id: string): HTMLInputElement | null {
  const element = document.getElementById(id);
  return element instanceof HTMLInputElement ? element : null;
}

function numberFrom(id: string, label: string): number {
  const value = Number(input(id)?.value ?? '');
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} phải là số không âm.`);
  return value;
}

function currentThresholds(): QuickCheckThresholds {
  const thresholds = {
    minMedianTradedValue: numberFrom('scanner-breakout-value', 'Median GTGD 8W') * 1_000_000_000,
    minMedianVolume: numberFrom('scanner-breakout-volume', 'Median KL 8W'),
    minWeeklyChangePct: numberFrom('scanner-breakout-change', 'Tăng tuần'),
    minRvol: numberFrom('scanner-breakout-rvol', 'RVOL tối thiểu'),
    strongRvol: numberFrom('scanner-breakout-strong', 'RVOL mạnh'),
  };
  if (thresholds.strongRvol < thresholds.minRvol) {
    throw new Error('RVOL mạnh phải lớn hơn hoặc bằng RVOL tối thiểu.');
  }
  return thresholds;
}

function price(value: number): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  }).format(value);
}

function integer(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

function percent(value: number): string {
  return `${value >= 0 ? '+' : ''}${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)}%`;
}

function multiple(value: number): string {
  return `${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)}x`;
}

function billion(value: number): string {
  return `${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  }).format(value / 1_000_000_000)} tỷ`;
}

function date(value: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(new Date(value * 1000));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.day}/${map.month}/${map.year}`;
}

function status(label: string, tone: 'pass' | 'strong' | 'fail', formula: string): HTMLElement {
  const element = document.createElement('span');
  element.className = 'scanner-check-status';
  element.dataset.tone = tone;
  element.dataset.formula = formula;
  element.textContent = label;
  element.title = formula;
  return element;
}

function row(label: string, value: string, result?: HTMLElement): HTMLTableRowElement {
  const tr = document.createElement('tr');
  const condition = document.createElement('td');
  const current = document.createElement('td');
  const outcome = document.createElement('td');
  condition.textContent = label;
  current.textContent = value;
  if (result) outcome.appendChild(result);
  tr.append(condition, current, outcome);
  return tr;
}

function formulaList(values: number[], formatter: (value: number) => string): string {
  return values.map(formatter).join(', ');
}

function nullableFormulaList(values: Array<number | null>, formatter: (value: number) => string): string {
  return values.map((value) => value === null ? 'N/A' : formatter(value)).join(', ');
}

function ensureDialog(): HTMLDialogElement {
  const existing = document.getElementById('scanner-breakout-check-dialog');
  if (existing instanceof HTMLDialogElement) return existing;

  const dialog = document.createElement('dialog');
  dialog.id = 'scanner-breakout-check-dialog';
  dialog.className = 'scanner-breakout-check-dialog';
  dialog.innerHTML = `
    <div class="scanner-breakout-check-head">
      <div><small>SCANNER 04 · QUICK CHECK</small><h3 id="scanner-breakout-check-title">Kiểm tra mã</h3><p id="scanner-breakout-check-subtitle">Dữ liệu local · tuần đã đóng</p></div>
      <button class="scanner-breakout-check-close" type="button" aria-label="Đóng">×</button>
    </div>
    <div id="scanner-breakout-check-body" class="scanner-breakout-check-body"></div>`;
  dialog.querySelector('.scanner-breakout-check-close')?.addEventListener('click', () => dialog.close());
  document.body.appendChild(dialog);
  return dialog;
}

function showError(symbol: string, message: string): void {
  const dialog = ensureDialog();
  const title = dialog.querySelector<HTMLElement>('#scanner-breakout-check-title');
  const subtitle = dialog.querySelector<HTMLElement>('#scanner-breakout-check-subtitle');
  const body = dialog.querySelector<HTMLElement>('#scanner-breakout-check-body');
  if (title) title.textContent = symbol || 'Kiểm tra mã';
  if (subtitle) subtitle.textContent = 'Scanner 04 · dữ liệu local';
  if (body) {
    body.replaceChildren();
    const error = document.createElement('div');
    error.className = 'scanner-breakout-check-error';
    error.textContent = message;
    body.appendChild(error);
  }
  if (!dialog.open) dialog.showModal();
}

function showResult(data: BreakoutQuickCheck): void {
  const dialog = ensureDialog();
  const title = dialog.querySelector<HTMLElement>('#scanner-breakout-check-title');
  const subtitle = dialog.querySelector<HTMLElement>('#scanner-breakout-check-subtitle');
  const body = dialog.querySelector<HTMLElement>('#scanner-breakout-check-body');
  if (!title || !subtitle || !body) return;

  title.textContent = `${data.symbol}${data.name ? ` · ${data.name}` : ''}`;
  subtitle.textContent = `${data.exchange} · dữ liệu local · W0 là tuần đóng mới nhất`;
  body.replaceChildren();

  const summary = document.createElement('div');
  summary.className = 'scanner-breakout-check-summary';
  summary.append(
    document.createTextNode('Kết luận: '),
    status(
      data.overallPass ? 'PASS' : 'FAILED',
      data.overallPass ? 'pass' : 'fail',
      data.overallPass
        ? 'Tất cả điều kiện Scanner 04 đều đạt.'
        : 'Ít nhất một điều kiện Scanner 04 không đạt.',
    ),
  );
  body.appendChild(summary);

  const table = document.createElement('table');
  table.className = 'scanner-breakout-check-table';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const text of ['Điều kiện', data.symbol, 'Kết quả']) {
    const th = document.createElement('th');
    th.textContent = text;
    headRow.appendChild(th);
  }
  head.appendChild(headRow);
  const tbody = document.createElement('tbody');

  const t = data.thresholds;
  const closedFormula = `bucket_end ${date(data.w0End + 86400)} <= thời điểm kiểm tra ${date(data.evaluatedAt)} → tuần W0 đã đóng`;
  tbody.appendChild(row(
    'W0 đã đóng',
    `${date(data.w0Start)} – ${date(data.w0End)}`,
    status(data.w0Closed ? 'PASS' : 'FAILED', data.w0Closed ? 'pass' : 'fail', closedFormula),
  ));
  tbody.appendChild(row('Close W-1', price(data.closeW1)));
  tbody.appendChild(row('Close W0', price(data.closeW0)));

  const weeklyFormula = data.weeklyChangePct === null
    ? `Close W-1 = ${price(data.closeW1)} không hợp lệ để tính % thay đổi.`
    : `(${price(data.closeW0)} / ${price(data.closeW1)} - 1) × 100 = ${percent(data.weeklyChangePct)}; ngưỡng ≥ ${percent(t.minWeeklyChangePct)}`;
  tbody.appendChild(row(
    'Giá tăng tuần',
    data.weeklyChangePct === null ? '—' : percent(data.weeklyChangePct),
    status(
      data.weeklyChangePass ? `PASS ≥${new Intl.NumberFormat('en-US').format(t.minWeeklyChangePct)}%` : 'FAILED',
      data.weeklyChangePass ? 'pass' : 'fail',
      weeklyFormula,
    ),
  ));

  const breakoutFormula = `${price(data.closeW0)} > max(${formulaList(data.baselineCloses, price)}) = ${price(data.breakoutLevel)}`;
  tbody.appendChild(row(
    'Max Close W-1…W-8',
    price(data.breakoutLevel),
    status(data.breakoutPass ? 'PASS breakout' : 'FAILED', data.breakoutPass ? 'pass' : 'fail', breakoutFormula),
  ));

  const medianVolumeFormula = data.medianVolume === null
    ? `median(${nullableFormulaList(data.baselineVolumes, integer)}) → thiếu volume trong baseline`
    : `median(${nullableFormulaList(data.baselineVolumes, integer)}) = ${integer(data.medianVolume)} cp; ngưỡng ≥ ${integer(t.minMedianVolume)} cp`;
  tbody.appendChild(row(
    'Median Volume 8W',
    data.medianVolume === null ? '—' : `${integer(data.medianVolume)} cp`,
    status(data.medianVolumePass ? `PASS ≥${integer(t.minMedianVolume)}` : 'FAILED', data.medianVolumePass ? 'pass' : 'fail', medianVolumeFormula),
  ));

  const medianValueFormula = data.medianTradedValue === null
    ? `median(${nullableFormulaList(data.baselineTradedValues, billion)}) → thiếu GTGD trong baseline`
    : `median(${nullableFormulaList(data.baselineTradedValues, billion)}) = ${billion(data.medianTradedValue)}; ngưỡng ≥ ${billion(t.minMedianTradedValue)}`;
  tbody.appendChild(row(
    'Median GTGD 8W',
    data.medianTradedValue === null ? '—' : billion(data.medianTradedValue),
    status(data.medianTradedValuePass ? `PASS ≥${billion(t.minMedianTradedValue)}` : 'FAILED', data.medianTradedValuePass ? 'pass' : 'fail', medianValueFormula),
  ));

  tbody.appendChild(row('Volume W0', data.volumeW0 === null ? '—' : `${integer(data.volumeW0)} cp`));

  const rvolFormula = data.rvol === null || data.volumeW0 === null || data.medianVolume === null
    ? 'RVOL = Volume W0 / Median Volume 8W → thiếu dữ liệu để tính.'
    : `${integer(data.volumeW0)} / ${integer(data.medianVolume)} = ${multiple(data.rvol)}; PASS ≥ ${multiple(t.minRvol)}; STRONG ≥ ${multiple(t.strongRvol)}`;
  const rvolLabel = data.strong ? 'STRONG' : data.rvolPass ? 'PASS' : 'FAILED';
  tbody.appendChild(row(
    'RVOL W0',
    data.rvol === null ? '—' : multiple(data.rvol),
    status(rvolLabel, data.strong ? 'strong' : data.rvolPass ? 'pass' : 'fail', rvolFormula),
  ));

  table.append(head, tbody);
  body.appendChild(table);
  if (!dialog.open) dialog.showModal();
}

async function checkSymbol(symbol: string): Promise<void> {
  const thresholds = currentThresholds();
  const response = await fetch(CHECK_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol, ...thresholds }),
    signal: AbortSignal.timeout(8000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload?.message === 'string' ? payload.message : `HTTP ${response.status}`;
    throw new Error(message);
  }
  showResult(payload as BreakoutQuickCheck);
}

function install(): boolean {
  if (document.getElementById('scanner-breakout-quick-check')) return true;
  const enabled = input('scanner-breakout-enabled');
  const details = enabled?.closest('details');
  if (!details) return false;
  const note = [...details.querySelectorAll<HTMLElement>('.scanner-control-label')]
    .find((element) => element.textContent?.includes('W0 luôn là tuần đã đóng'));
  if (!note) return false;

  const wrap = document.createElement('div');
  wrap.id = 'scanner-breakout-quick-check';
  wrap.className = 'scanner-breakout-quick-check';
  const symbol = document.createElement('input');
  symbol.id = 'scanner-breakout-symbol';
  symbol.type = 'text';
  symbol.autocomplete = 'off';
  symbol.spellcheck = false;
  symbol.maxLength = 12;
  symbol.placeholder = 'Mã cổ phiếu, VD: HTN';
  symbol.setAttribute('aria-label', 'Mã cổ phiếu để check Scanner 04');
  const check = document.createElement('button');
  check.id = 'scanner-breakout-check';
  check.className = 'scanner-breakout-check-button';
  check.type = 'button';
  check.textContent = 'Check';
  wrap.append(symbol, check);
  note.insertAdjacentElement('afterend', wrap);

  const run = async (): Promise<void> => {
    const value = symbol.value.trim().toUpperCase();
    symbol.value = value;
    if (!value) {
      showError('', 'Nhập mã cổ phiếu trước khi check.');
      symbol.focus();
      return;
    }
    check.disabled = true;
    check.textContent = 'Đang check…';
    try {
      await checkSymbol(value);
    } catch (error) {
      showError(value, error instanceof Error ? error.message : String(error));
    } finally {
      check.disabled = false;
      check.textContent = 'Check';
    }
  };

  check.addEventListener('click', () => void run());
  symbol.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void run();
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
