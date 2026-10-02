import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';

const API_ROUTE = '/yfinance-jp-api';
const MAIN_MODULE_SUFFIX = '/examples/workstation/main.ts';
const DEFAULT_PORT = 8760;

function findRepoRoot(start: string): string {
  let current = path.resolve(start);
  while (true) {
    const sidecar = path.join(current, 'examples', 'sidecars', 'yfinance-jp', 'yfinance_jp_sidecar.py');
    if (existsSync(path.join(current, 'package.json')) && existsSync(sidecar)) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

const REPO_ROOT = findRepoRoot(process.cwd());
const SIDECAR_DIR = path.join(REPO_ROOT, 'examples', 'sidecars', 'yfinance-jp');
const SIDECAR_SCRIPT = path.join(SIDECAR_DIR, 'yfinance_jp_sidecar.py');
const SIDECAR_REQUIREMENTS = path.join(SIDECAR_DIR, 'requirements.txt');
const SIDECAR_VENV = path.join(SIDECAR_DIR, '.venv');
const ROOT_VENV = path.join(REPO_ROOT, '.venv');
const configuredPort = Number(process.env.YFINANCE_JP_PORT || DEFAULT_PORT);
const SIDECAR_PORT = Number.isFinite(configuredPort) ? configuredPort : DEFAULT_PORT;
const SIDECAR_TARGET = `http://127.0.0.1:${SIDECAR_PORT}`;

let sidecarChild: ChildProcess | null = null;
let sidecarStarting: Promise<boolean> | null = null;

function replaceRequired(code: string, needle: string, replacement: string): string {
  if (!code.includes(needle)) {
    throw new Error(`Yahoo Japan integration marker is missing: ${needle.slice(0, 120)}`);
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

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function pythonIn(venv: string): string {
  return process.platform === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python');
}

function pythonCandidates(): string[] {
  const values = [
    process.env.YFINANCE_JP_PYTHON,
    pythonIn(SIDECAR_VENV),
    pythonIn(ROOT_VENV),
    process.env.VIRTUAL_ENV ? pythonIn(process.env.VIRTUAL_ENV) : undefined,
    process.platform === 'win32' ? 'python' : 'python3',
  ].filter((value): value is string => Boolean(value));
  return [...new Set(values)];
}

function canRunPython(python: string): boolean {
  const result = spawnSync(python, ['-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'], {
    cwd: SIDECAR_DIR,
    stdio: 'ignore',
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

function hasRuntimeDependencies(python: string): boolean {
  const result = spawnSync(python, ['-c', 'import aiohttp, pandas, yfinance'], {
    cwd: SIDECAR_DIR,
    stdio: 'ignore',
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

function runChecked(python: string, args: string[]): void {
  const result = spawnSync(python, args, {
    cwd: SIDECAR_DIR,
    stdio: 'inherit',
    windowsHide: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${python} exited with code ${result.status ?? 'unknown'}`);
}

function resolvePython(): string {
  for (const candidate of pythonCandidates()) {
    if (canRunPython(candidate) && hasRuntimeDependencies(candidate)) return candidate;
  }

  const bootstrap = pythonCandidates().find(canRunPython);
  if (!bootstrap) throw new Error('Python 3.10+ is required for Yahoo Japan market data.');
  if (!existsSync(SIDECAR_REQUIREMENTS)) throw new Error(`Missing sidecar requirements: ${SIDECAR_REQUIREMENTS}`);

  const managedPython = pythonIn(SIDECAR_VENV);
  if (!existsSync(managedPython)) runChecked(bootstrap, ['-m', 'venv', SIDECAR_VENV]);
  runChecked(managedPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', '-r', SIDECAR_REQUIREMENTS]);
  if (!hasRuntimeDependencies(managedPython)) throw new Error('Yahoo Japan sidecar dependencies are unavailable after install.');
  return managedPython;
}

async function serviceIsHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${SIDECAR_TARGET}/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok && (await response.json())?.ok === true;
  } catch {
    return false;
  }
}

async function waitForHealth(attempts = 60): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await serviceIsHealthy()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function startSidecar(server?: ViteDevServer): Promise<boolean> {
  if (!existsSync(SIDECAR_SCRIPT)) return false;
  if (!sidecarChild) {
    const python = resolvePython();
    sidecarChild = spawn(python, [SIDECAR_SCRIPT], {
      cwd: SIDECAR_DIR,
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, PORT: String(SIDECAR_PORT) },
    });
    const child = sidecarChild;
    child.once('exit', () => {
      if (sidecarChild === child) sidecarChild = null;
    });
    child.once('error', () => {
      if (sidecarChild === child) sidecarChild = null;
    });
    server?.httpServer?.once('close', () => {
      if (sidecarChild === child && !child.killed) child.kill();
    });
  }
  return waitForHealth();
}

async function ensureSidecar(server?: ViteDevServer): Promise<boolean> {
  if (await serviceIsHealthy()) return true;
  if (!sidecarStarting) {
    sidecarStarting = startSidecar(server).finally(() => {
      sidecarStarting = null;
    });
  }
  return sidecarStarting;
}

function installProxy(server: ViteDevServer | undefined, middlewares: {
  use(route: string, handler: (req: IncomingMessage, res: ServerResponse) => void): void;
}): void {
  middlewares.use(API_ROUTE, async (req, res) => {
    if (!isAllowedBrowserRequest(req)) {
      sendJson(res, 403, { message: 'Cross-site requests are not allowed' });
      return;
    }
    if (!(await ensureSidecar(server))) {
      sendJson(res, 503, { message: 'Yahoo Japan sidecar failed to start' });
      return;
    }
    try {
      const localUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const body = await readBody(req);
      const response = await fetch(`${SIDECAR_TARGET}${localUrl.pathname}${localUrl.search}`, {
        method: req.method,
        headers: {
          ...(req.headers['content-type'] ? { 'content-type': String(req.headers['content-type']) } : {}),
        },
        body: body && body.length ? new Uint8Array(body) : undefined,
        signal: AbortSignal.timeout(35_000),
      });
      res.statusCode = response.status;
      res.setHeader('content-type', response.headers.get('content-type') ?? 'application/json; charset=utf-8');
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      sendJson(res, 503, { message: error instanceof Error ? error.message : String(error) });
    }
  });
}

function integrateMain(original: string): string {
  let code = original;

  const vnstockImport = code.match(/^import .*VnstockDatafeed.*$/m)?.[0];
  if (!vnstockImport) throw new Error('Yahoo Japan integration requires the Vnstock workstation transform to run first.');
  code = code.replace(
    vnstockImport,
    `${vnstockImport}\nimport { YFinanceJapanDatafeed, YFINANCE_JP_DEFAULT_SYMBOLS, YFINANCE_JP_SUPPORTED_INTERVALS } from '../providers/yfinance-jp';`,
  );
  code = replaceRequired(
    code,
    "type PriceProviderId = 'demo' | 'dnse' | 'fiinquant' | 'vnstock' | 'binance-local' | 'binance-spot' | 'binance-usdm';",
    "type PriceProviderId = 'demo' | 'dnse' | 'fiinquant' | 'vnstock' | 'yfinance-jp' | 'binance-local' | 'binance-spot' | 'binance-usdm';",
  );
  code = replaceRequired(
    code,
    "const BINANCE_LOCAL_INTERVAL_SET = new Set<string>(BINANCE_LOCAL_INTERVALS);",
    "const BINANCE_LOCAL_INTERVAL_SET = new Set<string>(BINANCE_LOCAL_INTERVALS);\nconst YFINANCE_JP_INTERVAL_SET = new Set<string>(YFINANCE_JP_SUPPORTED_INTERVALS);",
  );
  code = replaceRequired(
    code,
    "  return provider !== 'binance-local' || BINANCE_LOCAL_INTERVAL_SET.has(interval);",
    "  if (provider === 'binance-local') return BINANCE_LOCAL_INTERVAL_SET.has(interval);\n  if (provider === 'yfinance-jp') return YFINANCE_JP_INTERVAL_SET.has(interval);\n  return true;",
  );
  code = replaceRequired(
    code,
    "    || stored === 'vnstock'\n    || stored === 'binance-local'",
    "    || stored === 'vnstock'\n    || stored === 'yfinance-jp'\n    || stored === 'binance-local'",
  );
  code = replaceRequired(
    code,
    "const demoFeed = new SampleDatafeed();\nconst vnstockFeed = new VnstockDatafeed();",
    "const demoFeed = new SampleDatafeed();\nconst vnstockFeed = new VnstockDatafeed();\nconst yFinanceJapanFeed = new YFinanceJapanDatafeed();",
  );
  code = replaceRequired(
    code,
    "  return providerId === 'dnse' || providerId === 'fiinquant' || providerId === 'vnstock' ? 7 * 60 : 0;",
    "  if (providerId === 'yfinance-jp') return 9 * 60;\n  return providerId === 'dnse' || providerId === 'fiinquant' || providerId === 'vnstock' ? 7 * 60 : 0;",
  );
  code = replaceRequired(
    code,
    "function providerFamily(provider: PriceProviderId): 'vietnam' | 'binance' {\n  return isCryptoProvider(provider) ? 'binance' : 'vietnam';\n}",
    "function providerFamily(provider: PriceProviderId): 'vietnam' | 'binance' | 'japan' {\n  if (provider === 'yfinance-jp') return 'japan';\n  return isCryptoProvider(provider) ? 'binance' : 'vietnam';\n}",
  );
  code = replaceRequired(
    code,
    "function providerWatchlistKey(provider: PriceProviderId): string {\n  if (provider === 'binance-local') return provider;\n  return isBinanceProvider(provider) ? provider : 'vietnam';\n}",
    "function providerWatchlistKey(provider: PriceProviderId): string {\n  if (provider === 'binance-local' || provider === 'yfinance-jp') return provider;\n  return isBinanceProvider(provider) ? provider : 'vietnam';\n}",
  );
  code = replaceRequired(
    code,
    "function defaultSymbolsForProvider(provider: PriceProviderId): string[] {\n  return isCryptoProvider(provider) ? BINANCE_DEFAULT_SYMBOLS : DEFAULT_SYMBOLS;\n}",
    "function defaultSymbolsForProvider(provider: PriceProviderId): string[] {\n  if (provider === 'yfinance-jp') return YFINANCE_JP_DEFAULT_SYMBOLS;\n  return isCryptoProvider(provider) ? BINANCE_DEFAULT_SYMBOLS : DEFAULT_SYMBOLS;\n}",
  );
  code = replaceRequired(
    code,
    "  if (activeProvider === 'vnstock') {\n    return { feed: vnstockFeed, label: 'Vnstock', unavailable: null };\n  }",
    "  if (activeProvider === 'vnstock') {\n    return { feed: vnstockFeed, label: 'Vnstock', unavailable: null };\n  }\n  if (activeProvider === 'yfinance-jp') {\n    return { feed: yFinanceJapanFeed, label: 'Yahoo Japan', unavailable: null };\n  }",
  );
  code = replaceRequired(
    code,
    "  if (activeProvider === 'fiinquant') return;",
    "  if (activeProvider === 'fiinquant' || activeProvider === 'yfinance-jp') return;",
  );
  code = replaceRequired(
    code,
    "    vnstock: 'Vnstock',\n    'binance-local': 'Binance Local Archive',",
    "    vnstock: 'Vnstock',\n    'yfinance-jp': 'Yahoo Japan',\n    'binance-local': 'Binance Local Archive',",
  );
  code = replaceRequired(
    code,
    "for (const provider of ['demo', 'binance-local', 'binance-spot', 'binance-usdm', 'dnse', 'vnstock', 'fiinquant'] as PriceProviderId[]) {",
    "for (const provider of ['demo', 'binance-local', 'binance-spot', 'binance-usdm', 'dnse', 'vnstock', 'yfinance-jp', 'fiinquant'] as PriceProviderId[]) {",
  );
  code = replaceRequired(
    code,
    "  if (provider === 'vnstock') return 'Vnstock';\n  if (provider === 'binance-local') return 'Binance Local Archive';",
    "  if (provider === 'vnstock') return 'Vnstock';\n  if (provider === 'yfinance-jp') return 'Yahoo Japan';\n  if (provider === 'binance-local') return 'Binance Local Archive';",
  );
  code = replaceRequired(
    code,
    "          : activeProvider === 'vnstock'\n            ? vnstockConnectionState === 'connected' ? 'REST polling' : vnstockConnectionState === 'checking' ? tr('đang kiểm tra') : vnstockConnectionState === 'offline' ? tr('ngoại tuyến') : tr('chưa kết nối')\n          : activeProvider === 'binance-spot'",
    "          : activeProvider === 'vnstock'\n            ? vnstockConnectionState === 'connected' ? 'REST polling' : vnstockConnectionState === 'checking' ? tr('đang kiểm tra') : vnstockConnectionState === 'offline' ? tr('ngoại tuyến') : tr('chưa kết nối')\n          : activeProvider === 'yfinance-jp'\n            ? 'Yahoo · polling 60s'\n          : activeProvider === 'binance-spot'",
  );
  code = replaceRequired(
    code,
    "      || (activeProvider === 'vnstock' && vnstockConnectionState === 'connected')\n      || (activeProvider === 'fiinquant' && fiinQuantConnectionState === 'connected')",
    "      || activeProvider === 'yfinance-jp'\n      || (activeProvider === 'vnstock' && vnstockConnectionState === 'connected')\n      || (activeProvider === 'fiinquant' && fiinQuantConnectionState === 'connected')",
  );
  code = replaceRequired(
    code,
    "  } else if (activeProvider === 'vnstock') {\n    renderVnstockProviderStatus();\n  } else {",
    "  } else if (activeProvider === 'vnstock') {\n    renderVnstockProviderStatus();\n  } else if (activeProvider === 'yfinance-jp') {\n    providerStatus.dataset.tone = 'success';\n    providerStatus.textContent = `Yahoo Japan · TSE · polling 60s · cache ${yFinanceJapanFeed.cacheAvailable ? 'IndexedDB' : 'không khả dụng'}`;\n  } else {",
  );
  code = replaceRequired(
    code,
    "  } else if (provider === 'vnstock') {\n    renderVnstockProviderStatus();\n  } else {",
    "  } else if (provider === 'vnstock') {\n    renderVnstockProviderStatus();\n  } else if (provider === 'yfinance-jp') {\n    providerStatus.dataset.tone = 'success';\n    providerStatus.textContent = `Yahoo Japan · TSE · polling 60s · cache ${yFinanceJapanFeed.cacheAvailable ? 'IndexedDB' : 'không khả dụng'}`;\n  } else {",
  );
  code = replaceRequired(
    code,
    "  if (isBinanceProvider(provider)) {\n    setActiveProvider(provider);\n    return;\n  }\n  if (provider === 'vnstock') {",
    "  if (isBinanceProvider(provider) || provider === 'yfinance-jp') {\n    setActiveProvider(provider);\n    return;\n  }\n  if (provider === 'vnstock') {",
  );
  code = replaceRequired(
    code,
    "      || value === 'vnstock'\n      || value === 'dnse'",
    "      || value === 'vnstock'\n      || value === 'yfinance-jp'\n      || value === 'dnse'",
  );

  return code;
}

function integrateHtml(original: string): string {
  let html = replaceRequired(
    original,
    '<button data-provider-tab="vnstock">Vnstock</button>\n          <button data-provider-tab="fiinquant">FiinQuant</button>',
    '<button data-provider-tab="vnstock">Vnstock</button>\n          <button data-provider-tab="yfinance-jp">Yahoo Japan</button>\n          <button data-provider-tab="fiinquant">FiinQuant</button>',
  );
  html = replaceRequired(
    html,
    '        <form id="fiinquant-credential-form" class="provider-panel" data-provider-panel="fiinquant" autocomplete="on" hidden>',
    `        <section class="provider-panel" data-provider-panel="yfinance-jp" hidden>\n          <span class="provider-note">Tokyo Stock Exchange qua Yahoo Finance/yfinance. Giá có thể bị trễ; chart cập nhật mỗi 60 giây trong phiên.</span>\n        </section>\n        <form id="fiinquant-credential-form" class="provider-panel" data-provider-panel="fiinquant" autocomplete="on" hidden>`,
  );
  return html;
}

export function yFinanceJapanIntegration(): Plugin {
  return {
    name: 'l2chart-yfinance-japan-integration',
    enforce: 'pre',
    configureServer(server) {
      installProxy(server, server.middlewares);
    },
    configurePreviewServer(server) {
      installProxy(undefined, server.middlewares);
    },
    transform(code, id) {
      const normalizedId = id.split('?')[0].replace(/\\/g, '/');
      if (!normalizedId.endsWith(MAIN_MODULE_SUFFIX)) return null;
      return { code: integrateMain(code), map: null };
    },
    transformIndexHtml(html) {
      return integrateHtml(html);
    },
  };
}
