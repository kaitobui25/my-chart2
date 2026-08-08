import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_URL = 'http://127.0.0.1:53174';
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_BODY_CHARS = 200_000;
const SECRET_KEY = /(password|secret|token|authorization|cookie|api[-_]?key)/i;

function parseArgs(argv) {
  const result = { baseUrl: DEFAULT_URL, headed: false, timeoutMs: DEFAULT_TIMEOUT_MS, skipBinance: false };
  for (const arg of argv) {
    if (arg === '--headed') result.headed = true;
    else if (arg === '--skip-binance') result.skipBinance = true;
    else if (arg.startsWith('--timeout=')) result.timeoutMs = Math.max(10_000, Number(arg.slice('--timeout='.length)) || DEFAULT_TIMEOUT_MS);
    else if (!arg.startsWith('--')) result.baseUrl = arg;
  }
  result.baseUrl = result.baseUrl.replace(/\/$/, '');
  return result;
}

function stamp() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

function safeValue(value, key = '') {
  if (SECRET_KEY.test(key)) return '<redacted>';
  if (Array.isArray(value)) return value.map((item) => safeValue(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) out[childKey] = safeValue(childValue, childKey);
    return out;
  }
  if (typeof value === 'string') {
    return value
      .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1<redacted>')
      .replace(/((?:password|secret|token|api[-_]?key)\s*[=:]\s*)[^\s&]+/gi, '$1<redacted>');
  }
  return value;
}

function truncate(text, max = MAX_BODY_CHARS) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max)}\n... <truncated ${value.length - max} chars>`;
}

function parseMaybeJson(text) {
  try { return JSON.parse(text); } catch { return truncate(text); }
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(safeValue(value), null, 2)}\n`, 'utf8');
}

function execText(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    return `<failed: ${error instanceof Error ? error.message : String(error)}>`;
  }
}

async function envPresence() {
  const envPath = path.join(REPO_ROOT, 'examples', 'sidecars', 'fiinquant', '.env');
  const present = {
    path: path.relative(REPO_ROOT, envPath),
    exists: existsSync(envPath),
    FIINQUANT_USERNAME: false,
    FIINQUANT_PASSWORD: false,
    SIDECAR_TOKEN: false,
  };
  if (!present.exists) return present;

  const content = await readFile(envPath, 'utf8');
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  for (const key of ['FIINQUANT_USERNAME', 'FIINQUANT_PASSWORD', 'SIDECAR_TOKEN']) {
    present[key] = Boolean(values[key]);
  }
  return present;
}

function windowsPortSnapshot() {
  if (process.platform !== 'win32') {
    return { platform: process.platform, note: 'Windows port process snapshot skipped.' };
  }
  const script = [
    "$ports = @(53174,8720,8730)",
    "$listeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort }",
    "$rows = foreach ($item in $listeners) {",
    "  $p = Get-Process -Id $item.OwningProcess -ErrorAction SilentlyContinue",
    "  [PSCustomObject]@{ Port=$item.LocalPort; Address=$item.LocalAddress; PID=$item.OwningProcess; Process=if($p){$p.ProcessName}else{$null}; Path=if($p){$p.Path}else{$null} }",
    "}",
    "$rows | ConvertTo-Json -Depth 4 -Compress",
  ].join('; ');
  const raw = execText('powershell.exe', ['-NoProfile', '-Command', script]);
  try { return JSON.parse(raw || '[]'); } catch { return { raw }; }
}

function monitoredUrl(url) {
  return url.includes('/scanner-api') || url.includes('/fiinquant-api') || url.includes(':8720/') || url.includes(':8730/');
}

async function browserFetch(page, baseUrl, pathname, init = {}) {
  return page.evaluate(async ({ baseUrl: root, pathname: target, init: requestInit }) => {
    const response = await fetch(`${root}${target}`, requestInit);
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return {
      status: response.status,
      ok: response.ok,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    };
  }, { baseUrl, pathname, init });
}

async function pollRun(page, baseUrl, runId, timeoutMs, trace) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const probe = await browserFetch(page, baseUrl, `/scanner-api/runs/${runId}`);
    trace.push({ at: new Date().toISOString(), ...probe });
    const status = probe?.body?.status;
    if (status === 'complete' || status === 'error') return probe;
    await page.waitForTimeout(750);
  }
  return {
    status: 0,
    ok: false,
    body: { status: 'audit-timeout', message: `Run ${runId} did not finish within ${timeoutMs}ms` },
  };
}

function scanPayload(source) {
  if (source === 'fiinquant') {
    return {
      source,
      universes: ['HOSE'],
      filters: {
        priceMin: 10_000,
        priceMax: null,
        volumeMin: 1_000_000,
        volumeMax: null,
        marketCapMin: null,
        marketCapMax: null,
      },
      heikinAshi: {
        timeframe: '1w',
        green: false,
        noLowerWick: false,
        closeChangePctMin: null,
        candle: 'current',
      },
    };
  }
  return {
    source,
    universes: ['USDT'],
    filters: {
      priceMin: 1_000,
      priceMax: null,
      volumeMin: 100,
      volumeMax: null,
      marketCapMin: null,
      marketCapMax: null,
    },
    heikinAshi: {
      timeframe: '1w',
      green: false,
      noLowerWick: false,
      closeChangePctMin: null,
      candle: 'current',
    },
  };
}

async function runApiScan(page, baseUrl, source, timeoutMs) {
  const payload = scanPayload(source);
  const start = await browserFetch(page, baseUrl, '/scanner-api/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const trace = [{ at: new Date().toISOString(), phase: 'start', request: payload, response: start }];
  const runId = Number(start?.body?.runId);
  if (!Number.isInteger(runId) || runId <= 0) return { payload, start, trace, final: null };
  const final = await pollRun(page, baseUrl, runId, timeoutMs, trace);
  return { payload, start, trace, final };
}

async function runFiinUiScan(page, baseUrl, timeoutMs) {
  const result = {
    attempted: false,
    reason: null,
    sourceOptions: [],
    startResponse: null,
    final: null,
    progressText: null,
  };
  await page.locator('#scanner-toggle').waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('#scanner-toggle').click();
  await page.locator('#scanner-overlay').waitFor({ state: 'visible', timeout: 10_000 });

  result.sourceOptions = await page.locator('#scanner-source option').evaluateAll((options) => options.map((option) => ({
    value: option.value,
    text: option.textContent,
    disabled: option.disabled,
    selected: option.selected,
  })));
  const fiinOption = result.sourceOptions.find((item) => item.value === 'fiinquant');
  if (!fiinOption || fiinOption.disabled) {
    result.reason = fiinOption ? 'FiinQuant option is disabled in Scanner UI.' : 'FiinQuant option is absent from Scanner UI.';
    return result;
  }

  result.attempted = true;
  await page.locator('#scanner-source').selectOption('fiinquant');
  const universeChecks = page.locator('#scanner-universe input[type="checkbox"]');
  const count = await universeChecks.count();
  for (let index = 0; index < count; index += 1) {
    const check = universeChecks.nth(index);
    const value = await check.getAttribute('value');
    if (value === 'HOSE') await check.check();
    else await check.uncheck();
  }
  await page.locator('#scanner-price-min').fill('10000');
  await page.locator('#scanner-price-max').fill('');
  await page.locator('#scanner-volume-min').fill('1000000');
  await page.locator('#scanner-volume-max').fill('');
  await page.locator('input[name="scanner-ha-timeframe"][value="1w"]').check();
  await page.locator('input[name="scanner-candle-kind"][value="current"]').check();
  await page.locator('#scanner-green').uncheck();
  await page.locator('#scanner-no-lower').uncheck();
  await page.locator('#scanner-ha-change').fill('');

  const responsePromise = page.waitForResponse(
    (response) => response.url().includes('/scanner-api/scan') && response.request().method() === 'POST',
    { timeout: 15_000 },
  );
  await page.locator('#scanner-run').click();
  const response = await responsePromise;
  const text = await response.text();
  result.startResponse = { status: response.status(), body: parseMaybeJson(text) };
  const runId = Number(result.startResponse?.body?.runId);
  if (Number.isInteger(runId) && runId > 0) {
    result.final = await pollRun(page, baseUrl, runId, timeoutMs, []);
  }
  result.progressText = await page.locator('#scanner-progress').innerText().catch(() => null);
  return result;
}

function inferSummary(probes, ui, apiFiin) {
  const lines = [];
  const chartHealth = probes.browser['/fiinquant-api/health'];
  const scannerSources = probes.browser['/scanner-api/sources'];
  const fiinSource = scannerSources?.body?.sources?.find?.((source) => source.id === 'fiinquant');
  lines.push(`- Chart FiinQuant health HTTP: ${chartHealth?.status ?? 'n/a'}`);
  lines.push(`- Chart FiinQuant loggedIn: ${chartHealth?.body?.loggedIn ?? 'n/a'}`);
  lines.push(`- Scanner FiinQuant available: ${fiinSource?.available ?? 'n/a'}`);
  lines.push(`- Scanner FiinQuant detail: ${fiinSource?.detail ?? 'n/a'}`);
  lines.push(`- Scanner UI FiinQuant disabled: ${ui?.sourceOptions?.find?.((item) => item.value === 'fiinquant')?.disabled ?? 'n/a'}`);
  lines.push(`- FiinQuant scan POST HTTP: ${apiFiin?.start?.status ?? ui?.startResponse?.status ?? 'n/a'}`);

  const finalBody = apiFiin?.final?.body ?? ui?.final?.body;
  if (finalBody) {
    lines.push(`- Final scan status: ${finalBody.status ?? 'n/a'}`);
    lines.push(`- Counts: universe=${finalBody.universe_count ?? 0}, stage1=${finalBody.stage1_count ?? 0}, history=${finalBody.history_refresh_count ?? 0}, HA=${finalBody.stage2_count ?? 0}, matched=${finalBody.result_count ?? 0}`);
    if (finalBody.error) lines.push(`- Error: ${finalBody.error}`);
    if (finalBody.warnings?.length) lines.push(`- Warnings: ${finalBody.warnings.join(' | ')}`);
  }
  if (chartHealth?.body?.loggedIn === true && fiinSource?.available === false) {
    lines.push('- Strong signal: chart session is logged in while scanner provider is unavailable. Inspect scanner credential/session separation first.');
  }
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputDir = path.join(REPO_ROOT, 'agent', 'audit', 'scanner-fiinquant', stamp());
  await mkdir(outputDir, { recursive: true });

  const environment = {
    generatedAt: new Date().toISOString(),
    baseUrl: options.baseUrl,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    git: {
      branch: execText('git', ['branch', '--show-current']),
      head: execText('git', ['rev-parse', 'HEAD']),
      status: execText('git', ['status', '--short']),
    },
    ports: windowsPortSnapshot(),
    fiinquantEnv: await envPresence(),
  };
  const scannerDb = path.join(REPO_ROOT, 'examples', 'sidecars', 'scanner', 'data', 'scanner.db');
  if (existsSync(scannerDb)) {
    const info = await stat(scannerDb);
    environment.scannerDb = { exists: true, size: info.size, mtime: info.mtime.toISOString() };
  } else {
    environment.scannerDb = { exists: false };
  }
  await writeJson(path.join(outputDir, 'environment.json'), environment);

  const consoleLog = [];
  const networkLog = [];
  const pageErrors = [];
  const pending = [];
  let browser;
  try {
    browser = await chromium.launch({ headless: !options.headed });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeFile(
      path.join(outputDir, 'PLAYWRIGHT_LAUNCH_FAILED.txt'),
      `${message}\n\nInstall Chromium once with:\n  npx playwright install chromium\n`,
      'utf8',
    );
    console.error(message);
    console.error(`Audit folder: ${outputDir}`);
    process.exitCode = 2;
    return;
  }

  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  page.on('console', (message) => consoleLog.push({
    at: new Date().toISOString(),
    type: message.type(),
    text: truncate(message.text()),
    location: message.location(),
  }));
  page.on('pageerror', (error) => pageErrors.push({
    at: new Date().toISOString(),
    type: 'pageerror',
    message: error.message,
    stack: error.stack,
  }));
  page.on('requestfailed', (request) => {
    if (monitoredUrl(request.url())) {
      pageErrors.push({
        at: new Date().toISOString(),
        type: 'requestfailed',
        method: request.method(),
        url: request.url(),
        failure: request.failure(),
      });
    }
  });
  page.on('request', (request) => {
    if (!monitoredUrl(request.url())) return;
    networkLog.push({
      at: new Date().toISOString(),
      phase: 'request',
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      headers: safeValue(request.headers()),
      postData: truncate(request.postData() ?? ''),
    });
  });
  page.on('response', (response) => {
    if (!monitoredUrl(response.url())) return;
    const task = (async () => {
      let body = '';
      try { body = await response.text(); }
      catch (error) { body = `<unreadable: ${error instanceof Error ? error.message : String(error)}>`; }
      networkLog.push({
        at: new Date().toISOString(),
        phase: 'response',
        method: response.request().method(),
        url: response.url(),
        status: response.status(),
        headers: safeValue(response.headers()),
        body: safeValue(parseMaybeJson(body)),
      });
    })();
    pending.push(task);
  });

  const probes = { browser: {}, direct: {} };
  let uiFiin = null;
  let apiBinance = null;
  let apiFiin = null;
  let fatal = null;
  try {
    await page.goto(options.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(1_500);
    await page.screenshot({ path: path.join(outputDir, '01-workstation.png'), fullPage: true });

    probes.browser['/scanner-api/health'] = await browserFetch(page, options.baseUrl, '/scanner-api/health');
    probes.browser['/scanner-api/sources'] = await browserFetch(page, options.baseUrl, '/scanner-api/sources');
    probes.browser['/fiinquant-api/health'] = await browserFetch(page, options.baseUrl, '/fiinquant-api/health');
    probes.browserState = await page.evaluate(() => ({
      activeProvider: localStorage.getItem('l2chart.priceProvider'),
      scannerPrefsPresent: Boolean(localStorage.getItem('l2chart.scanner.filters.v1')),
      scannerTogglePresent: Boolean(document.getElementById('scanner-toggle')),
    }));

    for (const directUrl of ['http://127.0.0.1:8730/health', 'http://127.0.0.1:8720/health']) {
      try {
        const response = await context.request.get(directUrl, { timeout: 5_000 });
        const text = await response.text();
        probes.direct[directUrl] = { status: response.status(), body: parseMaybeJson(text) };
      } catch (error) {
        probes.direct[directUrl] = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    await writeJson(path.join(outputDir, 'probes.json'), probes);

    await page.locator('#scanner-toggle').click();
    await page.locator('#scanner-overlay').waitFor({ state: 'visible', timeout: 10_000 });
    await page.screenshot({ path: path.join(outputDir, '02-scanner-open.png'), fullPage: true });
    await page.locator('.scanner-close').click().catch(() => {});

    if (!options.skipBinance) {
      apiBinance = await runApiScan(page, options.baseUrl, 'binance_spot', Math.min(options.timeoutMs, 90_000));
      await writeJson(path.join(outputDir, 'scan-binance.json'), apiBinance);
    }

    uiFiin = await runFiinUiScan(page, options.baseUrl, options.timeoutMs);
    await page.screenshot({ path: path.join(outputDir, '03-fiinquant-after-scan.png'), fullPage: true });
    await writeJson(path.join(outputDir, 'scan-fiinquant-ui.json'), uiFiin);

    if (!uiFiin.attempted || !Number.isInteger(Number(uiFiin?.startResponse?.body?.runId))) {
      apiFiin = await runApiScan(page, options.baseUrl, 'fiinquant', options.timeoutMs);
      await writeJson(path.join(outputDir, 'scan-fiinquant-api.json'), apiFiin);
    }
  } catch (error) {
    fatal = {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
    };
    await writeJson(path.join(outputDir, 'fatal.json'), fatal);
    await page.screenshot({ path: path.join(outputDir, '99-fatal.png'), fullPage: true }).catch(() => {});
  } finally {
    await Promise.allSettled(pending);
    await writeJson(path.join(outputDir, 'console.json'), consoleLog);
    await writeJson(path.join(outputDir, 'network.json'), networkLog);
    await writeJson(path.join(outputDir, 'page-errors.json'), pageErrors);
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  const summary = `# FiinQuant scanner runtime audit\n\nGenerated: ${new Date().toISOString()}\n\nTarget: ${options.baseUrl}\n\n## Automatic evidence summary\n\n${inferSummary(probes, uiFiin, apiFiin)}\n\n## Files\n\n- environment.json — Git/ports/.env key presence only; no secret values.\n- probes.json — scanner/chart health comparison.\n- network.json — monitored browser requests/responses.\n- console.json — browser console.\n- page-errors.json — page/request failures.\n- scan-binance.json — Binance smoke scan when enabled.\n- scan-fiinquant-ui.json — FiinQuant UI scan.\n- scan-fiinquant-api.json — fallback direct API scan if UI could not start it.\n- PNG screenshots — visible workstation/scanner state.\n${fatal ? `\n## Fatal audit error\n\n${fatal.message}\n` : ''}\n## Commit this evidence\n\n\`\`\`powershell\ngit add agent/audit/scanner-fiinquant\ngit commit -m "capture fiinquant scanner runtime audit"\ngit push\n\`\`\`\n`;
  await writeFile(path.join(outputDir, 'SUMMARY.md'), summary, 'utf8');
  console.log(`\nAudit complete. Evidence written to:\n${outputDir}\n`);
  console.log(summary);
}

await main();
