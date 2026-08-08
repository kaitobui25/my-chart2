import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

const SCANNER_TARGET = 'http://127.0.0.1:8730';
const MAIN_MODULE_SUFFIX = '/examples/workstation/main.ts';
const ACTIVE_TILE_MARKER = 'let activeTile: Tile | null = null;';

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

function installScannerProxy(middlewares: {
  use(route: string, handler: (req: IncomingMessage, res: ServerResponse) => void): void;
}): void {
  middlewares.use('/scanner-api', async (req, res) => {
    if (!isAllowedBrowserRequest(req)) {
      sendJson(res, 403, { message: 'Cross-site requests are not allowed' });
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
      installScannerProxy(server.middlewares);
    },
    configurePreviewServer(server) {
      installScannerProxy(server.middlewares);
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
  openSymbol(source, symbol) {
    const providerMap = {
      fiinquant: 'fiinquant',
      binance_spot: 'binance-spot',
      binance_usdm: 'binance-usdm',
    };
    const targetProvider = providerMap[String(source ?? '')];
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
