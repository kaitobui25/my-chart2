import { createHmac, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite';
import { fiinQuantProxyToken, providerRuntimeIntegration } from './provider-runtime/vite-plugin';
import { scannerIntegration } from './scanner/vite-plugin';
import { stockFlowIntegration } from './stock-flow/vite-plugin';
import { stockdataCacheProxy } from './stockdata-cache/vite-plugin';

const DNSE_REST_TARGET = 'https://openapi.dnse.com.vn';
const ASSISTANT_TARGET = 'http://127.0.0.1:8788';
const WORKSTATION_ROOT = fileURLToPath(new URL('.', import.meta.url));
const MAIN_MODULE_SUFFIX = '/examples/workstation/main.ts';
const ACTIVE_TILE_MARKER = 'let activeTile: Tile | null = null;';
const ASSISTANT_OFFLINE_DETAIL = 'AI sidecar is offline. Restart npm run dev and check the terminal for startup errors.';

interface DnseProxyCredentials {
  apiKey: string;
  apiSecret: string;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatDateHeader(date: Date): string {
  return `${DAY_NAMES[date.getUTCDay()]}, ${pad2(date.getUTCDate())} ${
    MONTH_NAMES[date.getUTCMonth()]
  } ${date.getUTCFullYear()} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(
    date.getUTCSeconds(),
  )} +0000`;
}

function dnseSignatureHeaders(
  apiKey: string,
  apiSecret: string,
  method: string,
  path: string,
): Record<string, string> {
  const dateValue = formatDateHeader(new Date());
  const nonce = randomUUID().replace(/-/g, '');
  const signingString = `(request-target): ${method.toLowerCase()} ${path}\ndate: ${dateValue}\nnonce: ${nonce}`;
  const signature = encodeURIComponent(createHmac('sha256', apiSecret).update(signingString, 'utf8').digest('base64'));
  return {
    Date: dateValue,
    'X-Signature': `Signature keyId="${apiKey}",algorithm="hmac-sha256",headers="(request-target) date",signature="${signature}",nonce="${nonce}"`,
    'x-api-key': apiKey,
  };
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

function isLoopbackClient(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '';
  return address === '127.0.0.1' || address === '::1';
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

function dnseCredentialsFromRequest(req: IncomingMessage, credentials: DnseProxyCredentials): DnseProxyCredentials | null {
  if (isLoopbackClient(req) && credentials.apiKey && credentials.apiSecret) {
    return credentials;
  }
  const values = [req.headers['x-dnse-api-key'], req.headers['x-dnse-api-secret']];
  if (!values.every((value) => typeof value === 'string' && value.length > 0)) return null;
  const [apiKey, apiSecret] = values as [string, string];
  return { apiKey, apiSecret };
}

function installDnseRestProxy(middlewares: {
  use(route: string, handler: (req: IncomingMessage, res: ServerResponse) => void): void;
}, credentials: DnseProxyCredentials): void {
  middlewares.use('/dnse-auth', (req, res) => {
    if (!isAllowedBrowserRequest(req)) {
      sendJson(res, 403, { message: 'Cross-site requests are not allowed' });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { message: 'Method not allowed' });
      return;
    }

    const resolved = dnseCredentialsFromRequest(req, credentials);
    if (!resolved) {
      sendJson(res, 401, { message: 'Missing DNSE API Key/Secret in request headers or workstation .env' });
      return;
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = String(Date.now() * 1000);
    const message = `${resolved.apiKey}:${timestamp}:${nonce}`;
    res.setHeader('cache-control', 'no-store');
    sendJson(res, 200, {
      action: 'auth',
      api_key: resolved.apiKey,
      signature: createHmac('sha256', resolved.apiSecret).update(message, 'utf8').digest('hex'),
      timestamp,
      nonce,
    });
  });

  middlewares.use('/dnse-api', async (req, res) => {
    if (!isAllowedBrowserRequest(req)) {
      sendJson(res, 403, { message: 'Cross-site requests are not allowed' });
      return;
    }
    try {
      const resolved = dnseCredentialsFromRequest(req, credentials);
      if (!resolved) {
        sendJson(res, 401, { message: 'Missing DNSE API Key/Secret in request headers or workstation .env' });
        return;
      }

      const rawUrl = req.url || '/';
      const localUrl = new URL(rawUrl, 'http://127.0.0.1');
      const dnsePath = localUrl.pathname;
      const dnseUrl = `${DNSE_REST_TARGET}${dnsePath}${localUrl.search}`;
      const body = await readBody(req);
      const headers: Record<string, string> = {
        ...dnseSignatureHeaders(resolved.apiKey, resolved.apiSecret, req.method || 'GET', dnsePath),
      };
      if (body && body.length > 0) headers['Content-Type'] = req.headers['content-type'] || 'application/json';

      const upstream = await fetch(dnseUrl, {
        method: req.method,
        headers,
        body: body ? new Uint8Array(body) : undefined,
      });
      res.statusCode = upstream.status;
      upstream.headers.forEach((value, key) => {
        if (!['content-encoding', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      sendJson(res, 502, { message: err instanceof Error ? err.message : 'DNSE proxy error' });
    }
  });
}

function dnseRestProxy(credentials: DnseProxyCredentials): Plugin {
  return {
    name: 'l2chart-dnse-rest-proxy',
    configureServer(server) {
      installDnseRestProxy(server.middlewares, credentials);
    },
    configurePreviewServer(server) {
      installDnseRestProxy(server.middlewares, credentials);
    },
  };
}

function forwardedHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value || ['connection', 'content-length', 'host'].includes(key.toLowerCase())) continue;
    headers[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

function sendAssistantOffline(req: IncomingMessage, res: ServerResponse): void {
  const path = new URL(req.url || '/', 'http://127.0.0.1').pathname;
  if (req.method === 'GET' && path === '/health') {
    sendJson(res, 200, { ok: true, codexAvailable: false, detail: ASSISTANT_OFFLINE_DETAIL });
    return;
  }
  if (req.method === 'GET' && path === '/options') {
    sendJson(res, 200, { models: [], reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] });
    return;
  }
  sendJson(res, 503, { error: ASSISTANT_OFFLINE_DETAIL, code: 'SIDECAR_OFFLINE' });
}

function installAssistantApiProxy(middlewares: {
  use(route: string, handler: (req: IncomingMessage, res: ServerResponse) => void): void;
}): void {
  middlewares.use('/assistant-api', async (req, res) => {
    if (!isAllowedBrowserRequest(req)) {
      sendJson(res, 403, { error: 'Cross-site requests are not allowed', code: 'FORBIDDEN' });
      return;
    }

    try {
      const rawUrl = req.url || '/';
      const localUrl = new URL(rawUrl, 'http://127.0.0.1');
      const targetUrl = `${ASSISTANT_TARGET}${localUrl.pathname}${localUrl.search}`;
      const body = await readBody(req);
      const response = await fetch(targetUrl, {
        method: req.method,
        headers: forwardedHeaders(req),
        body: body ? new Uint8Array(body) : undefined,
      });
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        if (!['connection', 'content-encoding', 'transfer-encoding'].includes(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      });
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      sendAssistantOffline(req, res);
    }
  });
}

function assistantApiProxy(): Plugin {
  return {
    name: 'l2chart-assistant-api-proxy',
    configureServer(server) {
      installAssistantApiProxy(server.middlewares);
    },
    configurePreviewServer(server) {
      installAssistantApiProxy(server.middlewares);
    },
  };
}

function assistantIntegration(): Plugin {
  return {
    name: 'l2chart-assistant-integration',
    enforce: 'pre',
    transform(code, id) {
      const normalizedId = id.split('?')[0].replace(/\\/g, '/');
      if (!normalizedId.endsWith(MAIN_MODULE_SUFFIX)) return null;
      if (!code.includes(ACTIVE_TILE_MARKER)) {
        throw new Error('L2Chart assistant integration marker is missing. Update vite.config.ts for the new workstation structure.');
      }

      const bridge = `
window.__L2CHART_ASSISTANT__ = Object.freeze({
  getContext() {
    const tile = activeTile;
    if (!tile) return null;
    const candles = tile.chart.getCandles().slice(-240).map((candle) => ({
      time: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      ...(candle.volume === undefined ? {} : { volume: candle.volume }),
    }));
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      symbol: tile.symbol,
      timeframe: tile.interval,
      mode: tile.mode,
      replay: tile.getReplayInfo(),
      historyRange: tile.getHistoryRange(),
      candleCount: candles.length,
      candles,
      indicators: [...tile.active.keys()].map((id) => ({ id, params: tile.getParams(id) })),
    };
  },
});
`;
      return { code: `${code}\n${bridge}`, map: null };
    },
    transformIndexHtml() {
      return [{
        tag: 'script',
        attrs: { type: 'module', src: '/assistant/index.ts' },
        injectTo: 'body',
      }];
    },
  };
}

function providerProxy(fiinQuantSidecarToken: string): Record<string, string | ProxyOptions> {
  const localOnly = (request: IncomingMessage, response: ServerResponse | undefined) => {
    if (isAllowedBrowserRequest(request)) return;
    if (response) sendJson(response, 403, { message: 'Cross-site requests are not allowed' });
    return false;
  };
  return {
    '/fiinquant-api': {
      target: 'http://127.0.0.1:8720',
      changeOrigin: true,
      ws: true,
      rewrite: (path) => path.replace(/^\/fiinquant-api/, ''),
      bypass: localOnly,
      configure(proxy) {
        const addServerToken = (proxyRequest: { setHeader(name: string, value: string): void }, request: IncomingMessage) => {
          if (fiinQuantSidecarToken && isLoopbackClient(request) && isAllowedBrowserRequest(request)) {
            proxyRequest.setHeader('X-L2Chart-Sidecar-Token', fiinQuantSidecarToken);
          }
        };
        proxy.on('proxyReq', addServerToken);
        proxy.on('proxyReqWs', addServerToken);
      },
    },
    '/binance-spot-api': {
      target: 'https://data-api.binance.vision',
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/binance-spot-api/, ''),
      bypass: localOnly,
    },
    '/binance-spot-fallback-api': {
      target: 'https://api.binance.com',
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/binance-spot-fallback-api/, ''),
      bypass: localOnly,
    },
    '/binance-usdm-api': {
      target: 'https://fapi.binance.com',
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/binance-usdm-api/, ''),
      bypass: localOnly,
    },
    '/dnse-ws': {
      target: 'wss://ws-openapi.dnse.com.vn',
      changeOrigin: true,
      ws: true,
      rewrite: (path) => path.replace(/^\/dnse-ws/, ''),
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, WORKSTATION_ROOT, '');
  const credentials = {
    apiKey: env.DNSE_API_KEY?.trim() ?? '',
    apiSecret: env.DNSE_API_SECRET?.trim() ?? '',
  };
  const proxies = providerProxy(fiinQuantProxyToken());
  return {
    root: WORKSTATION_ROOT,
    plugins: [
      providerRuntimeIntegration(),
      dnseRestProxy(credentials),
      assistantApiProxy(),
      assistantIntegration(),
      scannerIntegration(),
      stockdataCacheProxy(),
      stockFlowIntegration(),
    ],
    build: {
      outDir: '../../dist',
      emptyOutDir: true,
    },
    server: {
      host: '127.0.0.1',
      port: 53173,
      strictPort: true,
      proxy: proxies,
    },
    preview: {
      proxy: proxies,
    },
  };
});
