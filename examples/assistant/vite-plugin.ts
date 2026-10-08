import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin, ViteDevServer } from 'vite';

const API_ROUTE = '/assistant-api';
const SIDECAR_HOST = '127.0.0.1';
const SIDECAR_PORT = 8788;
const SIDECAR_TARGET = `http://${SIDECAR_HOST}:${SIDECAR_PORT}`;
export const ASSISTANT_API_VERSION = 2;
const SIDECAR_SCRIPT = fileURLToPath(new URL('../sidecars/assistant/server.mjs', import.meta.url));
const SIDECAR_CWD = resolve(dirname(SIDECAR_SCRIPT), '../../..');
const SIDECAR_DIR = dirname(SIDECAR_SCRIPT);

let sidecarChild: ChildProcess | null = null;
let sidecarStarting: Promise<SidecarState> | null = null;
type SidecarState = 'ready' | 'stale' | 'offline';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function isAllowedAssistantRequestHeaders(headers: IncomingHttpHeaders): boolean {
  if (headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = headers.origin;
  if (!origin) return true;
  const authority = headers[':authority'];
  const host = headers.host ?? (typeof authority === 'string' ? authority : undefined);
  if (!host) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.host === host;
  } catch {
    return false;
  }
}

function isAllowedBrowserRequest(req: IncomingMessage): boolean {
  return isAllowedAssistantRequestHeaders(req.headers);
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

export function sanitizeAssistantProxyHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (
      !value
      || key.startsWith(':')
      || key.toLowerCase() === 'host'
      || HOP_BY_HOP_HEADERS.has(key.toLowerCase())
    ) continue;
    output[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return output;
}

function forwardedHeaders(req: IncomingMessage): Record<string, string> {
  return sanitizeAssistantProxyHeaders(req.headers);
}

function lastSidecarSourceChange(): number {
  return Math.max(0, ...readdirSync(SIDECAR_DIR)
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => statSync(join(SIDECAR_DIR, name)).mtimeMs));
}

export function isCompatibleAssistantHealth(
  payload: unknown,
  lastSourceChange = lastSidecarSourceChange(),
): boolean {
  if (payload === null || typeof payload !== 'object') return false;
  const value = payload as { ok?: unknown; apiVersion?: unknown; startedAt?: unknown };
  return value.ok === true
    && value.apiVersion === ASSISTANT_API_VERSION
    && typeof value.startedAt === 'number'
    && Number.isFinite(value.startedAt)
    && value.startedAt + 500 >= lastSourceChange;
}

async function sidecarHealthState(): Promise<SidecarState> {
  try {
    const response = await fetch(`${SIDECAR_TARGET}/health`, { signal: AbortSignal.timeout(900) });
    if (!response.ok) return 'offline';
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object' || !('ok' in payload) || payload.ok !== true) return 'offline';
    return isCompatibleAssistantHealth(payload) ? 'ready' : 'stale';
  } catch {
    return 'offline';
  }
}

async function waitForHealth(attempts = 40): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await sidecarHealthState() === 'ready') return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function startSidecar(server?: ViteDevServer): Promise<boolean> {
  if (!existsSync(SIDECAR_SCRIPT)) return false;
  if (!sidecarChild) {
    sidecarChild = spawn(process.execPath, [SIDECAR_SCRIPT], {
      cwd: SIDECAR_CWD,
      stdio: 'inherit',
      windowsHide: true,
      env: {
        ...process.env,
        L2CHART_ASSISTANT_HOST: SIDECAR_HOST,
        L2CHART_ASSISTANT_PORT: String(SIDECAR_PORT),
      },
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

async function stopManagedSidecar(): Promise<void> {
  const child = sidecarChild;
  if (!child || child.killed) return;
  child.kill();
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
  ]);
  if (sidecarChild === child) sidecarChild = null;
}

async function ensureSidecar(server?: ViteDevServer): Promise<SidecarState> {
  if (sidecarStarting) return sidecarStarting;
  const state = await sidecarHealthState();
  if (state === 'ready') return 'ready';
  // Do not terminate an externally started sidecar (it may serve another chart client).
  if (state === 'stale' && !sidecarChild) return 'stale';
  if (!sidecarStarting) {
    sidecarStarting = (async (): Promise<SidecarState> => {
      if (sidecarChild) await stopManagedSidecar();
      return await startSidecar(server) ? 'ready' : 'offline';
    })().finally(() => {
      sidecarStarting = null;
    });
  }
  return sidecarStarting;
}

function installProxy(
  server: ViteDevServer | undefined,
  middlewares: { use(route: string, handler: (req: IncomingMessage, res: ServerResponse) => void): void },
): void {
  middlewares.use(API_ROUTE, async (req, res) => {
    if (!isAllowedBrowserRequest(req)) {
      sendJson(res, 403, { error: 'Cross-site requests are not allowed', code: 'FORBIDDEN' });
      return;
    }
    const state = await ensureSidecar(server);
    if (state !== 'ready') {
      sendJson(res, 503, state === 'stale'
        ? {
            error: 'Assistant sidecar on port 8788 is running outdated code. Stop that sidecar process; the Excel dev server will start a fresh one.',
            code: 'SIDECAR_STALE',
          }
        : { error: 'AI sidecar failed to start.', code: 'SIDECAR_OFFLINE' });
      return;
    }

    try {
      const localUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const body = await readBody(req);
      const response = await fetch(`${SIDECAR_TARGET}${localUrl.pathname}${localUrl.search}`, {
        method: req.method,
        headers: forwardedHeaders(req),
        body: body && body.length ? new Uint8Array(body) : undefined,
        signal: AbortSignal.timeout(190_000),
      });
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        const normalized = key.toLowerCase();
        if (!HOP_BY_HOP_HEADERS.has(normalized) && normalized !== 'content-encoding') {
          res.setHeader(key, value);
        }
      });
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      sendJson(res, 503, {
        error: error instanceof Error ? error.message : String(error),
        code: 'SIDECAR_OFFLINE',
      });
    }
  });
}

/** Same-origin assistant API backed by the managed local AI sidecar. */
export function assistantApiIntegration(): Plugin {
  return {
    name: 'l2chart-assistant-api',
    configureServer(server) {
      installProxy(server, server.middlewares);
    },
    configurePreviewServer(server) {
      installProxy(undefined, server.middlewares);
    },
  };
}
