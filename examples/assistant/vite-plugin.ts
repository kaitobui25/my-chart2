import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin, ViteDevServer } from 'vite';

const API_ROUTE = '/assistant-api';
const SIDECAR_HOST = '127.0.0.1';
const SIDECAR_PORT = 8788;
const SIDECAR_TARGET = `http://${SIDECAR_HOST}:${SIDECAR_PORT}`;
const SIDECAR_SCRIPT = fileURLToPath(new URL('../sidecars/assistant/server.mjs', import.meta.url));
const SIDECAR_CWD = resolve(dirname(SIDECAR_SCRIPT), '../../..');

let sidecarChild: ChildProcess | null = null;
let sidecarStarting: Promise<boolean> | null = null;

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

async function serviceIsHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${SIDECAR_TARGET}/health`, { signal: AbortSignal.timeout(900) });
    return response.ok && (await response.json())?.ok === true;
  } catch {
    return false;
  }
}

async function waitForHealth(attempts = 40): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await serviceIsHealthy()) return true;
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

async function ensureSidecar(server?: ViteDevServer): Promise<boolean> {
  if (await serviceIsHealthy()) return true;
  if (!sidecarStarting) {
    sidecarStarting = startSidecar(server).finally(() => {
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
    if (!(await ensureSidecar(server))) {
      sendJson(res, 503, { error: 'AI sidecar failed to start.', code: 'SIDECAR_OFFLINE' });
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

/** Same-origin assistant API backed by the managed local Codex sidecar. */
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
