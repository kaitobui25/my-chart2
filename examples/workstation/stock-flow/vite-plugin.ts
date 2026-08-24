import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import {
  readInstitutionalFlowFromSqlite,
  resolveStockdataDbPath,
  StockFlowDatabaseError,
  StockFlowInputError,
} from './sqlite-reader';

const STOCKDATA_TARGET = (process.env.STOCKDATA_WEB_URL || 'http://127.0.0.1:8765').replace(/\/$/, '');
const MAIN_MODULE_SUFFIX = '/examples/workstation/main.ts';

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

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
}

function proxyStockdata(
  req: IncomingMessage,
  res: ServerResponse,
  upstreamUrl: string,
  allowedMethods: readonly string[],
): void {
  void (async () => {
    if (!isAllowedBrowserRequest(req)) {
      sendJson(res, 403, { error: 'Cross-site requests are not allowed' });
      return;
    }
    const method = req.method || 'GET';
    if (!allowedMethods.includes(method)) {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    try {
      const body = await readBody(req);
      const upstream = await fetch(upstreamUrl, {
        method,
        headers: body ? { 'Content-Type': req.headers['content-type'] || 'application/json' } : undefined,
        body,
        signal: AbortSignal.timeout(15_000),
      });
      res.statusCode = upstream.status;
      res.setHeader(
        'content-type',
        upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
      );
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
}

function serveInstitutionalFlow(req: IncomingMessage, res: ServerResponse, dbPath: string): void {
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
      const payload = await readInstitutionalFlowFromSqlite(
        dbPath,
        local.searchParams.get('symbol') ?? '',
        local.searchParams.get('from') ?? '',
        local.searchParams.get('to') ?? '',
      );
      sendJson(res, 200, payload);
    } catch (error) {
      if (error instanceof StockFlowInputError) {
        sendJson(res, 400, { error: error.message });
        return;
      }
      const detail = error instanceof StockFlowDatabaseError || error instanceof Error
        ? error.message
        : String(error);
      sendJson(res, 503, { error: detail });
    }
  })();
}

function installStockdataRoutes(middlewares: {
  use(route: string, handler: (req: IncomingMessage, res: ServerResponse) => void): void;
}): void {
  // P/E still uses stockdata-web for its SQLite cache. Institutional Flow does not.
  middlewares.use('/stockdata-api', (req, res) => {
    const local = new URL(req.url || '/', 'http://127.0.0.1');
    proxyStockdata(
      req,
      res,
      `${STOCKDATA_TARGET}/api${local.pathname}${local.search}`,
      ['GET', 'POST'],
    );
  });

  const stockdataDbPath = resolveStockdataDbPath();
  middlewares.use('/stock-flow-api', (req, res) => {
    serveInstitutionalFlow(req, res, stockdataDbPath);
  });
}

function replaceRequired(code: string, needle: string, replacement: string): string {
  if (!code.includes(needle)) {
    throw new Error(`Stock-flow integration marker is missing: ${needle.slice(0, 100)}`);
  }
  return code.replace(needle, replacement);
}

function integrateStockFlowMain(original: string): string {
  let code = original;

  code = replaceRequired(
    code,
    "import { registerAllIndicators } from '../../src/indicators/all';",
    "import { registerAllIndicators } from '../../src/indicators/all';\nimport { onIndicatorRuntimeParamPatch, setIndicatorChartProvider } from '../../src/indicators/runtime-context';",
  );

  code = replaceRequired(
    code,
    '    this.chart = new L2Chart(chartEl, { theme: this.resolvedTheme() });\n    this.applyPricePrecision();',
    `    this.chart = new L2Chart(chartEl, { theme: this.resolvedTheme() });
    setIndicatorChartProvider(this.chart, providerEnabled ? activeProvider : '');
    this.applyPricePrecision();`,
  );

  code = replaceRequired(
    code,
    `    this.chart.onIndicatorSettings((id) => {
      if (!this.active.has(id)) return;
      setActiveTile(this);
      openParamDialog(id);
    });`,
    `    this.chart.onIndicatorSettings((id) => {
      if (!this.active.has(id)) return;
      setActiveTile(this);
      openParamDialog(id);
    });
    onIndicatorRuntimeParamPatch(this.chart, (id, patch) => {
      if (!this.active.has(id)) return;
      const current = this.paramsById.get(id) ?? {};
      this.paramsById.set(id, { ...current, ...patch });
      this.persistPreferences();
    });`,
  );

  code = replaceRequired(
    code,
    `  setReplayData(candles: readonly Candle[], currentTime: number): void {
    const data = candles.map((candle) => ({ ...candle }));
    this.chart.setIntervalSec(intervalApproxSeconds(this.interval));`,
    `  setReplayData(candles: readonly Candle[], currentTime: number): void {
    const data = candles.map((candle) => ({ ...candle }));
    setIndicatorChartProvider(this.chart, providerEnabled ? activeProvider : '');
    this.chart.setIntervalSec(intervalApproxSeconds(this.interval));`,
  );

  code = replaceRequired(
    code,
    `      const renderHistory = (candles: Candle[], fitContent: boolean) => {
        this.chart.setIntervalSec(step);`,
    `      const renderHistory = (candles: Candle[], fitContent: boolean) => {
        setIndicatorChartProvider(this.chart, providerEnabled ? activeProvider : '');
        this.chart.setIntervalSec(step);`,
  );

  code = replaceRequired(
    code,
    'function refreshIndicatorLibrary(): void {',
    `function stockFlowUiEligible(tile: Tile | null = activeTile): boolean {
  return Boolean(tile && providerEnabled && activeProvider === 'vnstock' && tile.interval === '1M');
}

function refreshIndicatorLibrary(): void {`,
  );

  code = replaceRequired(
    code,
    "    const id = row.dataset.indicatorId ?? '';\n    const category = row.dataset.indicatorCategory ?? '';",
    `    const id = row.dataset.indicatorId ?? '';
    if (id === 'institutional-flow') {
      const disabled = !stockFlowUiEligible();
      row.classList.toggle('disabled', disabled);
      row.style.opacity = disabled ? '0.45' : '';
      row.setAttribute('aria-disabled', String(disabled));
      row.querySelectorAll<HTMLButtonElement>('button').forEach((control) => {
        control.disabled = disabled;
      });
    }
    const category = row.dataset.indicatorCategory ?? '';`,
  );

  code = replaceRequired(
    code,
    `indicatorDetailToggle.addEventListener('click', () => {
  activeTile?.toggleIndicator(selectedIndicatorId);
  refreshToolbar();
});`,
    `indicatorDetailToggle.addEventListener('click', () => {
  if (selectedIndicatorId === 'institutional-flow' && !stockFlowUiEligible()) return;
  activeTile?.toggleIndicator(selectedIndicatorId);
  refreshToolbar();
});`,
  );

  code = replaceRequired(
    code,
    '  const definitions = [',
    `  const stockFlowSection = document.createElement('section');
  stockFlowSection.className = 'toolbar-more-settings toolbar-more-stock-flow';
  const stockFlowTitle = document.createElement('strong');
  stockFlowTitle.textContent = 'Dòng tiền tổ chức';
  const stockFlowRow = document.createElement('div');
  stockFlowRow.className = 'toolbar-more-setting-row';
  const stockFlowText = document.createElement('span');
  const stockFlowToggle = document.createElement('button');
  stockFlowToggle.type = 'button';
  stockFlowToggle.className = 'toolbar-more-switch';
  stockFlowToggle.setAttribute('role', 'switch');
  stockFlowToggle.setAttribute('aria-label', 'Dòng tiền tổ chức');
  stockFlowRow.append(stockFlowText, stockFlowToggle);
  stockFlowSection.append(stockFlowTitle, stockFlowRow);

  const renderStockFlowSettings = () => {
    const tile = activeTile;
    const eligible = stockFlowUiEligible(tile);
    const active = Boolean(eligible && tile?.active.has('institutional-flow'));
    stockFlowToggle.disabled = !eligible;
    stockFlowToggle.classList.toggle('on', active);
    stockFlowToggle.setAttribute('aria-checked', String(active));
    stockFlowToggle.title = eligible
      ? 'Bật/tắt dòng tiền khối ngoại và tự doanh trên chart tháng'
      : 'Chỉ khả dụng khi dùng nguồn Vnstock và khung 1M';
    stockFlowText.textContent = eligible ? 'Hiển thị trên chart 1M' : 'Vnstock · 1M';
  };

  stockFlowToggle.addEventListener('click', () => {
    if (!stockFlowUiEligible() || !activeTile) return;
    setIndicatorChartProvider(activeTile.chart, 'vnstock');
    activeTile.toggleIndicator('institutional-flow');
    refreshToolbar();
    renderStockFlowSettings();
  });

  const definitions = [`,
  );

  code = replaceRequired(
    code,
    '    renderReplaySettings();\n    menu.appendChild(replaySettings);',
    `    renderReplaySettings();
    menu.appendChild(replaySettings);
    renderStockFlowSettings();
    menu.appendChild(stockFlowSection);`,
  );

  code = replaceRequired(
    code,
    `  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = menu.hidden;`,
    `  button.addEventListener('click', (event) => {
    event.stopPropagation();
    renderStockFlowSettings();
    const open = menu.hidden;`,
  );

  return code;
}

export function stockFlowIntegration(): Plugin {
  return {
    name: 'l2chart-stock-flow-integration',
    // The scanner/Vnstock integration rewrites workstation UI blocks. Run first
    // so our stable source markers are still present; later transforms then see
    // the already-injected stock-flow controls.
    enforce: 'pre',
    configureServer(server) {
      installStockdataRoutes(server.middlewares);
    },
    configurePreviewServer(server) {
      installStockdataRoutes(server.middlewares);
    },
    transform(code, id) {
      const normalizedId = id.split('?')[0].replace(/\\/g, '/');
      if (!normalizedId.endsWith(MAIN_MODULE_SUFFIX)) return null;
      return { code: integrateStockFlowMain(code), map: null };
    },
  };
}
