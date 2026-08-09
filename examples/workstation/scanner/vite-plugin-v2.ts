import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { IndexHtmlTransformContext, Plugin, ViteDevServer } from 'vite';
import { scannerIntegration as stableScannerIntegration } from './vite-plugin-base';

const SCANNER_TARGET = 'http://127.0.0.1:8730';
const VNSTOCK_TARGET = 'http://127.0.0.1:8740';

function findRepoRoot(start: string): string {
  let current = path.resolve(start);
  while (true) {
    const scanner = path.join(current, 'examples', 'sidecars', 'scanner', 'scanner_sidecar.py');
    if (existsSync(path.join(current, 'package.json')) && existsSync(scanner)) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

const REPO_ROOT = findRepoRoot(process.cwd());
const SIDECARS_DIR = path.join(REPO_ROOT, 'examples', 'sidecars');
const SCANNER_DIR = path.join(SIDECARS_DIR, 'scanner');
const SCANNER_SCRIPT = path.join(SCANNER_DIR, 'scanner_sidecar.py');
const VNSTOCK_DIR = path.join(SIDECARS_DIR, 'vnstock');
const VNSTOCK_SCRIPT = path.join(VNSTOCK_DIR, 'vnstock_sidecar.py');
const VNSTOCK_VENV = path.join(VNSTOCK_DIR, '.venv');
const ROOT_VENV = path.join(REPO_ROOT, '.venv');
const FIINQUANT_VENV = path.join(SIDECARS_DIR, 'fiinquant', '.venv');

let scannerChild: ChildProcess | null = null;
let scannerStarting: Promise<boolean> | null = null;
let vnstockChild: ChildProcess | null = null;
let vnstockStarting: Promise<boolean> | null = null;

function lines(...values: string[]): string {
  return values.join('\n');
}

function replaceRequired(code: string, needle: string, replacement: string): string {
  if (!code.includes(needle)) {
    throw new Error(`Lazy provider integration marker is missing: ${needle.slice(0, 100)}`);
  }
  return code.replace(needle, replacement);
}

function isAllowedBrowserRequest(req: IncomingMessage): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  if (!host) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.host === host;
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

async function serviceIsHealthy(target: string): Promise<boolean> {
  try {
    const response = await fetch(`${target}/health`, { signal: AbortSignal.timeout(700) });
    return response.ok && (await response.json())?.ok === true;
  } catch {
    return false;
  }
}

async function waitForHealth(check: () => Promise<boolean>, attempts = 40): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function scannerPython(): string {
  if (process.env.SCANNER_PYTHON) return process.env.SCANNER_PYTHON;
  const venv = process.platform === 'win32'
    ? path.join(FIINQUANT_VENV, 'Scripts', 'python.exe')
    : path.join(FIINQUANT_VENV, 'bin', 'python');
  if (existsSync(venv)) return venv;
  if (process.env.FIINQUANT_PYTHON) return process.env.FIINQUANT_PYTHON;
  return process.platform === 'win32' ? 'python' : 'python3';
}

function vnstockPython(): string {
  if (process.env.VNSTOCK_PYTHON) return process.env.VNSTOCK_PYTHON;
  const candidates = [VNSTOCK_VENV, ROOT_VENV];
  if (process.env.VIRTUAL_ENV) candidates.push(process.env.VIRTUAL_ENV);
  for (const candidate of candidates) {
    const python = process.platform === 'win32'
      ? path.join(candidate, 'Scripts', 'python.exe')
      : path.join(candidate, 'bin', 'python');
    if (existsSync(python)) return python;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

async function startScannerSidecar(server?: ViteDevServer): Promise<boolean> {
  if (!existsSync(SCANNER_SCRIPT)) {
    console.warn(`[scanner] Missing sidecar: ${SCANNER_SCRIPT}`);
    return false;
  }
  if (!scannerChild) {
    const python = scannerPython();
    console.log(`[scanner] Starting sidecar with ${python}`);
    scannerChild = spawn(python, [SCANNER_SCRIPT], {
      cwd: SCANNER_DIR,
      stdio: 'inherit',
      windowsHide: false,
      env: process.env,
    });
    const child = scannerChild;
    child.once('exit', (code, signal) => {
      if (scannerChild === child) scannerChild = null;
      if (code !== 0 && signal == null) console.warn(`[scanner] sidecar exited with code ${code ?? 'unknown'}`);
    });
    child.once('error', (error) => {
      console.warn(`[scanner] ${error.message}`);
      if (scannerChild === child) scannerChild = null;
    });
    server?.httpServer?.once('close', () => {
      if (scannerChild === child && !child.killed) child.kill();
    });
  }
  const ready = await waitForHealth(() => serviceIsHealthy(SCANNER_TARGET));
  if (!ready) console.warn(`[scanner] sidecar did not become ready at ${SCANNER_TARGET}`);
  return ready;
}

async function startVnstockSidecar(server?: ViteDevServer): Promise<boolean> {
  if (!existsSync(VNSTOCK_SCRIPT)) {
    console.warn(`[vnstock] Missing sidecar: ${VNSTOCK_SCRIPT}`);
    return false;
  }
  if (!vnstockChild) {
    const python = vnstockPython();
    console.log(`[vnstock] Starting sidecar on demand with ${python} on port 8740`);
    vnstockChild = spawn(python, [VNSTOCK_SCRIPT], {
      cwd: VNSTOCK_DIR,
      stdio: 'inherit',
      windowsHide: false,
      env: { ...process.env, PORT: '8740' },
    });
    const child = vnstockChild;
    child.once('exit', (code, signal) => {
      if (vnstockChild === child) vnstockChild = null;
      if (code !== 0 && signal == null) {
        console.warn(`[vnstock] sidecar exited with code ${code ?? 'unknown'}. Install examples/sidecars/vnstock/requirements.txt in VNSTOCK_PYTHON.`);
      }
    });
    child.once('error', (error) => {
      console.warn(`[vnstock] ${error.message}`);
      if (vnstockChild === child) vnstockChild = null;
    });
    server?.httpServer?.once('close', () => {
      if (vnstockChild === child && !child.killed) child.kill();
    });
  }
  const ready = await waitForHealth(() => serviceIsHealthy(VNSTOCK_TARGET), 30);
  if (!ready) console.warn(`[vnstock] sidecar did not become ready at ${VNSTOCK_TARGET}`);
  return ready;
}

async function ensureScannerSidecar(server?: ViteDevServer): Promise<boolean> {
  if (await serviceIsHealthy(SCANNER_TARGET)) return true;
  if (!scannerStarting) {
    scannerStarting = startScannerSidecar(server).finally(() => {
      scannerStarting = null;
    });
  }
  return scannerStarting;
}

async function ensureVnstockSidecar(server?: ViteDevServer): Promise<boolean> {
  if (await serviceIsHealthy(VNSTOCK_TARGET)) return true;
  if (!vnstockStarting) {
    vnstockStarting = startVnstockSidecar(server).finally(() => {
      vnstockStarting = null;
    });
  }
  return vnstockStarting;
}

function installJsonProxy(
  route: string,
  target: string,
  middlewares: { use(route: string, handler: (req: IncomingMessage, res: ServerResponse) => void): void },
  ensureSidecar: () => Promise<boolean>,
  label: string,
  timeoutMs: number,
): void {
  middlewares.use(route, async (req, res) => {
    if (!isAllowedBrowserRequest(req)) {
      sendJson(res, 403, { message: 'Cross-site requests are not allowed' });
      return;
    }
    if (!(await ensureSidecar())) {
      sendJson(res, 503, { message: `${label} sidecar failed to start` });
      return;
    }
    try {
      const localUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const targetUrl = `${target}${localUrl.pathname}${localUrl.search}`;
      const body = await readBody(req);
      const upstream = await fetch(targetUrl, {
        method: req.method,
        headers: req.headers['content-type'] ? { 'content-type': String(req.headers['content-type']) } : {},
        body: body && body.length ? new Uint8Array(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      res.statusCode = upstream.status;
      res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json; charset=utf-8');
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      sendJson(res, 503, {
        message: `${label} sidecar is offline: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });
}

function configureLazySidecars(server: ViteDevServer | undefined, middlewares: {
  use(route: string, handler: (req: IncomingMessage, res: ServerResponse) => void): void;
}): void {
  installJsonProxy(
    '/scanner-api',
    SCANNER_TARGET,
    middlewares,
    () => ensureScannerSidecar(server),
    'Scanner',
    190_000,
  );
  installJsonProxy(
    '/vnstock-api',
    VNSTOCK_TARGET,
    middlewares,
    () => ensureVnstockSidecar(server),
    'Vnstock',
    35_000,
  );
  void ensureScannerSidecar(server);
}

function patchLazyProviderLifecycle(original: string): string {
  let code = original;

  code = replaceRequired(
    code,
    lines(
      "type VnstockConnectionState = 'checking' | 'connected' | 'offline';",
      "let vnstockConnectionState: VnstockConnectionState = 'checking';",
      'let vnstockHealthSnapshot: VnstockHealth | null = null;',
      'let vnstockHealthRequest = 0;',
      'const VNSTOCK_HEALTH_POLL_MS = 15_000;',
      '',
      'function renderVnstockProviderStatus(): void {',
      '  delete providerStatus.dataset.tone;',
      "  if (vnstockConnectionState === 'checking') {",
      "    providerStatus.textContent = tr('Đang kiểm tra Vnstock sidecar...');",
      '    return;',
      '  }',
      "  if (vnstockConnectionState === 'offline') {",
      "    providerStatus.dataset.tone = 'error';",
      "    providerStatus.textContent = tr('Vnstock sidecar không khả dụng. Kiểm tra Python/vnstock hoặc examples/sidecars/vnstock/requirements.txt.');",
      '    return;',
      '  }',
      "  providerStatus.dataset.tone = 'success';",
      "  const routing = vnstockHealthSnapshot?.routing ?? 'KBS/VCI';",
      '  const seconds = vnstockHealthSnapshot?.pollIntervalSeconds ?? 5;',
      "  providerStatus.textContent = `Vnstock sẵn sàng · ${routing} · polling ${seconds}s · cache ${vnstockFeed.cacheAvailable ? 'IndexedDB' : 'không khả dụng'}`;",
      '}',
      '',
      'async function reportVnstockHealth(showChecking = true): Promise<void> {',
      '  const request = ++vnstockHealthRequest;',
      '  if (showChecking) {',
      "    vnstockConnectionState = 'checking';",
      '    renderProviderSourceState();',
      '  }',
      '  try {',
      '    const health = await vnstockFeed.health();',
      '    if (request !== vnstockHealthRequest) return;',
      '    vnstockHealthSnapshot = health;',
      "    vnstockConnectionState = health.ok ? 'connected' : 'offline';",
      '  } catch {',
      '    if (request !== vnstockHealthRequest) return;',
      '    vnstockHealthSnapshot = null;',
      "    vnstockConnectionState = 'offline';",
      '  } finally {',
      '    if (request === vnstockHealthRequest) {',
      '      renderProviderSourceState();',
      "      if (!providerOverlay.hidden && selectedProviderPanel === 'vnstock') renderVnstockProviderStatus();",
      '    }',
      '  }',
      '}',
      '',
      'function pollVnstockHealth(): void {',
      "  if (activeProvider !== 'vnstock' || document.hidden) return;",
      '  void reportVnstockHealth(false);',
      '}',
    ),
    lines(
      "type VnstockConnectionState = 'idle' | 'checking' | 'connected' | 'offline';",
      "let vnstockConnectionState: VnstockConnectionState = 'idle';",
      'let vnstockHealthSnapshot: VnstockHealth | null = null;',
      'let vnstockHealthRequest = 0;',
      'const VNSTOCK_HEALTH_POLL_MS = 15_000;',
      '',
      'function renderVnstockProviderStatus(): void {',
      '  delete providerStatus.dataset.tone;',
      "  if (vnstockConnectionState === 'idle') {",
      "    providerStatus.textContent = tr('Vnstock chưa kết nối. Bấm Dùng để khởi động sidecar.');",
      '    return;',
      '  }',
      "  if (vnstockConnectionState === 'checking') {",
      "    providerStatus.textContent = tr('Đang khởi động Vnstock sidecar...');",
      '    return;',
      '  }',
      "  if (vnstockConnectionState === 'offline') {",
      "    providerStatus.dataset.tone = 'error';",
      "    providerStatus.textContent = tr('Vnstock sidecar không khả dụng. Kiểm tra Python/vnstock hoặc examples/sidecars/vnstock/requirements.txt.');",
      '    return;',
      '  }',
      "  providerStatus.dataset.tone = 'success';",
      "  const routing = vnstockHealthSnapshot?.routing ?? 'KBS/VCI';",
      '  const seconds = vnstockHealthSnapshot?.pollIntervalSeconds ?? 5;',
      "  providerStatus.textContent = `Vnstock sẵn sàng · ${routing} · polling ${seconds}s · cache ${vnstockFeed.cacheAvailable ? 'IndexedDB' : 'không khả dụng'}`;",
      '}',
      '',
      'async function reportVnstockHealth(showChecking = true): Promise<boolean> {',
      '  const request = ++vnstockHealthRequest;',
      '  if (showChecking) {',
      "    vnstockConnectionState = 'checking';",
      '    renderProviderSourceState();',
      '    renderVnstockProviderStatus();',
      '  }',
      '  let connected = false;',
      '  try {',
      '    const health = await vnstockFeed.health();',
      '    if (request !== vnstockHealthRequest) return false;',
      '    vnstockHealthSnapshot = health;',
      '    connected = health.ok;',
      "    vnstockConnectionState = connected ? 'connected' : 'offline';",
      '  } catch {',
      '    if (request !== vnstockHealthRequest) return false;',
      '    vnstockHealthSnapshot = null;',
      "    vnstockConnectionState = 'offline';",
      '  } finally {',
      '    if (request === vnstockHealthRequest) {',
      '      renderProviderSourceState();',
      "      if (!providerOverlay.hidden && selectedProviderPanel === 'vnstock') renderVnstockProviderStatus();",
      '    }',
      '  }',
      '  return connected;',
      '}',
      '',
      'function pollVnstockHealth(): void {',
      "  if (activeProvider !== 'vnstock' || document.hidden) return;",
      '  void reportVnstockHealth(false);',
      '}',
    ),
  );

  code = replaceRequired(
    code,
    lines(
      'async function getAuthorizedFiinQuantHealth(): Promise<FiinQuantHealth | null> {',
      '  fiinQuantHealthRequest += 1;',
    ),
    lines(
      'async function ensureFiinQuantRuntime(): Promise<boolean> {',
      "  fiinQuantConnectionState = 'checking';",
      '  renderProviderSourceState();',
      '  delete providerStatus.dataset.tone;',
      "  providerStatus.textContent = tr('Đang khởi động FiinQuant sidecar...');",
      '  try {',
      "    const response = await fetch('/provider-runtime/fiinquant/ensure', {",
      "      method: 'POST',",
      "      headers: { Accept: 'application/json' },",
      '    });',
      '    const payload = await response.json().catch(() => null) as { message?: string } | null;',
      '    if (!response.ok) {',
      "      fiinQuantConnectionState = 'offline';",
      '      renderProviderSourceState();',
      "      providerStatus.dataset.tone = 'error';",
      "      providerStatus.textContent = payload?.message ?? tr('Không thể khởi động FiinQuant sidecar.');",
      '      return false;',
      '    }',
      '    return true;',
      '  } catch (error) {',
      "    fiinQuantConnectionState = 'offline';",
      '    renderProviderSourceState();',
      "    providerStatus.dataset.tone = 'error';",
      "    providerStatus.textContent = `${tr('Không thể khởi động FiinQuant sidecar')}: ${error instanceof Error ? error.message : String(error)}`;",
      '    return false;',
      '  }',
      '}',
      '',
      'async function getAuthorizedFiinQuantHealth(): Promise<FiinQuantHealth | null> {',
      '  if (!await ensureFiinQuantRuntime()) return null;',
      '  fiinQuantHealthRequest += 1;',
    ),
  );

  code = replaceRequired(
    code,
    lines(
      "  } else if (activeProvider === 'vnstock') {",
      '    renderVnstockProviderStatus();',
      '    void reportVnstockHealth(false);',
      '  } else {',
    ),
    lines(
      "  } else if (activeProvider === 'vnstock') {",
      '    renderVnstockProviderStatus();',
      '  } else {',
    ),
  );

  code = replaceRequired(
    code,
    lines(
      "  } else if (provider === 'vnstock') {",
      '    renderVnstockProviderStatus();',
      '    void reportVnstockHealth(false);',
      '  } else {',
    ),
    lines(
      "  } else if (provider === 'vnstock') {",
      '    renderVnstockProviderStatus();',
      '  } else {',
    ),
  );

  code = replaceRequired(
    code,
    lines(
      "  } else if (provider === 'vnstock') {",
      '    renderVnstockProviderStatus();',
      '  } else {',
      '    void reportFiinQuantHealth();',
      '  }',
      '  renderProviderConnectionSummary();',
    ),
    lines(
      "  } else if (provider === 'vnstock') {",
      '    renderVnstockProviderStatus();',
      '  } else {',
      "    if (activeProvider === 'fiinquant') void reportFiinQuantHealth();",
      "    else providerStatus.textContent = tr('FiinQuant chưa kết nối. Bấm Dùng để khởi động sidecar.');",
      '  }',
      '  renderProviderConnectionSummary();',
    ),
  );

  code = replaceRequired(
    code,
    lines(
      '  if (selectedProviderPanel === provider) {',
      "    if (provider === 'dnse') renderDnseProviderStatus();",
      '    else void reportFiinQuantHealth();',
      '  }',
    ),
    lines(
      '  if (selectedProviderPanel === provider) {',
      "    if (provider === 'dnse') renderDnseProviderStatus();",
      "    else if (activeProvider === 'fiinquant') void reportFiinQuantHealth();",
      "    else providerStatus.textContent = tr('FiinQuant chưa kết nối. Bấm Dùng để khởi động sidecar.');",
      '  }',
    ),
  );

  code = replaceRequired(
    code,
    lines(
      "  if (provider === 'vnstock') {",
      "    setActiveProvider('vnstock');",
      '    void reportVnstockHealth(false);',
      '    return;',
      '  }',
    ),
    lines(
      "  if (provider === 'vnstock') {",
      "    if (await reportVnstockHealth()) setActiveProvider('vnstock');",
      '    return;',
      '  }',
    ),
  );

  code = replaceRequired(
    code,
    lines(
      "document.getElementById('vnstock-use')!.addEventListener('click', () => {",
      "  setActiveProvider('vnstock');",
      '  void reportVnstockHealth(false);',
      '});',
    ),
    lines(
      "document.getElementById('vnstock-use')!.addEventListener('click', () => {",
      '  void reportVnstockHealth().then((ready) => {',
      "    if (ready) setActiveProvider('vnstock');",
      '  });',
      '});',
    ),
  );

  code = replaceRequired(
    code,
    lines(
      "      service: vnstockConnectionState === 'connected'",
      "        ? tr('Trực tuyến')",
      "        : vnstockConnectionState === 'checking'",
      "          ? tr('Đang kiểm tra')",
      "          : tr('Không khả dụng'),",
      "      realtime: vnstockConnectionState === 'connected'",
      "        ? `REST polling · ${vnstockFeed.cacheAvailable ? 'IndexedDB' : 'no cache'}`",
      "        : tr('Không khả dụng'),",
      "      serviceTone: vnstockConnectionState === 'connected' ? 'success' : vnstockConnectionState === 'checking' ? 'warning' : 'error',",
      "      realtimeTone: vnstockConnectionState === 'connected' ? 'success' : 'idle',",
    ),
    lines(
      "      service: vnstockConnectionState === 'connected'",
      "        ? tr('Trực tuyến')",
      "        : vnstockConnectionState === 'checking'",
      "          ? tr('Đang kiểm tra')",
      "          : vnstockConnectionState === 'offline'",
      "            ? tr('Không khả dụng')",
      "            : tr('Chưa kết nối'),",
      "      realtime: vnstockConnectionState === 'connected'",
      "        ? `REST polling · ${vnstockFeed.cacheAvailable ? 'IndexedDB' : 'no cache'}`",
      "        : vnstockConnectionState === 'idle'",
      "          ? tr('Chưa mở kết nối')",
      "          : tr('Không khả dụng'),",
      "      serviceTone: vnstockConnectionState === 'connected'",
      "        ? 'success'",
      "        : vnstockConnectionState === 'checking'",
      "          ? 'warning'",
      "          : vnstockConnectionState === 'offline' ? 'error' : 'idle',",
      "      realtimeTone: vnstockConnectionState === 'connected' ? 'success' : 'idle',",
    ),
  );

  code = replaceRequired(
    code,
    "          ? vnstockConnectionState === 'connected' ? 'REST polling' : vnstockConnectionState === 'checking' ? tr('đang kiểm tra') : tr('ngoại tuyến')",
    "          ? vnstockConnectionState === 'connected' ? 'REST polling' : vnstockConnectionState === 'checking' ? tr('đang kiểm tra') : vnstockConnectionState === 'offline' ? tr('ngoại tuyến') : tr('chưa kết nối')",
  );

  code = replaceRequired(
    code,
    lines(
      'bindDnseRealtimeStatus();',
      'refreshProviderUi();',
      'void reportVnstockHealth(false);',
      'window.setInterval(pollFiinQuantHealth, FIINQUANT_HEALTH_POLL_MS);',
      'window.setInterval(pollVnstockHealth, VNSTOCK_HEALTH_POLL_MS);',
    ),
    lines(
      'bindDnseRealtimeStatus();',
      'refreshProviderUi();',
      "if (activeProvider === 'fiinquant') {",
      '  void ensureFiinQuantRuntime().then((ready) => {',
      '    if (!ready) return;',
      '    void reportFiinQuantHealth(false);',
      '    reloadAllTiles();',
      '  });',
      "} else if (activeProvider === 'vnstock') {",
      '  void reportVnstockHealth(false).then((ready) => {',
      '    if (ready) reloadAllTiles();',
      '  });',
      '}',
      'window.setInterval(pollFiinQuantHealth, FIINQUANT_HEALTH_POLL_MS);',
      'window.setInterval(pollVnstockHealth, VNSTOCK_HEALTH_POLL_MS);',
    ),
  );

  code = replaceRequired(
    code,
    lines(
      '  openSymbol(symbol) {',
      '    const providerMap = {',
      "      fiinquant: 'fiinquant',",
      "      vn_eod: 'fiinquant',",
      "      vnstock: 'vnstock',",
      "      binance_spot: 'binance-spot',",
      "      binance_usdm: 'binance-usdm',",
      '    };',
      "    const scannerSource = document.getElementById('scanner-source')?.value ?? '';",
      '    const targetProvider = providerMap[String(scannerSource)];',
      '    if (targetProvider && activeProvider !== targetProvider) setActiveProvider(targetProvider);',
      "    activeTile?.setSymbol(String(symbol ?? ''));",
      '  },',
    ),
    lines(
      '  async openSymbol(symbol) {',
      '    const providerMap = {',
      "      fiinquant: 'fiinquant',",
      "      vn_eod: 'fiinquant',",
      "      vnstock: 'vnstock',",
      "      binance_spot: 'binance-spot',",
      "      binance_usdm: 'binance-usdm',",
      '    };',
      "    const scannerSource = document.getElementById('scanner-source')?.value ?? '';",
      '    const targetProvider = providerMap[String(scannerSource)];',
      "    if (targetProvider === 'fiinquant' && !(await ensureFiinQuantRuntime())) return;",
      "    if (targetProvider === 'vnstock' && !(await reportVnstockHealth(false))) return;",
      '    if (targetProvider && activeProvider !== targetProvider) setActiveProvider(targetProvider);',
      "    activeTile?.setSymbol(String(symbol ?? ''));",
      '  },',
    ),
  );

  return code;
}

function runStableTransform(
  stable: Plugin,
  context: unknown,
  code: string,
  id: string,
): any {
  const hook = stable.transform as unknown as ((this: unknown, source: string, moduleId: string) => unknown) | undefined;
  if (!hook) return null;
  const result = hook.call(context, code, id) as string | { code: string; map?: unknown } | null;
  if (!result) return null;
  if (typeof result === 'string') return patchLazyProviderLifecycle(result);
  return { ...result, code: patchLazyProviderLifecycle(result.code) };
}

function runStableHtmlTransform(
  stable: Plugin,
  context: unknown,
  html: string,
  ctx: IndexHtmlTransformContext,
): unknown {
  const hook = stable.transformIndexHtml as unknown as ((this: unknown, source: string, context: IndexHtmlTransformContext) => unknown) | undefined;
  return hook ? hook.call(context, html, ctx) : html;
}

export function scannerIntegration(): Plugin {
  const stable = stableScannerIntegration();
  return {
    name: 'l2chart-scanner-lazy-provider-integration',
    enforce: 'pre',
    configureServer(server) {
      configureLazySidecars(server, server.middlewares);
    },
    configurePreviewServer(server) {
      configureLazySidecars(undefined, server.middlewares);
    },
    transform(code, id) {
      return runStableTransform(stable, this, code, id);
    },
    transformIndexHtml(html, ctx) {
      return runStableHtmlTransform(stable, this, html, ctx) as any;
    },
  };
}
