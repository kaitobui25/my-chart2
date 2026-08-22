import './chart-log-recorder.css';

type LogScope = 'SESSION' | 'NET' | 'IDB' | 'JS' | 'ERR' | 'CONSOLE' | 'UI' | 'STATE';

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';

interface LogRecord {
  at: number;
  scope: LogScope;
  phase: string;
  id?: string;
  ms?: number;
  detail?: string;
}

interface ChartAssistantBridge {
  getContext(): unknown;
}

interface RecorderWindow extends Window {
  __L2CHART_ASSISTANT__?: ChartAssistantBridge;
  __L2CHART_LOG_RECORDER__?: {
    readonly active: boolean;
    start(): void;
    stop(): void;
  };
}

interface PerformanceWithMemory extends Performance {
  memory?: {
    usedJSHeapSize?: number;
    totalJSHeapSize?: number;
    jsHeapSizeLimit?: number;
  };
}

const MAX_RECORDS = 100_000;
const HEARTBEAT_MS = 5_000;
const LONG_TASK_MIN_MS = 120;
const BUTTON_SELECTOR = '#global-drawing-toolbar-host .drawing-toolbar';
const REDACTED_QUERY = /(token|key|secret|password|username|credential|authorization|auth)/i;

let sequence = 0;

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}${sequence}`;
}

function elapsed(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function chartLogFilename(date = new Date()): string {
  return `l2chart-log-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.txt`;
}

function safeText(value: unknown, maxLength = 4_000): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof Error) {
    const stack = value.stack ? `\n${value.stack}` : '';
    return `${value.name}: ${value.message}${stack}`.slice(0, maxLength);
  }
  if (typeof value === 'string') return value.slice(0, maxLength);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (typeof Element !== 'undefined' && value instanceof Element) return summarizeElement(value);
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return String(item);
      if (typeof Element !== 'undefined' && item instanceof Element) return summarizeElement(item);
      return item;
    }).slice(0, maxLength);
  } catch {
    return String(value).slice(0, maxLength);
  }
}

function summarizeUrl(input: RequestInfo | URL): string {
  try {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const url = new URL(raw, location.href);
    for (const key of [...url.searchParams.keys()]) {
      if (REDACTED_QUERY.test(key)) url.searchParams.set(key, '[redacted]');
    }
    return url.origin === location.origin
      ? `${url.pathname}${url.search}`
      : `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return '[unparseable-url]';
  }
}

function summarizeElement(element: Element): string {
  const parts = [element.tagName.toLowerCase()];
  if (element.id) parts.push(`#${element.id}`);
  const className = typeof element.className === 'string'
    ? element.className.split(/\s+/).filter(Boolean).slice(0, 4)
    : [];
  for (const name of className) parts.push(`.${name}`);
  const aria = element.getAttribute('aria-label');
  const title = element.getAttribute('title');
  const dataAction = element.getAttribute('data-action');
  const dataTool = element.getAttribute('data-tool');
  if (aria) parts.push(`aria=${JSON.stringify(aria.slice(0, 120))}`);
  else if (title) parts.push(`title=${JSON.stringify(title.slice(0, 120))}`);
  if (dataAction) parts.push(`action=${dataAction}`);
  if (dataTool) parts.push(`tool=${dataTool}`);
  return parts.join(' ');
}

function localClock(timestamp: number): string {
  const date = new Date(timestamp);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

export function formatChartLogRecord(record: LogRecord): string {
  const id = record.id ? ` ${record.id}` : '';
  const duration = Number.isFinite(record.ms) ? ` ${record.ms}ms` : '';
  const detail = record.detail ? ` · ${record.detail}` : '';
  return `${localClock(record.at)} [${record.scope}${id}] ${record.phase}${duration}${detail}`;
}

function readRuntimeState(): Record<string, unknown> {
  const bridge = (window as RecorderWindow).__L2CHART_ASSISTANT__;
  let activeChart: unknown = null;
  try {
    activeChart = bridge?.getContext() ?? null;
  } catch (error) {
    activeChart = { error: safeText(error, 500) };
  }

  const memory = (performance as PerformanceWithMemory).memory;
  return {
    activeChart,
    chartCount: document.querySelectorAll('#charts > *').length,
    source: document.getElementById('source-name')?.textContent?.trim() ?? null,
    sourceState: document.getElementById('source-state')?.textContent?.trim() ?? null,
    replay: document.getElementById('replay-status')?.textContent?.trim() ?? null,
    visibility: document.visibilityState,
    online: navigator.onLine,
    viewport: `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio}`,
    memory: memory ? {
      usedJSHeapSize: memory.usedJSHeapSize ?? null,
      totalJSHeapSize: memory.totalJSHeapSize ?? null,
      jsHeapSizeLimit: memory.jsHeapSizeLimit ?? null,
    } : null,
  };
}

class ChartLogRecorder {
  private records: LogRecord[] = [];
  private startedAt = 0;
  private activeState = false;
  private truncated = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private performanceObserver: PerformanceObserver | null = null;
  private button: HTMLButtonElement | null = null;
  private mutationObserver: MutationObserver | null = null;
  private restores: Array<() => void> = [];

  get active(): boolean {
    return this.activeState;
  }

  install(): void {
    this.attachButtonWhenReady();
    this.mutationObserver = new MutationObserver(() => this.attachButtonWhenReady());
    this.mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  start(): void {
    if (this.activeState) return;
    this.activeState = true;
    this.records = [];
    this.restores = [];
    this.truncated = false;
    this.startedAt = Date.now();
    sequence = 0;
    this.syncButton();

    this.record('SESSION', 'START', undefined, undefined, `url=${location.href}`);
    this.record('STATE', 'START', undefined, undefined, safeText(readRuntimeState(), 12_000));
    this.installConsoleCapture();
    this.installFetchCapture();
    this.installIndexedDbCapture();
    this.installErrorCapture();
    this.installUiCapture();
    this.installLongTaskCapture();
    this.installLifecycleCapture();
    this.heartbeatTimer = setInterval(() => {
      this.record('STATE', 'HEARTBEAT', undefined, undefined, safeText(readRuntimeState(), 8_000));
    }, HEARTBEAT_MS);
  }

  stop(): void {
    if (!this.activeState) return;

    const stoppedAt = Date.now();
    this.record('STATE', 'STOP', undefined, undefined, safeText(readRuntimeState(), 12_000));
    this.record(
      'SESSION',
      'STOP',
      undefined,
      stoppedAt - this.startedAt,
      `records=${this.records.length}${this.truncated ? ' truncated=true' : ''}`,
    );

    this.activeState = false;
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.performanceObserver?.disconnect();
    this.performanceObserver = null;
    for (const restore of this.restores.splice(0).reverse()) restore();
    this.syncButton();
    this.download(stoppedAt);
  }

  private record(scope: LogScope, phase: string, id?: string, ms?: number, detail?: string): void {
    if (!this.activeState && scope !== 'SESSION' && phase !== 'STOP') return;
    if (this.records.length >= MAX_RECORDS) {
      if (!this.truncated) {
        this.truncated = true;
        this.records.push({
          at: Date.now(),
          scope: 'SESSION',
          phase: 'LIMIT',
          detail: `maximum ${MAX_RECORDS} records reached; later events dropped`,
        });
      }
      return;
    }
    this.records.push({ at: Date.now(), scope, phase, id, ms, detail });
  }

  private attachButtonWhenReady(): void {
    const toolbar = document.querySelector<HTMLDivElement>(BUTTON_SELECTOR);
    if (!toolbar) return;
    const existing = toolbar.querySelector<HTMLButtonElement>('.chart-log-button');
    if (existing) {
      this.button = existing;
      this.syncButton();
      return;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'drawing-tool-button chart-log-button';
    button.setAttribute('aria-pressed', 'false');
    button.innerHTML = '<span class="chart-log-button-label">LOG</span><span class="chart-log-button-dot" aria-hidden="true"></span>';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.activeState) this.stop();
      else this.start();
    });

    const trash = toolbar.querySelector<HTMLButtonElement>('.drawing-tool-button.danger');
    if (trash) trash.insertAdjacentElement('afterend', button);
    else toolbar.appendChild(button);
    this.button = button;
    this.syncButton();
  }

  private syncButton(): void {
    if (!this.button) return;
    this.button.classList.toggle('is-recording', this.activeState);
    this.button.setAttribute('aria-pressed', String(this.activeState));
    this.button.setAttribute('aria-label', this.activeState ? 'Stop chart log and download' : 'Start chart log');
    this.button.title = this.activeState
      ? 'Log Stop · tải file TXT xuống Downloads'
      : 'Log Start · ghi log toàn chart';
    const label = this.button.querySelector<HTMLElement>('.chart-log-button-label');
    if (label) label.textContent = this.activeState ? 'STOP' : 'LOG';
  }

  private installConsoleCapture(): void {
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as ConsoleMethod[]) {
      const original = console[method].bind(console);
      const wrapped = (...args: unknown[]) => {
        this.record('CONSOLE', method.toUpperCase(), undefined, undefined, args.map((item) => safeText(item, 1_500)).join(' '));
        original(...args);
      };
      console[method] = wrapped as typeof console[typeof method];
      this.restores.push(() => {
        if (console[method] === wrapped) console[method] = original as typeof console[typeof method];
      });
    }
  }

  private installFetchCapture(): void {
    const original = window.fetch.bind(window);
    const wrapped: typeof window.fetch = async (input, init) => {
      const id = nextId('NET');
      const started = performance.now();
      const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const url = summarizeUrl(input);
      this.record('NET', 'START', id, undefined, `${method} ${url}`);
      try {
        const response = await original(input, init);
        this.record('NET', response.ok ? 'DONE' : 'HTTP', id, elapsed(started), `${method} ${url} status=${response.status}`);
        return response;
      } catch (error) {
        this.record('NET', 'FAIL', id, elapsed(started), `${method} ${url} · ${safeText(error, 1_000)}`);
        throw error;
      }
    };
    window.fetch = wrapped;
    this.restores.push(() => {
      if (window.fetch === wrapped) window.fetch = original;
    });
  }

  private installIndexedDbCapture(): void {
    if (typeof IDBObjectStore === 'undefined') return;
    const proto = IDBObjectStore.prototype as IDBObjectStore & Record<string, unknown>;
    const methods = ['get', 'getAll', 'getKey', 'getAllKeys', 'count', 'openCursor', 'put', 'add', 'delete', 'clear'] as const;

    for (const method of methods) {
      const original = proto[method];
      if (typeof original !== 'function') continue;
      const wrapped = function(this: IDBObjectStore, ...args: unknown[]) {
        const id = nextId('IDB');
        const started = performance.now();
        const key = args.length > 0 ? safeText(args[0], 160) : '';
        const detail = `${method} store=${this.name}${key ? ` key=${key}` : ''}`;
        recorder.record('IDB', 'START', id, undefined, detail);
        let request: IDBRequest<unknown>;
        try {
          request = (original as (...items: unknown[]) => IDBRequest<unknown>).apply(this, args);
        } catch (error) {
          recorder.record('IDB', 'FAIL', id, elapsed(started), `${detail} · ${safeText(error, 1_000)}`);
          throw error;
        }
        request.addEventListener('success', () => recorder.record('IDB', 'DONE', id, elapsed(started), detail), { once: true });
        request.addEventListener('error', () => recorder.record('IDB', 'FAIL', id, elapsed(started), `${detail} · ${safeText(request.error, 1_000)}`), { once: true });
        return request;
      };
      Object.defineProperty(proto, method, { configurable: true, writable: true, value: wrapped });
      this.restores.push(() => {
        if (proto[method] === wrapped) {
          Object.defineProperty(proto, method, { configurable: true, writable: true, value: original });
        }
      });
    }
  }

  private installErrorCapture(): void {
    const onError = (event: ErrorEvent) => {
      const location = event.filename ? ` · ${event.filename}:${event.lineno}:${event.colno}` : '';
      this.record('ERR', 'ERROR', undefined, undefined, `${event.message || 'window error'}${location}`);
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      this.record('ERR', 'REJECT', undefined, undefined, safeText(event.reason ?? 'Unhandled promise rejection', 4_000));
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    this.restores.push(() => window.removeEventListener('error', onError));
    this.restores.push(() => window.removeEventListener('unhandledrejection', onRejection));
  }

  private installUiCapture(): void {
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest('button,[role="button"],a,input,select') : null;
      if (!target) return;
      this.record('UI', 'CLICK', undefined, undefined, summarizeElement(target));
    };
    const onChange = (event: Event) => {
      if (!(event.target instanceof Element)) return;
      this.record('UI', 'CHANGE', undefined, undefined, summarizeElement(event.target));
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      const target = event.target.closest('canvas,.pane,.chart-tile') ?? event.target;
      this.record('UI', 'POINTER_DOWN', undefined, undefined, `${summarizeElement(target)} x=${Math.round(event.clientX)} y=${Math.round(event.clientY)} button=${event.button}`);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      const target = event.target.closest('canvas,.pane,.chart-tile') ?? event.target;
      this.record('UI', 'POINTER_UP', undefined, undefined, `${summarizeElement(target)} x=${Math.round(event.clientX)} y=${Math.round(event.clientY)} button=${event.button}`);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = [event.ctrlKey ? 'Ctrl' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '', event.metaKey ? 'Meta' : '']
        .filter(Boolean)
        .join('+');
      this.record('UI', 'KEY', undefined, undefined, `${modifier ? `${modifier}+` : ''}${event.key}`);
    };

    document.addEventListener('click', onClick, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('keydown', onKeyDown, true);
    this.restores.push(() => document.removeEventListener('click', onClick, true));
    this.restores.push(() => document.removeEventListener('change', onChange, true));
    this.restores.push(() => document.removeEventListener('pointerdown', onPointerDown, true));
    this.restores.push(() => document.removeEventListener('pointerup', onPointerUp, true));
    this.restores.push(() => document.removeEventListener('keydown', onKeyDown, true));
  }

  private installLongTaskCapture(): void {
    if (typeof PerformanceObserver === 'undefined') return;
    try {
      this.performanceObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration < LONG_TASK_MIN_MS) continue;
          this.record('JS', 'LONG', undefined, Math.round(entry.duration), `name=${entry.name || 'longtask'}`);
        }
      });
      this.performanceObserver.observe({ entryTypes: ['longtask'] });
    } catch {
      this.performanceObserver = null;
    }
  }

  private installLifecycleCapture(): void {
    const onVisibility = () => this.record('STATE', 'VISIBILITY', undefined, undefined, document.visibilityState);
    const onOnline = () => this.record('STATE', 'ONLINE');
    const onOffline = () => this.record('STATE', 'OFFLINE');
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisibility);
    this.restores.push(() => window.removeEventListener('online', onOnline));
    this.restores.push(() => window.removeEventListener('offline', onOffline));
    this.restores.push(() => document.removeEventListener('visibilitychange', onVisibility));
  }

  private download(stoppedAt: number): void {
    const header = [
      'L2Chart chart log',
      `Started: ${new Date(this.startedAt).toISOString()}`,
      `Stopped: ${new Date(stoppedAt).toISOString()}`,
      `Duration: ${Math.max(0, stoppedAt - this.startedAt)} ms`,
      `User agent: ${navigator.userAgent}`,
      `Records: ${this.records.length}`,
      '',
    ];
    const content = `${header.join('\n')}${this.records.map(formatChartLogRecord).join('\n')}\n`;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = chartLogFilename(new Date(stoppedAt));
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

const recorder = new ChartLogRecorder();

if (typeof document !== 'undefined') {
  recorder.install();
  (window as RecorderWindow).__L2CHART_LOG_RECORDER__ = Object.freeze({
    get active() {
      return recorder.active;
    },
    start: () => recorder.start(),
    stop: () => recorder.stop(),
  });
}
