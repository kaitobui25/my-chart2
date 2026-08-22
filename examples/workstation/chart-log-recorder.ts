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

interface LogRecorderBridge {
  readonly active: boolean;
  start(): void;
  stop(): void;
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
const TOOLBAR_SELECTOR = '#global-drawing-toolbar-host .drawing-toolbar';
const SENSITIVE_KEY = /(token|api.?key|key|secret|password|username|credential|authorization|auth)/i;
const SENSITIVE_INLINE = /((?:token|api[ _-]?key|secret|password|username|credential|authorization|auth)\s*[=:]\s*)([^\s,;]+)/gi;
let sequence = 0;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}${sequence}`;
}

function elapsed(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function redactText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(SENSITIVE_INLINE, '$1[redacted]');
}

export function chartLogFilename(date = new Date()): string {
  return `l2chart-log-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.txt`;
}

function summarizeElement(element: Element): string {
  const parts = [element.tagName.toLowerCase()];
  if (element.id) parts.push(`#${element.id}`);
  if (typeof element.className === 'string') {
    for (const name of element.className.split(/\s+/).filter(Boolean).slice(0, 4)) parts.push(`.${name}`);
  }
  const aria = element.getAttribute('aria-label');
  const title = element.getAttribute('title');
  const action = element.getAttribute('data-action');
  const tool = element.getAttribute('data-tool');
  if (aria) parts.push(`aria=${JSON.stringify(aria.slice(0, 120))}`);
  else if (title) parts.push(`title=${JSON.stringify(title.slice(0, 120))}`);
  if (action) parts.push(`action=${action}`);
  if (tool) parts.push(`tool=${tool}`);
  return parts.join(' ');
}

function safeText(value: unknown, maxLength = 4_000): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof Error) {
    const stack = value.stack ? `\n${value.stack}` : '';
    return redactText(`${value.name}: ${value.message}${stack}`).slice(0, maxLength);
  }
  if (typeof value === 'string') return redactText(value).slice(0, maxLength);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (typeof Element !== 'undefined' && value instanceof Element) return summarizeElement(value);
  try {
    return redactText(JSON.stringify(value, (key, item) => {
      if (SENSITIVE_KEY.test(key)) return '[redacted]';
      if (typeof item === 'bigint') return String(item);
      if (typeof Element !== 'undefined' && item instanceof Element) return summarizeElement(item);
      return item;
    })).slice(0, maxLength);
  } catch {
    return redactText(String(value)).slice(0, maxLength);
  }
}

function summarizeUrl(input: RequestInfo | URL): string {
  try {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const url = new URL(raw, location.href);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, '[redacted]');
    }
    const value = url.origin === location.origin
      ? `${url.pathname}${url.search}`
      : `${url.origin}${url.pathname}${url.search}`;
    return redactText(value);
  } catch {
    return '[unparseable-url]';
  }
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

function activeChartContext(): unknown {
  const bridge = (window as unknown as {
    __L2CHART_ASSISTANT__?: { getContext(): unknown };
  }).__L2CHART_ASSISTANT__;
  try {
    return bridge?.getContext() ?? null;
  } catch (error) {
    return { error: safeText(error, 500) };
  }
}

function runtimeState(): Record<string, unknown> {
  const memory = (performance as PerformanceWithMemory).memory;
  return {
    activeChart: activeChartContext(),
    chartCount: document.querySelectorAll('#charts > *').length,
    source: document.getElementById('source-name')?.textContent?.trim() ?? null,
    sourceState: document.getElementById('source-state')?.textContent?.trim() ?? null,
    replay: document.getElementById('replay-status')?.textContent?.trim() ?? null,
    visibility: document.visibilityState,
    online: navigator.onLine,
    viewport: `${innerWidth}x${innerHeight}@${devicePixelRatio}`,
    memory: memory ? {
      usedJSHeapSize: memory.usedJSHeapSize ?? null,
      totalJSHeapSize: memory.totalJSHeapSize ?? null,
      jsHeapSizeLimit: memory.jsHeapSizeLimit ?? null,
    } : null,
  };
}

class ChartLogRecorder {
  private records: LogRecord[] = [];
  private restores: Array<() => void> = [];
  private startedAt = 0;
  private activeState = false;
  private truncated = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private performanceObserver: PerformanceObserver | null = null;
  private button: HTMLButtonElement | null = null;

  get active(): boolean {
    return this.activeState;
  }

  install(): void {
    this.attachButton();
    new MutationObserver(() => this.attachButton()).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  start(): void {
    if (this.activeState) return;
    this.records = [];
    this.restores = [];
    this.startedAt = Date.now();
    this.truncated = false;
    this.activeState = true;
    sequence = 0;
    this.syncButton();

    this.record('SESSION', 'START', undefined, undefined, `url=${summarizeUrl(location.href)}`);
    this.record('STATE', 'START', undefined, undefined, safeText(runtimeState(), 12_000));
    this.captureConsole();
    this.captureFetch();
    this.captureIndexedDb();
    this.captureErrors();
    this.captureUi();
    this.captureLongTasks();
    this.captureLifecycle();
    this.heartbeatTimer = setInterval(() => {
      this.record('STATE', 'HEARTBEAT', undefined, undefined, safeText(runtimeState(), 8_000));
    }, HEARTBEAT_MS);
  }

  stop(): void {
    if (!this.activeState) return;
    const stoppedAt = Date.now();
    this.record('STATE', 'STOP', undefined, undefined, safeText(runtimeState(), 12_000));
    this.record('SESSION', 'STOP', undefined, stoppedAt - this.startedAt, `records=${this.records.length}${this.truncated ? ' truncated=true' : ''}`);

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
    if (!this.activeState) return;
    if (this.records.length >= MAX_RECORDS) {
      if (!this.truncated) {
        this.truncated = true;
        this.records.push({ at: Date.now(), scope: 'SESSION', phase: 'LIMIT', detail: `maximum ${MAX_RECORDS} records reached; later events dropped` });
      }
      return;
    }
    this.records.push({ at: Date.now(), scope, phase, id, ms, detail });
  }

  private attachButton(): void {
    const toolbar = document.querySelector<HTMLDivElement>(TOOLBAR_SELECTOR);
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
    this.button.title = this.activeState ? 'Log Stop · tải file TXT xuống Downloads' : 'Log Start · ghi log toàn chart';
    const label = this.button.querySelector<HTMLElement>('.chart-log-button-label');
    if (label) label.textContent = this.activeState ? 'STOP' : 'LOG';
  }

  private captureConsole(): void {
    const target = console as unknown as Record<ConsoleMethod, (...args: unknown[]) => void>;
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as ConsoleMethod[]) {
      const original = target[method].bind(console);
      const wrapped = (...args: unknown[]) => {
        this.record('CONSOLE', method.toUpperCase(), undefined, undefined, args.map((item) => safeText(item, 1_500)).join(' '));
        original(...args);
      };
      target[method] = wrapped;
      this.restores.push(() => {
        if (target[method] === wrapped) target[method] = original;
      });
    }
  }

  private captureFetch(): void {
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

  private captureIndexedDb(): void {
    if (typeof IDBObjectStore === 'undefined') return;
    const proto = IDBObjectStore.prototype as IDBObjectStore & Record<string, unknown>;
    const methods = ['get', 'getAll', 'getKey', 'getAllKeys', 'count', 'openCursor', 'put', 'add', 'delete', 'clear'] as const;

    for (const method of methods) {
      const original = proto[method];
      if (typeof original !== 'function') continue;
      const recorder = this;
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
        if (proto[method] === wrapped) Object.defineProperty(proto, method, { configurable: true, writable: true, value: original });
      });
    }
  }

  private captureErrors(): void {
    const onError = (event: ErrorEvent) => {
      const where = event.filename ? ` · ${event.filename}:${event.lineno}:${event.colno}` : '';
      this.record('ERR', 'ERROR', undefined, undefined, safeText(`${event.message || 'window error'}${where}`, 4_000));
    };
    const onRejection = (event: PromiseRejectionEvent) => this.record('ERR', 'REJECT', undefined, undefined, safeText(event.reason ?? 'Unhandled promise rejection', 4_000));
    addEventListener('error', onError);
    addEventListener('unhandledrejection', onRejection);
    this.restores.push(() => removeEventListener('error', onError));
    this.restores.push(() => removeEventListener('unhandledrejection', onRejection));
  }

  private captureUi(): void {
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest('button,[role="button"],a,input,select') : null;
      if (target) this.record('UI', 'CLICK', undefined, undefined, summarizeElement(target));
    };
    const onChange = (event: Event) => {
      if (event.target instanceof Element) this.record('UI', 'CHANGE', undefined, undefined, summarizeElement(event.target));
    };
    const onPointer = (phase: 'POINTER_DOWN' | 'POINTER_UP') => (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      const target = event.target.closest('canvas,.pane,.chart-tile') ?? event.target;
      this.record('UI', phase, undefined, undefined, `${summarizeElement(target)} x=${Math.round(event.clientX)} y=${Math.round(event.clientY)} button=${event.button}`);
    };
    const onPointerDown = onPointer('POINTER_DOWN');
    const onPointerUp = onPointer('POINTER_UP');
    const onKey = (event: KeyboardEvent) => {
      const modifiers = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta'].filter(Boolean).join('+');
      this.record('UI', 'KEY', undefined, undefined, `${modifiers ? `${modifiers}+` : ''}${event.key}`);
    };

    document.addEventListener('click', onClick, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('keydown', onKey, true);
    this.restores.push(() => document.removeEventListener('click', onClick, true));
    this.restores.push(() => document.removeEventListener('change', onChange, true));
    this.restores.push(() => document.removeEventListener('pointerdown', onPointerDown, true));
    this.restores.push(() => document.removeEventListener('pointerup', onPointerUp, true));
    this.restores.push(() => document.removeEventListener('keydown', onKey, true));
  }

  private captureLongTasks(): void {
    if (typeof PerformanceObserver === 'undefined') return;
    try {
      this.performanceObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= LONG_TASK_MIN_MS) this.record('JS', 'LONG', undefined, Math.round(entry.duration), `name=${entry.name || 'longtask'}`);
        }
      });
      this.performanceObserver.observe({ entryTypes: ['longtask'] });
    } catch {
      this.performanceObserver = null;
    }
  }

  private captureLifecycle(): void {
    const onVisibility = () => this.record('STATE', 'VISIBILITY', undefined, undefined, document.visibilityState);
    const onOnline = () => this.record('STATE', 'ONLINE');
    const onOffline = () => this.record('STATE', 'OFFLINE');
    addEventListener('online', onOnline);
    addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisibility);
    this.restores.push(() => removeEventListener('online', onOnline));
    this.restores.push(() => removeEventListener('offline', onOffline));
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
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = chartLogFilename(new Date(stoppedAt));
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

const recorder = new ChartLogRecorder();
if (typeof document !== 'undefined') {
  recorder.install();
  (window as unknown as { __L2CHART_LOG_RECORDER__?: LogRecorderBridge }).__L2CHART_LOG_RECORDER__ = Object.freeze({
    get active() {
      return recorder.active;
    },
    start: () => recorder.start(),
    stop: () => recorder.stop(),
  });
}
