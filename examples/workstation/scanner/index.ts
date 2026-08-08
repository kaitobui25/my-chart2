import './style.css';
import { getScannerSources, startScannerRun, waitForScannerRun } from './api';
import type {
  ScannerCandleKind,
  ScannerRequest,
  ScannerResult,
  ScannerRun,
  ScannerSource,
  ScannerSourceId,
  ScannerTimeframe,
} from './types';

const STORAGE_KEY = 'l2chart.scanner.filters.v1';

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

function compact(value: number | null): string {
  if (value === null) return '—';
  return new Intl.NumberFormat('en-US', {
    notation: Math.abs(value) >= 1_000_000 ? 'compact' : 'standard',
    maximumFractionDigits: 2,
  }).format(value);
}

function price(value: number | null): string {
  if (value === null) return '—';
  const digits = Math.abs(value) < 1 ? 6 : Math.abs(value) < 100 ? 3 : 2;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value);
}

function percent(value: number | null): string {
  if (value === null) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function timestamp(value: number): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' })
    .format(new Date(value * 1000));
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

class ScannerPanel {
  private readonly stored = readStored();
  private sources: ScannerSource[] = [];
  private running = false;
  private readonly overlay: HTMLDivElement;
  private readonly source: HTMLSelectElement;
  private readonly universe: HTMLDivElement;
  private readonly progress: HTMLDivElement;
  private readonly results: HTMLDivElement;
  private readonly scanButton: HTMLButtonElement;

  constructor() {
    this.overlay = document.createElement('div');
    this.overlay.id = 'scanner-overlay';
    this.overlay.hidden = true;
    this.overlay.innerHTML = `
      <section id="scanner-panel" role="dialog" aria-modal="true" aria-label="Market scanner">
        <header class="scanner-head">
          <h2>Scanner</h2><small>Price / Volume / Market Cap / Heikin Ashi</small>
          <span class="spacer"></span><button class="scanner-close" type="button" aria-label="Đóng">×</button>
        </header>
        <div class="scanner-filter-shell"><div class="scanner-filter-bar">
          <label class="scanner-field"><span>Source</span><select id="scanner-source"></select></label>
          <label class="scanner-field"><span>Universe</span><div id="scanner-universe" class="scanner-universes"></div></label>
          <label class="scanner-field"><span>Price min</span><input id="scanner-price-min" type="number" min="0" step="any" placeholder="Any"></label>
          <label class="scanner-field"><span>Price max</span><input id="scanner-price-max" type="number" min="0" step="any" placeholder="Any"></label>
          <label class="scanner-field"><span>Volume min</span><input id="scanner-volume-min" type="number" min="0" step="any" placeholder="Any"></label>
          <label class="scanner-field"><span>Volume max</span><input id="scanner-volume-max" type="number" min="0" step="any" placeholder="Any"></label>
          <label class="scanner-field"><span>Market cap min</span><input id="scanner-mc-min" type="number" min="0" step="any" placeholder="N/A"></label>
          <label class="scanner-field"><span>Market cap max</span><input id="scanner-mc-max" type="number" min="0" step="any" placeholder="N/A"></label>
          <label class="scanner-field"><span>HA timeframe</span><div class="scanner-timeframe">
            <label><input type="radio" name="scanner-ha-timeframe" value="1w"> Week</label>
            <label><input type="radio" name="scanner-ha-timeframe" value="1M"> Month</label>
          </div></label>
          <label class="scanner-field"><span>Candle</span><div class="scanner-candle">
            <label><input type="radio" name="scanner-candle-kind" value="current"> Current</label>
            <label><input type="radio" name="scanner-candle-kind" value="closed"> Closed</label>
          </div></label>
          <label class="scanner-field"><span>HA close Δ min %</span><input id="scanner-ha-change" type="number" step="any" value="0"></label>
          <label class="scanner-check"><input id="scanner-green" type="checkbox"> Green</label>
          <label class="scanner-check"><input id="scanner-no-lower" type="checkbox"> No lower wick</label>
          <button id="scanner-run" class="scanner-run-button" type="button">SCAN</button>
        </div></div>
        <div class="scanner-body">
          <div id="scanner-progress" class="scanner-progress"><span>Ready</span></div>
          <div id="scanner-results" class="scanner-table-wrap"><div class="scanner-empty">Chọn bộ lọc rồi bấm SCAN.</div></div>
        </div>
      </section>`;
    document.body.appendChild(this.overlay);

    this.source = select('scanner-source');
    this.universe = document.getElementById('scanner-universe') as HTMLDivElement;
    this.progress = document.getElementById('scanner-progress') as HTMLDivElement;
    this.results = document.getElementById('scanner-results') as HTMLDivElement;
    this.scanButton = document.getElementById('scanner-run') as HTMLButtonElement;

    input('scanner-price-min').value = this.stored.priceMin ?? '';
    input('scanner-price-max').value = this.stored.priceMax ?? '';
    input('scanner-volume-min').value = this.stored.volumeMin ?? '';
    input('scanner-volume-max').value = this.stored.volumeMax ?? '';
    input('scanner-mc-min').value = this.stored.marketCapMin ?? '';
    input('scanner-mc-max').value = this.stored.marketCapMax ?? '';
    input('scanner-ha-change').value = this.stored.closeChangePctMin ?? '0';
    input('scanner-green').checked = this.stored.green ?? true;
    input('scanner-no-lower').checked = this.stored.noLowerWick ?? true;
    this.setRadio('scanner-ha-timeframe', this.stored.timeframe ?? '1M');
    this.setRadio('scanner-candle-kind', this.stored.candle ?? 'current');

    this.overlay.querySelector('.scanner-close')?.addEventListener('click', () => this.hide());
    this.overlay.addEventListener('pointerdown', (event) => {
      if (event.target === this.overlay) this.hide();
    });
    this.source.addEventListener('change', () => this.renderUniverse());
    this.scanButton.addEventListener('click', () => void this.scan());
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.overlay.hidden) this.hide();
    });
    void this.loadSources();
  }

  show(): void {
    this.syncSourceToChart();
    this.overlay.hidden = false;
  }

  hide(): void {
    this.overlay.hidden = true;
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
      const preferred = this.stored.source ?? this.bridgeProvider();
      const available = this.sources.find((item) => item.id === preferred && item.available)
        ?? this.sources.find((item) => item.available);
      if (available) this.source.value = available.id;
      this.renderUniverse();
    } catch (error) {
      this.progress.textContent = `Scanner offline: ${error instanceof Error ? error.message : String(error)}`;
      this.progress.classList.add('scanner-error');
    }
  }

  private bridgeProvider(): ScannerSourceId | undefined {
    const value = window.__L2CHART_SCANNER_BRIDGE__?.getProvider();
    if (value === 'fiinquant') return 'fiinquant';
    if (value === 'binance-spot') return 'binance_spot';
    if (value === 'binance-usdm') return 'binance_usdm';
    return undefined;
  }

  private syncSourceToChart(): void {
    const provider = this.bridgeProvider();
    if (provider && this.sources.some((item) => item.id === provider && item.available)) {
      this.source.value = provider;
      this.renderUniverse();
    }
  }

  private currentSource(): ScannerSource | undefined {
    return this.sources.find((item) => item.id === this.source.value);
  }

  private renderUniverse(): void {
    const source = this.currentSource();
    this.universe.replaceChildren();
    if (!source) return;
    const saved = this.stored.source === source.id ? new Set(this.stored.universes ?? []) : new Set(source.default_universes);
    for (const universe of source.universes) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = universe;
      checkbox.checked = saved.has(universe) || saved.size === 0;
      label.append(checkbox, document.createTextNode(universe));
      this.universe.appendChild(label);
    }
    for (const id of ['scanner-mc-min', 'scanner-mc-max']) {
      const element = input(id);
      element.disabled = !source.market_cap;
      element.placeholder = source.market_cap ? 'Any' : 'NULL / unsupported';
      if (!source.market_cap) element.value = '';
    }
  }

  private request(): ScannerRequest {
    const source = this.currentSource();
    if (!source) throw new Error('No scanner source selected.');
    const universes = [...this.universe.querySelectorAll<HTMLInputElement>('input:checked')].map((item) => item.value);
    const timeframe = this.selectedRadio('scanner-ha-timeframe');
    if (timeframe !== '1w' && timeframe !== '1M') throw new Error('Choose Week or Month.');
    const candle = this.selectedRadio('scanner-candle-kind');
    if (candle !== 'current' && candle !== 'closed') throw new Error('Choose Current or Closed candle.');

    const request: ScannerRequest = {
      source: source.id,
      universes,
      filters: {
        priceMin: numberOrNull(input('scanner-price-min').value),
        priceMax: numberOrNull(input('scanner-price-max').value),
        volumeMin: numberOrNull(input('scanner-volume-min').value),
        volumeMax: numberOrNull(input('scanner-volume-max').value),
        marketCapMin: source.market_cap ? numberOrNull(input('scanner-mc-min').value) : null,
        marketCapMax: source.market_cap ? numberOrNull(input('scanner-mc-max').value) : null,
      },
      heikinAshi: {
        timeframe,
        green: input('scanner-green').checked,
        noLowerWick: input('scanner-no-lower').checked,
        closeChangePctMin: numberOrNull(input('scanner-ha-change').value),
        candle,
      },
    };

    saveStored({
      source: request.source,
      universes,
      priceMin: input('scanner-price-min').value,
      priceMax: input('scanner-price-max').value,
      volumeMin: input('scanner-volume-min').value,
      volumeMax: input('scanner-volume-max').value,
      marketCapMin: input('scanner-mc-min').value,
      marketCapMax: input('scanner-mc-max').value,
      timeframe,
      green: request.heikinAshi.green,
      noLowerWick: request.heikinAshi.noLowerWick,
      closeChangePctMin: input('scanner-ha-change').value,
      candle,
    });
    return request;
  }

  private async scan(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.scanButton.disabled = true;
    this.scanButton.textContent = 'SCANNING…';
    try {
      const runId = await startScannerRun(this.request());
      const run = await waitForScannerRun(runId, (value) => this.renderProgress(value));
      if (run.status === 'error') throw new Error(run.error || 'Scanner failed.');
      this.renderResults(run.results);
    } catch (error) {
      this.progress.replaceChildren();
      const message = document.createElement('span');
      message.className = 'scanner-error';
      message.textContent = error instanceof Error ? error.message : String(error);
      this.progress.appendChild(message);
    } finally {
      this.running = false;
      this.scanButton.disabled = false;
      this.scanButton.textContent = 'SCAN';
    }
  }

  private renderProgress(run: ScannerRun): void {
    this.progress.replaceChildren();
    const stats: Array<[string, number]> = [
      ['Universe', run.universe_count ?? 0],
      ['Stage 1', run.stage1_count ?? 0],
      ['History refresh', run.history_refresh_count ?? 0],
      ['HA', run.stage2_count ?? 0],
      ['Matched', run.result_count ?? 0],
    ];
    for (const [label, value] of stats) {
      const item = document.createElement('span');
      item.append(document.createTextNode(`${label} `));
      const strong = document.createElement('strong');
      strong.textContent = String(value);
      item.appendChild(strong);
      this.progress.appendChild(item);
    }
    if (run.warnings?.length) {
      const warning = document.createElement('span');
      warning.className = 'scanner-warning';
      warning.textContent = run.warnings[0];
      warning.title = run.warnings.join('\n');
      this.progress.appendChild(warning);
    }
  }

  private renderResults(rows: ScannerResult[]): void {
    this.results.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'scanner-empty';
      empty.textContent = 'Không có mã nào thỏa bộ lọc.';
      this.results.appendChild(empty);
      return;
    }
    const table = document.createElement('table');
    table.className = 'scanner-table';
    const columns = ['Symbol', 'Exchange', 'Price', 'Volume', 'Market Cap', 'HA', 'Color', 'No lower wick', 'HA close Δ', 'Body', 'Candle', 'Data'];
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
      const values = [
        result.symbol,
        result.exchange || result.name || '',
        price(result.price),
        compact(result.volume),
        compact(result.marketCap),
        result.timeframe,
        result.green ? 'Green' : 'Red',
        result.noLowerWick ? 'Yes' : 'No',
        percent(result.haCloseChangePct),
        percent(result.haBodyPct),
        timestamp(result.candleTime),
        result.stale ? 'Stale' : 'Fresh',
      ];
      values.forEach((value, index) => {
        const cell = row.insertCell();
        cell.textContent = value;
        if (index === 0) cell.className = 'scanner-symbol';
        if (index === 4 && result.marketCap === null) cell.classList.add('scanner-null');
        if ((index === 6 && result.green) || (index === 8 && (result.haCloseChangePct ?? 0) >= 0)) cell.classList.add('scanner-positive');
        if (index === 11 && result.stale) cell.classList.add('scanner-stale');
      });
    }
    tbody.addEventListener('click', (event) => {
      const row = (event.target as HTMLElement).closest<HTMLTableRowElement>('tr[data-symbol]');
      const symbol = row?.dataset.symbol;
      if (!symbol) return;
      window.__L2CHART_SCANNER_BRIDGE__?.openSymbol(symbol);
      this.hide();
    });
    this.results.appendChild(table);
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
