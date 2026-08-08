import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';

const SCANNER_TARGET = 'http://127.0.0.1:8730';
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
const FIINQUANT_VENV = path.join(SIDECARS_DIR, 'fiinquant', '.venv');
let scannerChild: ChildProcess | null = null;
let scannerStarting: Promise<boolean> | null = null;

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

async function scannerIsHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${SCANNER_TARGET}/health`, { signal: AbortSignal.timeout(500) });
    return response.ok && (await response.json())?.ok === true;
  } catch {
    return false;
  }
}

async function waitForScannerHealth(attempts = 40): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await scannerIsHealthy()) return true;
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

  const ready = await waitForScannerHealth();
  if (!ready) console.warn(`[scanner] sidecar did not become ready at ${SCANNER_TARGET}`);
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

function installScannerProxy(
  middlewares: {
    use(route: string, handler: (req: IncomingMessage, res: ServerResponse) => void): void;
  },
  ensureSidecar: () => Promise<boolean>,
): void {
  middlewares.use('/scanner-api', async (req, res) => {
    if (!isAllowedBrowserRequest(req)) {
      sendJson(res, 403, { message: 'Cross-site requests are not allowed' });
      return;
    }
    if (!(await ensureSidecar())) {
      sendJson(res, 503, { message: 'Scanner sidecar failed to start' });
      return;
    }
    try {
      const localUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const target = `${SCANNER_TARGET}${localUrl.pathname}${localUrl.search}`;
      const body = await readBody(req);
      const upstream = await fetch(target, {
        method: req.method,
        headers: {
          ...(req.headers['content-type'] ? { 'content-type': String(req.headers['content-type']) } : {}),
        },
        body: body && body.length ? new Uint8Array(body) : undefined,
        signal: AbortSignal.timeout(190_000),
      });
      res.statusCode = upstream.status;
      res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json; charset=utf-8');
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      sendJson(res, 503, {
        message: `Scanner sidecar is offline: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });
}

export function scannerIntegration(): Plugin {
  return {
    name: 'l2chart-scanner-integration',
    enforce: 'pre',
    configureServer(server) {
      installScannerProxy(server.middlewares, () => ensureScannerSidecar(server));
      void ensureScannerSidecar(server);
    },
    configurePreviewServer(server) {
      installScannerProxy(server.middlewares, () => ensureScannerSidecar());
      void ensureScannerSidecar();
    },
    transform(code, id) {
      const normalizedId = id.split('?')[0].replace(/\\/g, '/');
      if (!normalizedId.endsWith(MAIN_MODULE_SUFFIX)) return null;
      if (!code.includes(ACTIVE_TILE_MARKER)) {
        throw new Error('L2Chart scanner integration marker is missing.');
      }
      const bridge = `
window.__L2CHART_SCANNER_BRIDGE__ = Object.freeze({
  getProvider() { return activeProvider; },
  openSymbol(symbol) {
    const providerMap = {
      fiinquant: 'fiinquant',
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
      return { code: `${code}\n${bridge}`, map: null };
    },
    transformIndexHtml() {
      return [{
        tag: 'script',
        attrs: { type: 'module', src: '/scanner/index.ts' },
        injectTo: 'body',
      }];
    },
  };
}
