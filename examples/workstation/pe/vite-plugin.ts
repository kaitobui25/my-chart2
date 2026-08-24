import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { resolveStockdataDbPath } from '../stockdata/db-path';
import {
  PeDatabaseError,
  PeInputError,
  readQuarterlyPeFromSqlite,
} from './sqlite-reader';

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

function installPeRoute(middlewares: {
  use(route: string, handler: (req: IncomingMessage, res: ServerResponse) => void): void;
}): void {
  const dbPath = resolveStockdataDbPath();
  middlewares.use('/pe-quarterly-api', (req, res) => {
    void (async () => {
      if (!isAllowedBrowserRequest(req)) {
        sendJson(res, 403, { error: 'Cross-site requests are not allowed' });
        return;
      }
      if ((req.method || 'GET') !== 'GET') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }

      const local = new URL(req.url || '/', 'http://127.0.0.1');
      try {
        sendJson(
          res,
          200,
          await readQuarterlyPeFromSqlite(dbPath, local.searchParams.get('symbol') ?? ''),
        );
      } catch (error) {
        if (error instanceof PeInputError) {
          sendJson(res, 400, { error: error.message });
          return;
        }
        const detail = error instanceof PeDatabaseError || error instanceof Error
          ? error.message
          : String(error);
        sendJson(res, 503, { error: detail });
      }
    })();
  });
}

export function peIntegration(): Plugin {
  return {
    name: 'l2chart-pe-quarterly-sqlite',
    configureServer(server) {
      installPeRoute(server.middlewares);
    },
    configurePreviewServer(server) {
      installPeRoute(server.middlewares);
    },
  };
}
