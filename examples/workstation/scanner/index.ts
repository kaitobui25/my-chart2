import './style.css';
import {
  getCafeFEodStatus,
  getScannerSources,
  startScannerRun,
  updateCafeFEod,
  waitForScannerRun,
} from './api';
import type {
  BreakoutScannerResult,
  CafeFEodStatus,
  HeikinScannerResult,
  ScannerCandleKind,
  ScannerRequest,
  ScannerResult,
  ScannerRun,
  ScannerSource,
  ScannerSourceId,
  ScannerTimeframe,
} from './types';

const STORAGE_KEY = 'l2chart.scanner.filters.v2';
const EOD_SOURCE: ScannerSourceId = 'vn_eod';
const EOD_STALE_DAYS = 5;

const BREAKOUT_DEFAULTS = {
  minMedianTradedValueBn: '5',
  minMedianVolume: '500000',
  minWeeklyChangePct: '4',
  minRvol: '1.5',
  strongRvol: '2.5',
} as const;

type StoredState = {
  source?: ScannerSourceId;
  universes?: string[];
  priceMin?: string;
  priceMax?: string;
  volumeMin?: string;
  volumeMax?: string;
  marketCapMin?: string;
  marketCapMax?: string;
  timeframe?: ScannerTimeframe;
  green?: boolean;
  noLowerWick?: boolean;
  closeChangePctMin?: string;
  candle?: ScannerCandleKind;
  breakoutEnabled?: boolean;
  breakoutMinMedianTradedValueBn?: string;
  breakoutMinMedianVolume?: string;
  breakoutMinWeeklyChangePct?: string;
  breakoutMinRvol?: string;
  breakoutStrongRvol?: string;
};

const DEFAULT_STATE: Required<Pick<StoredState, 'timeframe' | 'green' | 'noLowerWick' | 'closeChangePctMin' | 'candle'>> = {
  timeframe: '1M',
  green: true,
  noLowerWick: true,
  closeChangePctMin: '0',
  candle: 'current',
};

function readStored(): StoredState {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return value && typeof value === 'object' ? value as StoredState : {};
  } catch {
    return {};
  }
}

function saveStored(value: StoredState): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* optional */ }
}

function numberOrNull(value: string): number | null {
  if (!value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function requiredNumber(id: string, label: string): number {
  const value = numberOrNull(input(id).value);
  if (value === null || value < 0) throw new Error(`${label} phải là số không âm.`);
  return value;
}

function compact(value: number | null): string {
  if (value === null) return '—';
  return new Intl.NumberFormat('en-US', {
    notation: Math.abs(value) >= 1_000_000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(value);
}

function price(value: number | null): string {
  if (value === null) return '—';
  const digits = Math.abs(value) < 1 ? 6 : Math.abs(value) < 100 ? 3 : 1;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value);
}

function percent(value: number | null): string {
  if (value === null) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function multiple(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)}x`;
}

function billionVnd(value: number | null): string {
  return value === null ? '—' : `${(value / 1_000_000_000).toFixed(2)} tỷ`;
}

function dateOnly(value: number): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'medium',
    timeZone: 'Asia/Ho_Chi_Minh',
  }).format(new Date(value * 1000));
}

function timestamp(value: number): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value * 1000));
}

function input(id: string): HTMLInputElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`Missing scanner input: ${id}`);
  return element;
}

function select(id: string): HTMLSelectElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLSelectElement)) throw new Error(`Missing scanner select: ${id}`);
  return element;
}

function button(id: string): HTMLButtonElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Missing scanner button: ${id}`);
  return element;
}

class ScannerPanel {
  private stored = readStored();
  private sources: ScannerSource[] = [];
  private running = false;
  private eodUpdating = false;
  private eodStatus: CafeFEodStatus | null = null;
  private readonly overlay: HTMLDivElement;
  private readonly source: HTMLSelectElement;
  private readonly universe: HTMLDivElement;
  private readonly progress: HTMLDivElement;
  private readonly results: HTMLDivElement;
  private readonly resultCount: HTMLSpanElement;
  private readonly resultHint: HTMLElement;
  private readonly sourceHint: HTMLSpanElement;
  private readonly marketCapGroup: HTMLDivElement;
  private readonly scanButton: HTMLButtonElement;
  private readonly resetButton: HTMLButtonElement;
  private readonly eodCard: HTMLDivElement;
  private readonly eodBadge: HTMLSpanElement;
  private readonly eodSummary: HTMLSpanElement;
  private readonly eodTradeDate: HTMLElement;
  private readonly eodActiveSymbols: HTMLElement;
  private readonly eodRetention: HTMLElement;
  private readonly eodUpdateButton: HTMLButtonElement;

  constructor() {
    this.overlay = document.createElement('div');
    this.overlay.id = 'scanner-overlay';
    this.overlay.hidden = true;
    this.overlay.innerHTML = `
      <section id="scanner-panel" role="dialog" aria-modal="true" aria-label="Market scanner">
        <header class="scanner-head">
          <div class="scanner-title-block">
            <span class="scanner-eyebrow">MARKET SCANNER</span>
            <div class="scanner-title-row"><h2>Lọc nhanh, giữ đúng tín hiệu</h2><span id="scanner-source-hint" class="scanner-source-hint">Local-first workflow</span></div>
          </div>
          <div class="scanner-head-actions">
            <label class="scanner-source-select"><span>Nguồn dữ liệu</span><select id="scanner-source"></select></label>
            <button class="scanner-close" type="button" aria-label="Đóng">×</button>
          </div>
        </header>

        <div id="scanner-eod-card" class="scanner-eod-card" hidden>
          <div class="scanner-eod-copy">
            <div class="scanner-eod-heading"><span id="scanner-eod-badge" class="scanner-status-badge">CafeF EOD</span><strong>Dữ liệu scanner local</strong></div>
            <span id="scanner-eod-summary" class="scanner-eod-summary">Đang đọc trạng thái dữ liệu…</span>
          </div>
          <div class="scanner-eod-metrics">
            <span><small>Phiên mới nhất</small><strong id="scanner-eod-date">—</strong></span>
            <span><small>Mã đang quét</small><strong id="scanner-eod-active">—</strong></span>
            <span><small>Lịch sử / mã</small><strong id="scanner-eod-retention">1,000 phiên</strong></span>
          </div>
          <button id="scanner-eod-update" class="scanner-secondary-button scanner-eod-update" type="button" title="Tương đương: python cafef_eod.py import-latest --mode eod">
            <span class="scanner-refresh-icon" aria-hidden="true">↻</span><span>Cập nhật EOD</span>
          </button>
        </div>

        <div class="scanner-layout">
          <aside class="scanner-sidebar">
            <details class="scanner-filter-section" name="scanner-filter">
              <summary class="scanner-section-head"><span>01</span><strong>Thị trường</strong></summary>
              <div id="scanner-universe" class="scanner-universes"></div>
            </details>

            <details class="scanner-filter-section" name="scanner-filter">
              <summary class="scanner-section-head"><span>02</span><strong>Giá & thanh khoản</strong></summary>
              <div class="scanner-pair-grid">
                <label class="scanner-field"><span>Giá từ</span><input id="scanner-price-min" type="number" min="0" step="any" placeholder="Bất kỳ"></label>
                <label class="scanner-field"><span>Giá đến</span><input id="scanner-price-max" type="number" min="0" step="any" placeholder="Bất kỳ"></label>
                <label class="scanner-field"><span>KL từ</span><input id="scanner-volume-min" type="number" min="0" step="any" placeholder="Bất kỳ"></label>
                <label class="scanner-field"><span>KL đến</span><input id="scanner-volume-max" type="number" min="0" step="any" placeholder="Bất kỳ"></label>
              </div>
              <div id="scanner-market-cap-group" class="scanner-market-cap-group">
                <div class="scanner-pair-grid">
                  <label class="scanner-field"><span>Market cap từ</span><input id="scanner-mc-min" type="number" min="0" step="any" placeholder="Bất kỳ"></label>
                  <label class="scanner-field"><span>Market cap đến</span><input id="scanner-mc-max" type="number" min="0" step="any" placeholder="Bất kỳ"></label>
                </div>
              </div>
            </details>

            <details class="scanner-filter-section" name="scanner-filter">
              <summary class="scanner-section-head"><span>03</span><strong>Heikin Ashi</strong></summary>
              <div class="scanner-control-stack">
                <div>
                  <span class="scanner-control-label">Timeframe</span>
                  <div class="scanner-segmented">
                    <label><input type="radio" name="scanner-ha-timeframe" value="1w"><span>Week</span></label>
                    <label><input type="radio" name="scanner-ha-timeframe" value="1M"><span>Month</span></label>
                  </div>
                </div>
                <div>
                  <span class="scanner-control-label">Cây nến</span>
                  <div class="scanner-segmented">
                    <label><input type="radio" name="scanner-candle-kind" value="current"><span>Hiện tại</span></label>
                    <label><input type="radio" name="scanner-candle-kind" value="closed"><span>Đã đóng</span></label>
                  </div>
                </div>
                <label class="scanner-field scanner-field-wide"><span>HA close tăng tối thiểu</span><div class="scanner-unit-input"><input id="scanner-ha-change" type="number" step="any" value="0"><b>%</b></div></label>
                <label class="scanner-switch"><span><strong>Nến xanh</strong><small>HA close &gt; HA open</small></span><input id="scanner-green" type="checkbox"><i></i></label>
                <label class="scanner-switch"><span><strong>Không râu dưới</strong><small>Ưu tiên lực mua sạch</small></span><input id="scanner-no-lower" type="checkbox"><i></i></label>
              </div>
            </details>

            <details class="scanner-filter-section" name="scanner-filter">
              <summary class="scanner-section-head"><span>04</span><strong>Breakout + Volume</strong></summary>
              <div class="scanner-control-stack">
                <label class="scanner-switch"><span><strong>Bật Scanner 04</strong><small>HOSE · chỉ tuần đã đóng · median 8W</small></span><input id="scanner-breakout-enabled" type="checkbox"><i></i></label>
                <div class="scanner-pair-grid">
                  <label class="scanner-field"><span>Median GTGD 8W từ</span><div class="scanner-unit-input"><input id="scanner-breakout-value" type="number" min="0" step="any" value="5"><b>tỷ</b></div></label>
                  <label class="scanner-field"><span>Median KL 8W từ</span><input id="scanner-breakout-volume" type="number" min="0" step="1" value="500000"></label>
                  <label class="scanner-field"><span>Tăng tuần từ</span><div class="scanner-unit-input"><input id="scanner-breakout-change" type="number" min="0" step="any" value="4"><b>%</b></div></label>
                  <label class="scanner-field"><span>RVOL từ</span><div class="scanner-unit-input"><input id="scanner-breakout-rvol" type="number" min="0" step="any" value="1.5"><b>x</b></div></label>
                </div>
                <label class="scanner-field scanner-field-wide"><span>RVOL mạnh từ</span><div class="scanner-unit-input"><input id="scanner-breakout-strong" type="number" min="0" step="any" value="2.5"><b>x</b></div></label>
                <span class="scanner-control-label">W0 luôn là tuần đã đóng. W+1 chỉ xuất hiện sau khi tuần kế tiếp đóng.</span>
              </div>
            </details>

            <div class="scanner-sidebar-actions">
              <button id="scanner-reset" class="scanner-secondary-button" type="button">Đặt lại</button>
              <button id="scanner-run" class="scanner-run-button" type="button"><span>Quét thị trường</span><b>→</b></button>
            </div>
          </aside>

          <main class="scanner-main">
            <div class="scanner-results-head">
              <div><span class="scanner-eyebrow">KẾT QUẢ</span><h3><span id="scanner-result-count">0</span> mã phù hợp</h3></div>
              <small id="scanner-results-hint">Đã xếp theo HA close Δ giảm dần · click một dòng để mở chart.</small>
            </div>
            <div id="scanner-progress" class="scanner-progress"><span class="scanner-progress-idle">Sẵn sàng quét.</span></div>
            <div id="scanner-results" class="scanner-table-wrap">
              <div class="scanner-empty"><strong>Chưa có kết quả</strong><span>Chọn bộ lọc bên trái rồi bấm “Quét thị trường”.</span></div>
            </div>
          </main>
        </div>
      </section>`;
    document.body.appendChild(this.overlay);

    this.source = select('scanner-source');
    this.universe = document.getElementById('scanner-universe') as HTMLDivElement;
    this.progress = document.getElementById('scanner-progress') as HTMLDivElement;
    this.results = document.getElementById('scanner-results') as HTMLDivElement;
    this.resultCount = document.getElementById('scanner-result-count') as HTMLSpanElement;
    this.resultHint = document.getElementById('scanner-results-hint') as HTMLElement;
    this.sourceHint = document.getElementById('scanner-source-hint') as HTMLSpanElement;
    this.marketCapGroup = document.getElementById('scanner-market-cap-group') as HTMLDivElement;
    this.scanButton = button('scanner-run');
    this.resetButton = button('scanner-reset');
    this.eodCard = document.getElementById('scanner-eod-card') as HTMLDivElement;
    this.eodBadge = document.getElementById('scanner-eod-badge') as HTMLSpanElement;
    this.eodSummary = document.getElementById('scanner-eod-summary') as HTMLSpanElement;
    this.eodTradeDate = document.getElementById('scanner-eod-date') as HTMLElement;
    this.eodActiveSymbols = document.getElementById('scanner-eod-active') as HTMLElement;
    this.eodRetention = document.getElementById('scanner-eod-retention') as HTMLElement;
    this.eodUpdateButton = button('scanner-eod-update');

    this.applyStoredState();

    this.overlay.querySelector('.scanner-close')?.addEventListener('click', () => this.hide());
    this.overlay.addEventListener('pointerdown', (event) => {
      if (event.target === this.overlay) this.hide();
    });
    this.source.addEventListener('change', () => {
      this.renderSourceControls();
      this.persistState();
    });
    input('scanner-breakout-enabled').addEventListener('change', () => {
      if (input('scanner-breakout-enabled').checked) {
        const eod = this.sources.find((item) => item.id === EOD_SOURCE && item.available);
        if (eod) this.source.value = EOD_SOURCE;
      }
      this.renderSourceControls();
      this.persistState();
    });
    this.scanButton.addEventListener('click', () => void this.scan());
    this.resetButton.addEventListener('click', () => this.resetFilters());
    this.eodUpdateButton.addEventListener('click', () => void this.updateEod());
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.overlay.hidden) this.hide();
    });
    void this.loadSources();
  }

  show(): void {
    this.overlay.hidden = false;
    if (this.source.value === EOD_SOURCE) void this.refreshEodStatus();
  }

  hide(): void {
    if (this.running || this.eodUpdating) return;
    this.overlay.hidden = true;
  }

  private breakoutEnabled(): boolean {
    return input('scanner-breakout-enabled').checked;
  }

  private applyStoredState(): void {
    input('scanner-price-min').value = this.stored.priceMin ?? '';
    input('scanner-price-max').value = this.stored.priceMax ?? '';
    input('scanner-volume-min').value = this.stored.volumeMin ?? '';
    input('scanner-volume-max').value = this.stored.volumeMax ?? '';
    input('scanner-mc-min').value = this.stored.marketCapMin ?? '';
    input('scanner-mc-max').value = this.stored.marketCapMax ?? '';
    input('scanner-ha-change').value = this.stored.closeChangePctMin ?? DEFAULT_STATE.closeChangePctMin;
    input('scanner-green').checked = this.stored.green ?? DEFAULT_STATE.green;
    input('scanner-no-lower').checked = this.stored.noLowerWick ?? DEFAULT_STATE.noLowerWick;
    this.setRadio('scanner-ha-timeframe', this.stored.timeframe ?? DEFAULT_STATE.timeframe);
    this.setRadio('scanner-candle-kind', this.stored.candle ?? DEFAULT_STATE.candle);
    input('scanner-breakout-enabled').checked = this.stored.breakoutEnabled ?? false;
    input('scanner-breakout-value').value = this.stored.breakoutMinMedianTradedValueBn ?? BREAKOUT_DEFAULTS.minMedianTradedValueBn;
    input('scanner-breakout-volume').value = this.stored.breakoutMinMedianVolume ?? BREAKOUT_DEFAULTS.minMedianVolume;
    input('scanner-breakout-change').value = this.stored.breakoutMinWeeklyChangePct ?? BREAKOUT_DEFAULTS.minWeeklyChangePct;
    input('scanner-breakout-rvol').value = this.stored.breakoutMinRvol ?? BREAKOUT_DEFAULTS.minRvol;
    input('scanner-breakout-strong').value = this.stored.breakoutStrongRvol ?? BREAKOUT_DEFAULTS.strongRvol;
  }

  private setRadio(name: string, value: string): void {
    const radio = this.overlay.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
    if (radio) radio.checked = true;
  }

  private selectedRadio(name: string): string {
    return this.overlay.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? '';
  }

  private async loadSources(): Promise<void> {
    try {
      this.sources = await getScannerSources();
      this.source.replaceChildren();
      for (const item of this.sources) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.available ? item.label : `${item.label} — unavailable`;
        option.disabled = !item.available;
        this.source.appendChild(option);
      }
      const preferred = this.breakoutEnabled()
        ? EOD_SOURCE
        : this.stored.source ?? this.bridgeProvider();
      const available = this.sources.find((item) => item.id === preferred && item.available)
        ?? this.sources.find((item) => item.available);
      if (available) this.source.value = available.id;
      this.renderSourceControls();
    } catch (error) {
      this.progress.innerHTML = `<span class="scanner-error">Scanner offline: ${this.escapeHtml(error instanceof Error ? error.message : String(error))}</span>`;
    }
  }

  private bridgeProvider(): ScannerSourceId | undefined {
    const value = window.__L2CHART_SCANNER_BRIDGE__?.getProvider();
    if (value === 'fiinquant') return 'fiinquant';
    if (value === 'binance-spot') return 'binance_spot';
    if (value === 'binance-usdm') return 'binance_usdm';
    return undefined;
  }

  private currentSource(): ScannerSource | undefined {
    return this.sources.find((item) => item.id === this.source.value);
  }

  private renderSourceControls(): void {
    let source = this.currentSource();
    const breakout = this.breakoutEnabled();
    if (breakout && source?.id !== EOD_SOURCE) {
      const eod = this.sources.find((item) => item.id === EOD_SOURCE && item.available);
      if (eod) {
        this.source.value = EOD_SOURCE;
        source = eod;
      }
    }
    this.source.disabled = breakout;
    this.universe.replaceChildren();
    if (!source) return;

    const saved = this.stored.source === source.id
      ? new Set(this.stored.universes ?? [])
      : new Set(source.default_universes);
    for (const universe of source.universes) {
      const label = document.createElement('label');
      label.className = 'scanner-chip';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = universe;
      checkbox.checked = breakout ? universe === 'HOSE' : saved.has(universe) || saved.size === 0;
      checkbox.disabled = breakout;
      const span = document.createElement('span');
      span.textContent = universe;
      label.append(checkbox, span);
      this.universe.appendChild(label);
    }

    this.marketCapGroup.hidden = !source.market_cap || breakout;
    for (const id of ['scanner-mc-min', 'scanner-mc-max']) {
      const element = input(id);
      element.disabled = !source.market_cap || breakout;
      if (!source.market_cap) element.value = '';
    }

    const local = source.refresh_mode === 'preloaded';
    this.sourceHint.textContent = breakout
      ? 'Scanner 04 · HOSE · closed week · CafeF local'
      : local ? 'SQLite local · không gọi mạng khi scan' : 'Cache + provider refresh';
    this.eodCard.hidden = source.id !== EOD_SOURCE;
    if (source.id === EOD_SOURCE) void this.refreshEodStatus();
    this.renderResults([]);
    this.renderIdleProgress();
  }

  private request(): ScannerRequest {
    const source = this.currentSource();
    if (!source) throw new Error('No scanner source selected.');
    const breakout = this.breakoutEnabled();
    const selectedUniverses = [...this.universe.querySelectorAll<HTMLInputElement>('input:checked')].map((item) => item.value);
    const universes = breakout ? ['HOSE'] : selectedUniverses;
    if (!universes.length) throw new Error('Chọn ít nhất một thị trường.');
    if (breakout && source.id !== EOD_SOURCE) throw new Error('Scanner 04 chỉ dùng VN EOD (CafeF).');

    const timeframe = this.selectedRadio('scanner-ha-timeframe');
    if (timeframe !== '1w' && timeframe !== '1M') throw new Error('Chọn Week hoặc Month.');
    const candle = this.selectedRadio('scanner-candle-kind');
    if (candle !== 'current' && candle !== 'closed') throw new Error('Chọn nến hiện tại hoặc đã đóng.');

    const minMedianTradedValueBn = requiredNumber('scanner-breakout-value', 'Median GTGD 8W');
    const minMedianVolume = requiredNumber('scanner-breakout-volume', 'Median KL 8W');
    const minWeeklyChangePct = requiredNumber('scanner-breakout-change', 'Tăng tuần');
    const minRvol = requiredNumber('scanner-breakout-rvol', 'RVOL tối thiểu');
    const strongRvol = requiredNumber('scanner-breakout-strong', 'RVOL mạnh');
    if (strongRvol < minRvol) throw new Error('RVOL mạnh phải lớn hơn hoặc bằng RVOL tối thiểu.');

    const request: ScannerRequest = {
      source: source.id,
      universes,
      filters: {
        priceMin: breakout ? null : numberOrNull(input('scanner-price-min').value),
        priceMax: breakout ? null : numberOrNull(input('scanner-price-max').value),
        volumeMin: breakout ? null : numberOrNull(input('scanner-volume-min').value),
        volumeMax: breakout ? null : numberOrNull(input('scanner-volume-max').value),
        marketCapMin: !breakout && source.market_cap ? numberOrNull(input('scanner-mc-min').value) : null,
        marketCapMax: !breakout && source.market_cap ? numberOrNull(input('scanner-mc-max').value) : null,
      },
      heikinAshi: {
        timeframe: breakout ? '1w' : timeframe,
        green: breakout ? false : input('scanner-green').checked,
        noLowerWick: breakout ? false : input('scanner-no-lower').checked,
        closeChangePctMin: breakout ? null : numberOrNull(input('scanner-ha-change').value),
        candle: breakout ? 'closed' : candle,
      },
      breakoutVolume: {
        enabled: breakout,
        minMedianTradedValue: minMedianTradedValueBn * 1_000_000_000,
        minMedianVolume,
        minWeeklyChangePct,
        minRvol,
        strongRvol,
      },
    };

    this.persistState(request);
    return request;
  }

  private persistState(request?: ScannerRequest): void {
    const source = this.currentSource();
    const timeframe = this.selectedRadio('scanner-ha-timeframe') as ScannerTimeframe;
    const candle = this.selectedRadio('scanner-candle-kind') as ScannerCandleKind;
    const universes = [...this.universe.querySelectorAll<HTMLInputElement>('input:checked')].map((item) => item.value);
    const nextState: StoredState = {
      source: request?.source ?? source?.id,
      universes,
      priceMin: input('scanner-price-min').value,
      priceMax: input('scanner-price-max').value,
      volumeMin: input('scanner-volume-min').value,
      volumeMax: input('scanner-volume-max').value,
      marketCapMin: input('scanner-mc-min').value,
      marketCapMax: input('scanner-mc-max').value,
      timeframe,
      green: input('scanner-green').checked,
      noLowerWick: input('scanner-no-lower').checked,
      closeChangePctMin: input('scanner-ha-change').value,
      candle,
      breakoutEnabled: this.breakoutEnabled(),
      breakoutMinMedianTradedValueBn: input('scanner-breakout-value').value,
      breakoutMinMedianVolume: input('scanner-breakout-volume').value,
      breakoutMinWeeklyChangePct: input('scanner-breakout-change').value,
      breakoutMinRvol: input('scanner-breakout-rvol').value,
      breakoutStrongRvol: input('scanner-breakout-strong').value,
    };
    this.stored = nextState;
    saveStored(nextState);
  }

  private resetFilters(): void {
    input('scanner-price-min').value = '';
    input('scanner-price-max').value = '';
    input('scanner-volume-min').value = '';
    input('scanner-volume-max').value = '';
    input('scanner-mc-min').value = '';
    input('scanner-mc-max').value = '';
    input('scanner-ha-change').value = DEFAULT_STATE.closeChangePctMin;
    input('scanner-green').checked = DEFAULT_STATE.green;
    input('scanner-no-lower').checked = DEFAULT_STATE.noLowerWick;
    this.setRadio('scanner-ha-timeframe', DEFAULT_STATE.timeframe);
    this.setRadio('scanner-candle-kind', DEFAULT_STATE.candle);
    input('scanner-breakout-enabled').checked = false;
    input('scanner-breakout-value').value = BREAKOUT_DEFAULTS.minMedianTradedValueBn;
    input('scanner-breakout-volume').value = BREAKOUT_DEFAULTS.minMedianVolume;
    input('scanner-breakout-change').value = BREAKOUT_DEFAULTS.minWeeklyChangePct;
    input('scanner-breakout-rvol').value = BREAKOUT_DEFAULTS.minRvol;
    input('scanner-breakout-strong').value = BREAKOUT_DEFAULTS.strongRvol;
    this.source.disabled = false;
    for (const checkbox of this.universe.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      checkbox.disabled = false;
      checkbox.checked = true;
    }
    this.persistState();
    this.renderSourceControls();
    this.renderResults([]);
    this.renderIdleProgress();
  }

  private async scan(): Promise<void> {
    if (this.running || this.eodUpdating) return;
    this.running = true;
    this.scanButton.disabled = true;
    this.resetButton.disabled = true;
    this.eodUpdateButton.disabled = true;
    this.scanButton.classList.add('is-running');
    this.scanButton.querySelector('span')!.textContent = 'Đang quét…';
    try {
      const runId = await startScannerRun(this.request());
      const run = await waitForScannerRun(runId, (value) => this.renderProgress(value));
      if (run.status === 'error') throw new Error(run.error || 'Scanner failed.');
      this.renderResults(run.results);
    } catch (error) {
      this.renderError(error instanceof Error ? error.message : String(error));
    } finally {
      this.running = false;
      this.scanButton.disabled = false;
      this.resetButton.disabled = false;
      this.eodUpdateButton.disabled = false;
      this.scanButton.classList.remove('is-running');
      this.scanButton.querySelector('span')!.textContent = 'Quét thị trường';
    }
  }

  private async refreshEodStatus(): Promise<void> {
    if (this.source.value !== EOD_SOURCE) return;
    try {
      this.eodStatus = await getCafeFEodStatus();
      this.renderEodStatus();
    } catch (error) {
      this.eodStatus = null;
      this.eodBadge.textContent = 'Không đọc được';
      this.eodBadge.dataset.tone = 'error';
      this.eodSummary.textContent = error instanceof Error ? error.message : String(error);
      this.eodTradeDate.textContent = '—';
      this.eodActiveSymbols.textContent = '—';
      this.eodRetention.textContent = '1,000 phiên';
    }
  }

  private async updateEod(): Promise<void> {
    if (this.eodUpdating || this.running || this.source.value !== EOD_SOURCE) return;
    this.eodUpdating = true;
    this.eodUpdateButton.disabled = true;
    this.scanButton.disabled = true;
    this.resetButton.disabled = true;
    this.eodCard.classList.add('is-updating');
    this.eodBadge.textContent = 'Đang cập nhật';
    this.eodBadge.dataset.tone = 'working';
    this.eodSummary.textContent = 'Đang tìm gói CafeF EOD mới nhất, tải ZIP và upsert vào SQLite…';
    try {
      const response = await updateCafeFEod();
      this.eodStatus = response.status;
      this.renderEodStatus(`Đã cập nhật ${response.result.activeSymbols.toLocaleString('en-US')} mã · ${response.result.candles.toLocaleString('en-US')} nến được upsert.`);
      this.renderResults([]);
      this.renderIdleProgress('Dữ liệu EOD đã đổi. Bấm “Quét thị trường” để chạy lại với phiên mới nhất.');
    } catch (error) {
      this.eodBadge.textContent = 'Cập nhật lỗi';
      this.eodBadge.dataset.tone = 'error';
      this.eodSummary.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      this.eodUpdating = false;
      this.eodUpdateButton.disabled = false;
      this.scanButton.disabled = false;
      this.resetButton.disabled = false;
      this.eodCard.classList.remove('is-updating');
    }
  }

  private renderEodStatus(successMessage?: string): void {
    const status = this.eodStatus;
    if (!status) return;
    const tradeDate = status.latestTradeDate ?? status.latestImport?.trade_date ?? 0;
    const ageDays = tradeDate ? Math.max(0, (Date.now() / 1000 - tradeDate) / 86400) : Number.POSITIVE_INFINITY;
    const staleAfterDays = (this.currentSource()?.snapshot_ttl_seconds ?? EOD_STALE_DAYS * 86400) / 86400;
    const stale = ageDays > staleAfterDays;
    this.eodBadge.dataset.tone = status.updating ? 'working' : stale ? 'warning' : 'success';
    this.eodBadge.textContent = status.updating ? 'Đang cập nhật' : stale ? 'Cần cập nhật' : 'Sẵn sàng';
    this.eodTradeDate.textContent = tradeDate ? dateOnly(tradeDate) : 'Chưa import';
    this.eodActiveSymbols.textContent = status.activeSymbols.toLocaleString('en-US');
    this.eodRetention.textContent = `${status.retentionBars.toLocaleString('en-US')} phiên`;

    if (successMessage) {
      this.eodSummary.textContent = successMessage;
      return;
    }
    if (!status.latestImport) {
      this.eodSummary.textContent = 'Chưa có import CafeF thành công. Cập nhật EOD hoặc bootstrap Upto trước khi scan.';
      return;
    }
    const mode = status.latestImport.mode.toUpperCase();
    const finished = status.latestImport.finished_at ? timestamp(status.latestImport.finished_at) : '—';
    this.eodSummary.textContent = `${mode} gần nhất hoàn tất ${finished} · ${status.snapshotSymbols.toLocaleString('en-US')} snapshot local.`;
  }

  private renderIdleProgress(message?: string): void {
    this.progress.replaceChildren();
    const idle = document.createElement('span');
    idle.className = 'scanner-progress-idle';
    idle.textContent = message ?? (this.breakoutEnabled()
      ? 'Sẵn sàng quét Scanner 04. Chỉ dùng tuần đã đóng; median thanh khoản chạy trước breakout.'
      : 'Sẵn sàng quét. Stage 1 lọc rác trước, sau đó mới tính Heikin Ashi.');
    this.progress.appendChild(idle);
  }

  private renderProgress(run: ScannerRun): void {
    this.progress.replaceChildren();
    const local = this.currentSource()?.refresh_mode === 'preloaded';
    const breakout = this.breakoutEnabled();
    const stats: Array<[string, number, boolean]> = [
      ['Universe', run.universe_count ?? 0, (run.universe_count ?? 0) > 0],
      [breakout ? 'HOSE' : 'Stage 1', run.stage1_count ?? 0, (run.stage1_count ?? 0) > 0],
      [local ? 'Local history' : 'History', run.history_refresh_count ?? 0, local || (run.history_refresh_count ?? 0) > 0],
      [breakout ? 'Weekly' : 'HA', run.stage2_count ?? 0, (run.stage2_count ?? 0) > 0],
      ['Matched', run.result_count ?? 0, run.status === 'complete'],
    ];
    for (const [label, value, active] of stats) {
      const item = document.createElement('span');
      item.className = active ? 'scanner-progress-step is-active' : 'scanner-progress-step';
      const dot = document.createElement('i');
      const text = document.createElement('b');
      text.textContent = label;
      const number = document.createElement('strong');
      number.textContent = String(value);
      item.append(dot, text, number);
      this.progress.appendChild(item);
    }
    if (run.warnings?.length) {
      const warning = document.createElement('span');
      warning.className = 'scanner-warning';
      warning.textContent = `⚠ ${run.warnings[0]}`;
      warning.title = run.warnings.join('\n');
      this.progress.appendChild(warning);
    }
  }

  private renderError(messageText: string): void {
    this.progress.replaceChildren();
    const message = document.createElement('span');
    message.className = 'scanner-error';
    message.textContent = messageText;
    this.progress.appendChild(message);
  }

  private renderResults(rows: ScannerResult[]): void {
    this.resultCount.textContent = rows.length.toLocaleString('en-US');
    this.results.replaceChildren();
    if (!rows.length) {
      this.resultHint.textContent = this.breakoutEnabled()
        ? 'Scanner 04 · chỉ closed week · sort theo RVOL W0 giảm dần.'
        : 'Đã xếp theo HA close Δ giảm dần · click một dòng để mở chart.';
      const empty = document.createElement('div');
      empty.className = 'scanner-empty';
      const strong = document.createElement('strong');
      strong.textContent = 'Chưa có kết quả';
      const span = document.createElement('span');
      span.textContent = 'Điều chỉnh bộ lọc và chạy scanner để xem danh sách phù hợp.';
      empty.append(strong, span);
      this.results.appendChild(empty);
      return;
    }

    if (rows[0].mode === 'breakout_volume') {
      this.renderBreakoutResults(rows.filter((row): row is BreakoutScannerResult => row.mode === 'breakout_volume'));
      return;
    }
    this.renderHeikinResults(rows.filter((row): row is HeikinScannerResult => row.mode === 'heikin_ashi'));
  }

  private renderBreakoutResults(rows: BreakoutScannerResult[]): void {
    this.resultHint.textContent = 'Scanner 04 · closed week only · sort RVOL W0 ↓ · click một dòng để mở chart.';
    const table = document.createElement('table');
    table.className = 'scanner-table';
    const columns = [
      'Mã', 'W0 close', '% tuần', 'RVOL W0', 'Breakout', 'GTGD W0',
      'Median GTGD 8W', 'Median KL 8W', 'Signal', 'W+1 RVOL', 'W+1 close',
      'Theo dõi', 'W0', 'Data',
    ];
    const thead = table.createTHead();
    const head = thead.insertRow();
    for (const column of columns) {
      const th = document.createElement('th');
      th.textContent = column;
      head.appendChild(th);
    }

    const tbody = table.createTBody();
    for (const result of rows) {
      const row = tbody.insertRow();
      row.dataset.symbol = result.symbol;
      this.symbolCell(row, result);
      this.textCell(row, price(result.price));
      this.textCell(row, percent(result.weeklyChangePct), 'scanner-positive');
      this.textCell(row, multiple(result.rvol), result.strong ? 'scanner-positive' : '');
      this.textCell(row, price(result.breakoutLevel));
      this.textCell(row, billionVnd(result.tradedValue));
      this.textCell(row, billionVnd(result.medianTradedValue));
      this.textCell(row, compact(result.medianVolume));

      const signalCell = row.insertCell();
      signalCell.className = 'scanner-signal-cell';
      const stateBadge = document.createElement('span');
      stateBadge.className = `scanner-mini-badge ${result.signalState === 'NEW' ? 'is-positive' : 'is-neutral'}`;
      stateBadge.textContent = result.signalState === 'NEW' ? 'NEW' : 'FOLLOW-UP';
      signalCell.appendChild(stateBadge);
      if (result.strong) {
        const strongBadge = document.createElement('span');
        strongBadge.className = 'scanner-mini-badge is-positive';
        strongBadge.textContent = 'STRONG';
        signalCell.appendChild(strongBadge);
      }

      this.textCell(row, multiple(result.nextWeekRvol));
      this.textCell(row, price(result.nextWeekClose));
      if (result.nextWeekHoldsBreakout === null) {
        this.textCell(row, 'Chờ W+1', 'scanner-null');
      } else if (result.nextWeekHoldsBreakout) {
        this.textCell(row, 'HOLD', 'scanner-positive');
      } else {
        this.textCell(row, 'FAILED', 'scanner-negative');
      }
      this.textCell(row, dateOnly(result.candleTime));
      this.textCell(row, result.stale ? 'Cũ' : 'Mới', result.stale ? 'scanner-stale' : 'scanner-fresh');
    }
    this.attachRowNavigation(tbody);
    this.results.appendChild(table);
  }

  private renderHeikinResults(rows: HeikinScannerResult[]): void {
    this.resultHint.textContent = 'Đã xếp theo HA close Δ giảm dần · click một dòng để mở chart.';
    const source = this.currentSource();
    const table = document.createElement('table');
    table.className = 'scanner-table';
    const columns = ['Mã', 'Giá', 'Khối lượng'];
    if (source?.market_cap) columns.push('Market cap');
    columns.push('HA close Δ', 'Body', 'Tín hiệu HA', 'Nến', 'Data');
    const thead = table.createTHead();
    const head = thead.insertRow();
    for (const column of columns) {
      const th = document.createElement('th');
      th.textContent = column;
      head.appendChild(th);
    }

    const tbody = table.createTBody();
    for (const result of rows) {
      const row = tbody.insertRow();
      row.dataset.symbol = result.symbol;
      this.symbolCell(row, result);
      this.textCell(row, price(result.price));
      this.textCell(row, compact(result.volume));
      if (source?.market_cap) this.textCell(row, compact(result.marketCap), result.marketCap === null ? 'scanner-null' : '');
      this.textCell(row, percent(result.haCloseChangePct), (result.haCloseChangePct ?? 0) >= 0 ? 'scanner-positive' : 'scanner-negative');
      this.textCell(row, percent(result.haBodyPct));

      const signalCell = row.insertCell();
      signalCell.className = 'scanner-signal-cell';
      const colorBadge = document.createElement('span');
      colorBadge.className = `scanner-mini-badge ${result.green ? 'is-positive' : 'is-negative'}`;
      colorBadge.textContent = result.green ? 'Xanh' : 'Đỏ';
      signalCell.appendChild(colorBadge);
      if (result.noLowerWick) {
        const wickBadge = document.createElement('span');
        wickBadge.className = 'scanner-mini-badge is-neutral';
        wickBadge.textContent = 'No wick';
        signalCell.appendChild(wickBadge);
      }

      this.textCell(row, dateOnly(result.candleTime));
      this.textCell(row, result.stale ? 'Cũ' : 'Mới', result.stale ? 'scanner-stale' : 'scanner-fresh');
    }
    this.attachRowNavigation(tbody);
    this.results.appendChild(table);
  }

  private symbolCell(row: HTMLTableRowElement, result: ScannerResult): void {
    const symbolCell = row.insertCell();
    symbolCell.className = 'scanner-symbol-cell';
    const symbol = document.createElement('strong');
    symbol.textContent = result.symbol;
    const meta = document.createElement('small');
    meta.textContent = result.exchange || (result.name && result.name !== result.symbol ? result.name : '—');
    symbolCell.append(symbol, meta);
  }

  private attachRowNavigation(tbody: HTMLTableSectionElement): void {
    tbody.addEventListener('click', (event) => {
      const row = (event.target as HTMLElement).closest<HTMLTableRowElement>('tr[data-symbol]');
      const symbol = row?.dataset.symbol;
      if (!symbol) return;
      window.__L2CHART_SCANNER_BRIDGE__?.openSymbol(symbol);
      this.hide();
    });
  }

  private textCell(row: HTMLTableRowElement, value: string, className = ''): HTMLTableCellElement {
    const cell = row.insertCell();
    cell.textContent = value;
    if (className) cell.className = className;
    return cell;
  }

  private escapeHtml(value: string): string {
    return value.replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[char] ?? char);
  }
}

function installScanner(): void {
  const panel = new ScannerPanel();
  const dock = document.getElementById('workspace-dock');
  if (!dock || document.getElementById('scanner-toggle')) return;
  const toggle = document.createElement('button');
  toggle.id = 'scanner-toggle';
  toggle.className = 'workspace-dock-button';
  toggle.type = 'button';
  toggle.dataset.label = 'Scanner';
  toggle.title = 'Mở scanner';
  toggle.setAttribute('aria-label', 'Mở scanner');
  toggle.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/><circle cx="7" cy="6" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="12" cy="18" r="1.5"/></svg>';
  toggle.addEventListener('click', () => panel.show());
  dock.appendChild(toggle);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', installScanner, { once: true });
} else {
  installScanner();
}
