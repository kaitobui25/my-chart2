import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

const STOCKDATA_TARGET = (process.env.STOCKDATA_WEB_URL || 'http://127.0.0.1:8765').replace(/\/$/, '');

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
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

async function readBody(req: IncomingMessage): Promise<Uint8Array | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return chunks.length ? new Uint8Array(Buffer.concat(chunks)) : undefined;
}

function installStockdataCacheProxy(middlewares: {
  use(route: string, handler: (req: IncomingMessage, res: ServerResponse) => void): void;
}): void {
  middlewares.use('/stockdata-api', (req, res) => {
    void (async () => {
      if (!isAllowedBrowserRequest(req)) {
        sendJson(res, 403, { error: 'Cross-site requests are not allowed' });
        return;
      }
      try {
        const local = new URL(req.url || '/', 'http://127.0.0.1');
        const body = await readBody(req);
        const upstream = await fetch(`${STOCKDATA_TARGET}/api${local.pathname}${local.search}`, {
          method: req.method,
          headers: body ? { 'Content-Type': req.headers['content-type'] || 'application/json' } : undefined,
          body,
          signal: AbortSignal.timeout(15_000),
        });
        res.statusCode = upstream.status;
        res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch (error) {
        sendJson(res, 503, {
          error: `Stockdata web is offline at ${STOCKDATA_TARGET}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    })();
  });
}

export function stockdataCacheProxy(): Plugin {
  return {
    name: 'l2chart-stockdata-cache-proxy',
    configureServer(server) {
      installStockdataCacheProxy(server.middlewares);
    },
    configurePreviewServer(server) {
      installStockdataCacheProxy(server.middlewares);
    },
  };
}
