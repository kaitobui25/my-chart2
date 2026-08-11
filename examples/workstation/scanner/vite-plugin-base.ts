import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';

const SCANNER_TARGET = 'http://127.0.0.1:8730';
const VNSTOCK_TARGET = 'http://127.0.0.1:8740';
const MAIN_MODULE_SUFFIX = '/examples/workstation/main.ts';
const ACTIVE_TILE_MARKER = 'let activeTile: Tile | null = null;';

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

// Vite bundles config imports into a temporary file by default, so import.meta.url
// is not a stable way to locate repo sidecars. The dev/preview commands run from
// the repository tree; walk upward from cwd instead.
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

async function scannerIsHealthy(): Promise<boolean> {
  return serviceIsHealthy(SCANNER_TARGET);
}

async function vnstockIsHealthy(): Promise<boolean> {
  return serviceIsHealthy(VNSTOCK_TARGET);
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
      if (code !== 0 && signal == null) {
        console.warn(`[scanner] sidecar exited with code ${code ?? 'unknown'}`);
      }
    });
    child.once('error', (error) => {
      console.warn(`[scanner] ${error.message}`);
      if (scannerChild === child) scannerChild = null;
    });
    server?.httpServer?.once('close', () => {
      if (scannerChild === child && !child.killed) child.kill();
    });
  }

  const ready = await waitForHealth(scannerIsHealthy);
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
    console.log(`[vnstock] Starting sidecar with ${python} on port 8740`);
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

  const ready = await waitForHealth(vnstockIsHealthy, 30);
  if (!ready) console.warn(`[vnstock] sidecar did not become ready at ${VNSTOCK_TARGET}`);
  return ready;
}

async function ensureScannerSidecar(server?: ViteDevServer): Promise<boolean> {
  if (await scannerIsHealthy()) return true;
  if (!scannerStarting) {
    scannerStarting = startScannerSidecar(server).finally(() => {
      scannerStarting = null;
    });
  }
  return scannerStarting;
}

async function ensureVnstockSidecar(server?: ViteDevServer): Promise<boolean> {
  if (await vnstockIsHealthy()) return true;
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
  middlewares: {
    use(route: string, handler: (req: IncomingMessage, res: ServerResponse) => void): void;
  },
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
        headers: {
          ...(req.headers['content-type'] ? { 'content-type': String(req.headers['content-type']) } : {}),
        },
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

function installScannerProxy(
  middlewares: {
    use(route: string, handler: (req: IncomingMessage, res: ServerResponse) => void): void;
  },
  ensureSidecar: () => Promise<boolean>,
): void {
  installJsonProxy('/scanner-api', SCANNER_TARGET, middlewares, ensureSidecar, 'Scanner', 190_000);
}

function installVnstockProxy(
  middlewares: {
    use(route: string, handler: (req: IncomingMessage, res: ServerResponse) => void): void;
  },
  ensureSidecar: () => Promise<boolean>,
): void {
  installJsonProxy('/vnstock-api', VNSTOCK_TARGET, middlewares, ensureSidecar, 'Vnstock', 35_000);
}

function replaceRequired(code: string, needle: string, replacement: string): string {
  if (!code.includes(needle)) throw new Error(`Vnstock integration marker is missing: ${needle.slice(0, 80)}`);
  return code.replace(needle, replacement);
}

function integrateVnstockMain(original: string): string {
  let code = original;
  code = replaceRequired(
    code,
    "import { FiinQuantDatafeed, type FiinQuantHealth } from '../providers/fiinquant';",
    "import { FiinQuantDatafeed, type FiinQuantHealth } from '../providers/fiinquant';\nimport { VnstockDatafeed, type VnstockHealth } from '../providers/vnstock';",
  );
  code = replaceRequired(
    code,
    "type PriceProviderId = 'demo' | 'dnse' | 'fiinquant' | 'binance-spot' | 'binance-usdm';",
    "type PriceProviderId = 'demo' | 'dnse' | 'fiinquant' | 'vnstock' | 'binance-spot' | 'binance-usdm';",
  );
  code = replaceRequired(
    code,
    "return providerId === 'dnse' || providerId === 'fiinquant' ? 7 * 60 : 0;",
    "return providerId === 'dnse' || providerId === 'fiinquant' || providerId === 'vnstock' ? 7 * 60 : 0;",
  );
  code = replaceRequired(
    code,
    "    || stored === 'fiinquant'\n    || stored === 'binance-spot'",
    "    || stored === 'fiinquant'\n    || stored === 'vnstock'\n    || stored === 'binance-spot'",
  );
  code = replaceRequired(
    code,
    "const demoFeed = new SampleDatafeed();\nconst binanceSpotFeed = new BinanceDatafeed({ market: 'spot' });",
    "const demoFeed = new SampleDatafeed();\nconst vnstockFeed = new VnstockDatafeed();\nconst binanceSpotFeed = new BinanceDatafeed({ market: 'spot' });",
  );
  code = replaceRequired(
    code,
    "function pollFiinQuantHealth(): void {\n  if (activeProvider !== 'fiinquant' || document.hidden) return;\n  void reportFiinQuantHealth(false);\n}\n",
    `function pollFiinQuantHealth(): void {\n  if (activeProvider !== 'fiinquant' || document.hidden) return;\n  void reportFiinQuantHealth(false);\n}\n\ntype VnstockConnectionState = 'checking' | 'connected' | 'offline';\nlet vnstockConnectionState: VnstockConnectionState = 'checking';\nlet vnstockHealthSnapshot: VnstockHealth | null = null;\nlet vnstockHealthRequest = 0;\nconst VNSTOCK_HEALTH_POLL_MS = 15_000;\n\nfunction renderVnstockProviderStatus(): void {\n  delete providerStatus.dataset.tone;\n  if (vnstockConnectionState === 'checking') {\n    providerStatus.textContent = tr('Đang kiểm tra Vnstock sidecar...');\n    return;\n  }\n  if (vnstockConnectionState === 'offline') {\n    providerStatus.dataset.tone = 'error';\n    providerStatus.textContent = tr('Vnstock sidecar không khả dụng. Kiểm tra Python/vnstock hoặc examples/sidecars/vnstock/requirements.txt.');\n    return;\n  }\n  providerStatus.dataset.tone = 'success';\n  const routing = vnstockHealthSnapshot?.routing ?? 'KBS/VCI';\n  const seconds = vnstockHealthSnapshot?.pollIntervalSeconds ?? 5;\n  providerStatus.textContent = \`Vnstock sẵn sàng · \${routing} · polling \${seconds}s · cache \${vnstockFeed.cacheAvailable ? 'IndexedDB' : 'không khả dụng'}\`;\n}\n\nasync function reportVnstockHealth(showChecking = true): Promise<void> {\n  const request = ++vnstockHealthRequest;\n  if (showChecking) {\n    vnstockConnectionState = 'checking';\n    renderProviderSourceState();\n  }\n  try {\n    const health = await vnstockFeed.health();\n    if (request !== vnstockHealthRequest) return;\n    vnstockHealthSnapshot = health;\n    vnstockConnectionState = health.ok ? 'connected' : 'offline';\n  } catch {\n    if (request !== vnstockHealthRequest) return;\n    vnstockHealthSnapshot = null;\n    vnstockConnectionState = 'offline';\n  } finally {\n    if (request === vnstockHealthRequest) {\n      renderProviderSourceState();\n      if (!providerOverlay.hidden && selectedProviderPanel === 'vnstock') renderVnstockProviderStatus();\n    }\n  }\n}\n\nfunction pollVnstockHealth(): void {\n  if (activeProvider !== 'vnstock' || document.hidden) return;\n  void reportVnstockHealth(false);\n}\n`,
  );
  code = replaceRequired(
    code,
    "function reportProviderLoadSuccess(provider: PriceProviderId): void {\n  if (provider !== 'fiinquant' || activeProvider !== provider) return;\n  fiinQuantConnectionState = 'connected';\n  renderProviderSourceState();\n}",
    "function reportProviderLoadSuccess(provider: PriceProviderId): void {\n  if (activeProvider !== provider) return;\n  if (provider === 'vnstock') {\n    vnstockConnectionState = 'connected';\n    renderProviderSourceState();\n    return;\n  }\n  if (provider !== 'fiinquant') return;\n  fiinQuantConnectionState = 'connected';\n  renderProviderSourceState();\n}",
  );
  code = replaceRequired(
    code,
    "function reportProviderLoadFailure(provider: PriceProviderId, message: string): void {\n  if (provider !== 'fiinquant' || activeProvider !== provider) return;",
    "function reportProviderLoadFailure(provider: PriceProviderId, message: string): void {\n  if (activeProvider !== provider) return;\n  if (provider === 'vnstock') {\n    if (/cannot reach|failed to fetch|network|sidecar/i.test(message)) vnstockConnectionState = 'offline';\n    renderProviderSourceState();\n    return;\n  }\n  if (provider !== 'fiinquant') return;",
  );
  code = replaceRequired(
    code,
    "  if (activeProvider === 'binance-spot') {\n    return { feed: binanceSpotFeed, label: 'Binance Spot', unavailable: null };\n  }",
    "  if (activeProvider === 'vnstock') {\n    return { feed: vnstockFeed, label: 'Vnstock', unavailable: null };\n  }\n  if (activeProvider === 'binance-spot') {\n    return { feed: binanceSpotFeed, label: 'Binance Spot', unavailable: null };\n  }",
  );
  code = replaceRequired(
    code,
    "const seedLimit = activeProvider === 'fiinquant' ? HISTORY_PAGE_SIZE : 2;",
    "const seedLimit = activeProvider === 'fiinquant' || activeProvider === 'vnstock' ? HISTORY_PAGE_SIZE : 2;",
  );
  code = replaceRequired(
    code,
    "  const seedQueue = [...watchlistSymbols.entries()].sort(([, a], [, b]) => {",
    "  if (activeProvider === 'vnstock') return;\n  const seedQueue = [...watchlistSymbols.entries()].sort(([, a], [, b]) => {",
  );
  code = replaceRequired(
    code,
    "\n  if (isBinanceProvider(provider)) {\n    const feed = provider === 'binance-spot' ? binanceSpotFeed : binanceUsdmFeed;",
    `\n  if (provider === 'vnstock') {\n    return {\n      service: vnstockConnectionState === 'connected'\n        ? tr('Trực tuyến')\n        : vnstockConnectionState === 'checking'\n          ? tr('Đang kiểm tra')\n          : tr('Không khả dụng'),\n      realtime: vnstockConnectionState === 'connected'\n        ? \`REST polling · \${vnstockFeed.cacheAvailable ? 'IndexedDB' : 'no cache'}\`\n        : tr('Không khả dụng'),\n      serviceTone: vnstockConnectionState === 'connected' ? 'success' : vnstockConnectionState === 'checking' ? 'warning' : 'error',\n      realtimeTone: vnstockConnectionState === 'connected' ? 'success' : 'idle',\n    };\n  }\n\n  if (isBinanceProvider(provider)) {\n    const feed = provider === 'binance-spot' ? binanceSpotFeed : binanceUsdmFeed;`,
  );
  code = replaceRequired(
    code,
    "    fiinquant: 'FiinQuant',\n    'binance-spot': 'Binance Spot',",
    "    fiinquant: 'FiinQuant',\n    vnstock: 'Vnstock',\n    'binance-spot': 'Binance Spot',",
  );
  code = replaceRequired(
    code,
    "for (const provider of ['demo', 'binance-spot', 'binance-usdm', 'dnse', 'fiinquant'] as PriceProviderId[]) {",
    "for (const provider of ['demo', 'binance-spot', 'binance-usdm', 'dnse', 'vnstock', 'fiinquant'] as PriceProviderId[]) {",
  );
  code = replaceRequired(
    code,
    "    } else if (provider === 'dnse') {\n      action.textContent = dnseFeed ? tr('Dùng') : tr('Cấu hình');\n      action.classList.toggle('primary', !!dnseFeed);\n    } else {",
    "    } else if (provider === 'dnse') {\n      action.textContent = dnseFeed ? tr('Dùng') : tr('Cấu hình');\n      action.classList.toggle('primary', !!dnseFeed);\n    } else if (provider === 'vnstock') {\n      action.textContent = tr('Dùng');\n      action.classList.toggle('primary', vnstockConnectionState !== 'offline');\n    } else {",
  );
  code = replaceRequired(
    code,
    "  if (provider === 'fiinquant') return 'FiinQuant';\n  return provider === 'binance-spot' ? 'Binance Spot' : 'Binance Futures';",
    "  if (provider === 'fiinquant') return 'FiinQuant';\n  if (provider === 'vnstock') return 'Vnstock';\n  return provider === 'binance-spot' ? 'Binance Spot' : 'Binance Futures';",
  );
  code = replaceRequired(
    code,
    "      : activeProvider === 'fiinquant'\n        ? fiinState\n        : activeProvider === 'binance-spot'",
    "      : activeProvider === 'fiinquant'\n        ? fiinState\n        : activeProvider === 'vnstock'\n          ? vnstockConnectionState === 'connected' ? 'REST polling' : vnstockConnectionState === 'checking' ? tr('đang kiểm tra') : tr('ngoại tuyến')\n        : activeProvider === 'binance-spot'",
  );
  code = replaceRequired(
    code,
    "    isBinanceProvider(activeProvider)\n      || (activeProvider === 'fiinquant' && fiinQuantConnectionState === 'connected')",
    "    isBinanceProvider(activeProvider)\n      || (activeProvider === 'vnstock' && vnstockConnectionState === 'connected')\n      || (activeProvider === 'fiinquant' && fiinQuantConnectionState === 'connected')",
  );
  code = replaceRequired(
    code,
    "    (activeProvider === 'fiinquant' && (fiinQuantConnectionState === 'offline' || fiinQuantConnectionState === 'signed-out'))\n      || (activeProvider === 'dnse' && dnseRealtimeState === 'error'),",
    "    (activeProvider === 'fiinquant' && (fiinQuantConnectionState === 'offline' || fiinQuantConnectionState === 'signed-out'))\n      || (activeProvider === 'vnstock' && vnstockConnectionState === 'offline')\n      || (activeProvider === 'dnse' && dnseRealtimeState === 'error'),",
  );
  code = replaceRequired(
    code,
    "  } else if (isBinanceProvider(activeProvider)) {\n    renderBinanceProviderStatus(activeProvider);\n  } else {",
    "  } else if (isBinanceProvider(activeProvider)) {\n    renderBinanceProviderStatus(activeProvider);\n  } else if (activeProvider === 'vnstock') {\n    renderVnstockProviderStatus();\n    void reportVnstockHealth(false);\n  } else {",
  );
  code = replaceRequired(
    code,
    "  } else if (isBinanceProvider(provider)) {\n    renderBinanceProviderStatus(provider);\n  } else {",
    "  } else if (isBinanceProvider(provider)) {\n    renderBinanceProviderStatus(provider);\n  } else if (provider === 'vnstock') {\n    renderVnstockProviderStatus();\n    void reportVnstockHealth(false);\n  } else {",
  );
  code = replaceRequired(
    code,
    "  if (isBinanceProvider(provider)) {\n    setActiveProvider(provider);\n    return;\n  }\n  if (provider === 'dnse') {",
    "  if (isBinanceProvider(provider)) {\n    setActiveProvider(provider);\n    return;\n  }\n  if (provider === 'vnstock') {\n    setActiveProvider('vnstock');\n    void reportVnstockHealth(false);\n    return;\n  }\n  if (provider === 'dnse') {",
  );
  code = replaceRequired(
    code,
    "    const provider: PriceProviderId = value === 'fiinquant'\n      || value === 'dnse'",
    "    const provider: PriceProviderId = value === 'fiinquant'\n      || value === 'vnstock'\n      || value === 'dnse'",
  );
  code = replaceRequired(
    code,
    "document.getElementById('binance-usdm-use')!.addEventListener('click', () => setActiveProvider('binance-usdm'));",
    `document.getElementById('binance-usdm-use')!.addEventListener('click', () => setActiveProvider('binance-usdm'));\ndocument.getElementById('vnstock-use')!.addEventListener('click', () => {\n  setActiveProvider('vnstock');\n  void reportVnstockHealth(false);\n});\ndocument.getElementById('vnstock-cache-clear')!.addEventListener('click', () => {\n  const button = document.getElementById('vnstock-cache-clear') as HTMLButtonElement;\n  button.disabled = true;\n  providerStatus.textContent = tr('Đang xóa cache Vnstock...');\n  void vnstockFeed.clearCache().then(() => {\n    providerStatus.dataset.tone = 'success';\n    providerStatus.textContent = tr('Đã xóa cache Vnstock.');\n  }).finally(() => {\n    button.disabled = false;\n  });\n});`,
  );
  code = replaceRequired(
    code,
    "bindDnseRealtimeStatus();\nrefreshProviderUi();\nwindow.setInterval(pollFiinQuantHealth, FIINQUANT_HEALTH_POLL_MS);",
    "bindDnseRealtimeStatus();\nrefreshProviderUi();\nvoid reportVnstockHealth(false);\nwindow.setInterval(pollFiinQuantHealth, FIINQUANT_HEALTH_POLL_MS);\nwindow.setInterval(pollVnstockHealth, VNSTOCK_HEALTH_POLL_MS);",
  );
  return code;
}

function integrateVnstockHtml(original: string): string {
  let html = replaceRequired(
    original,
    '<button data-provider-tab="dnse">DNSE</button>\n          <button data-provider-tab="fiinquant">FiinQuant</button>',
    '<button data-provider-tab="dnse">DNSE</button>\n          <button data-provider-tab="vnstock">Vnstock</button>\n          <button data-provider-tab="fiinquant">FiinQuant</button>',
  );
  html = replaceRequired(
    html,
    '        <form id="fiinquant-credential-form" class="provider-panel" data-provider-panel="fiinquant" autocomplete="on" hidden>',
    `        <section class="provider-panel" data-provider-panel="vnstock" hidden>\n          <span class="provider-note">Vnstock 4 dùng nguồn dữ liệu Việt Nam công khai qua sidecar Python. Market data được Unified UI định tuyến KBS/VCI; lịch sử được cache trong IndexedDB.</span>\n          <div class="provider-actions">\n            <button id="vnstock-cache-clear" type="button">Xóa cache Vnstock</button>\n            <span class="spacer"></span>\n            <button id="vnstock-use" type="button">Dùng Vnstock</button>\n          </div>\n        </section>\n        <form id="fiinquant-credential-form" class="provider-panel" data-provider-panel="fiinquant" autocomplete="on" hidden>`,
  );
  return html;
}

export function scannerIntegration(): Plugin {
  return {
    name: 'l2chart-scanner-integration',
    enforce: 'pre',
    configureServer(server) {
      installScannerProxy(server.middlewares, () => ensureScannerSidecar(server));
      installVnstockProxy(server.middlewares, () => ensureVnstockSidecar(server));
      void ensureScannerSidecar(server);
      void ensureVnstockSidecar(server);
    },
    configurePreviewServer(server) {
      installScannerProxy(server.middlewares, () => ensureScannerSidecar());
      installVnstockProxy(server.middlewares, () => ensureVnstockSidecar());
      void ensureScannerSidecar();
      void ensureVnstockSidecar();
    },
    transform(code, id) {
      const normalizedId = id.split('?')[0].replace(/\\/g, '/');
      if (!normalizedId.endsWith(MAIN_MODULE_SUFFIX)) return null;
      if (!code.includes(ACTIVE_TILE_MARKER)) {
        throw new Error('L2Chart scanner integration marker is missing.');
      }
      let transformed = integrateVnstockMain(code);
      const bridge = `
window.__L2CHART_SCANNER_BRIDGE__ = Object.freeze({
  getProvider() { return activeProvider; },
  openSymbol(symbol) {
    const providerMap = {
      fiinquant: 'fiinquant',
      vn_eod: 'fiinquant',
      vnstock: 'vnstock',
      binance_spot: 'binance-spot',
      binance_usdm: 'binance-usdm',
    };
    const scannerSource = document.getElementById('scanner-source')?.value ?? '';
    const targetProvider = providerMap[String(scannerSource)];
    if (targetProvider && activeProvider !== targetProvider) setActiveProvider(targetProvider);
    activeTile?.setSymbol(String(symbol ?? ''));
  },
});
`;
      transformed = `${transformed}\n${bridge}`;
      return { code: transformed, map: null };
    },
    transformIndexHtml(html) {
      return {
        html: integrateVnstockHtml(html),
        tags: [{
          tag: 'script',
          attrs: { type: 'module', src: '/scanner/index.ts' },
          injectTo: 'body',
        }],
      };
    },
  };
}
