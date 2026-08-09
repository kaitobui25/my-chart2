import { lookup } from 'node:dns/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { performance } from 'node:perf_hooks';

const BASE_URL = String(process.env.SSI_BASE_URL || 'https://api.ssi.com.vn').replace(/\/$/, '');
const API_KEY = String(process.env.SSI_API_KEY || '').trim();
const API_SECRET = String(process.env.SSI_API_SECRET || '');
const PROVIDED_ACCESS_TOKEN = String(process.env.SSI_ACCESS_TOKEN || '').trim();
const SYMBOLS = String(process.env.SSI_PROBE_SYMBOLS || 'PGI,SSI')
  .split(',')
  .map((value) => value.trim().toUpperCase())
  .filter(Boolean);
const ITERATIONS = positiveInt(process.env.SSI_PROBE_ITERATIONS, 3);
const TIMEOUT_MS = positiveInt(process.env.SSI_PROBE_TIMEOUT_MS, 10_000);
const GAP_MS = positiveInt(process.env.SSI_PROBE_GAP_MS, 250);
const OUTPUT_PATH = String(
  process.env.SSI_PROBE_OUTPUT || 'agent/experiments/ssi-probe/results/latest.json',
);
const CAPTURE_FULL = process.env.SSI_PROBE_CAPTURE_FULL !== '0';
const PAGE_SIZES = parseInts(process.env.SSI_PROBE_PAGE_SIZES || '10,100,500,1000');
const VIETNAM_TIMEZONE = 'Asia/Ho_Chi_Minh';
const startedAt = new Date();

const DAILY_TO = process.env.SSI_PROBE_DAILY_TO || formatVnDate(startedAt);
const DAILY_FROM = process.env.SSI_PROBE_DAILY_FROM
  || formatVnDate(new Date(startedAt.getTime() - 900 * 86_400_000));
const INTRADAY_TO = process.env.SSI_PROBE_INTRADAY_TO || `${formatVnDate(startedAt)} 23:59:59`;
const INTRADAY_FROM = process.env.SSI_PROBE_INTRADAY_FROM
  || `${formatVnDate(new Date(startedAt.getTime() - 45 * 86_400_000))} 00:00:00`;

const report = {
  schemaVersion: 1,
  purpose: 'Measure real SSI FastConnect latency, paging, rate-limit headers, and OHLC response shape before integrating SSI into my-chart2.',
  startedAt: startedAt.toISOString(),
  finishedAt: null,
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    vietnamTimezone: VIETNAM_TIMEZONE,
    baseUrl: BASE_URL,
    credentialsSource: PROVIDED_ACCESS_TOKEN ? 'SSI_ACCESS_TOKEN' : 'SSI_API_KEY + SSI_API_SECRET',
  },
  config: {
    symbols: SYMBOLS,
    iterations: ITERATIONS,
    timeoutMs: TIMEOUT_MS,
    gapMs: GAP_MS,
    dailyFrom: DAILY_FROM,
    dailyTo: DAILY_TO,
    intradayFrom: INTRADAY_FROM,
    intradayTo: INTRADAY_TO,
    pageSizes: PAGE_SIZES,
    captureFullRepresentativeResponse: CAPTURE_FULL,
  },
  auth: null,
  network: null,
  tests: [],
  boardLists: [],
  stoppedReason: null,
  fatalError: null,
};

let accessToken = PROVIDED_ACCESS_TOKEN;

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseInts(value) {
  return [...new Set(String(value)
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0)
    .map(Math.floor))];
}

function roundMs(value) {
  return Math.round(value * 100) / 100;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatVnDate(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: VIETNAM_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}/${parts.month}/${parts.day}`;
}

function selectedHeaders(headers) {
  const names = [
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
    'content-type',
    'content-length',
    'date',
    'server',
  ];
  return Object.fromEntries(names
    .map((name) => [name, headers.get(name)])
    .filter(([, value]) => value !== null));
}

function sanitize(value, depth = 0) {
  if (depth > 12) return '[MAX_DEPTH]';
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(token|secret|authorization|api.?key|password|otp)/i.test(key)) {
      output[key] = '[REDACTED]';
    } else {
      output[key] = sanitize(item, depth + 1);
    }
  }
  return output;
}

function safeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: String(error.message).replace(API_SECRET, '[REDACTED]').replace(API_KEY, '[REDACTED]'),
      cause: error.cause ? String(error.cause) : undefined,
    };
  }
  return { message: String(error) };
}

async function timedFetch(url, options = {}) {
  const start = performance.now();
  try {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Keep the text preview below when SSI does not return JSON.
    }
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      elapsedMs: roundMs(performance.now() - start),
      headers: selectedHeaders(response.headers),
      bodyBytes: Buffer.byteLength(text),
      json,
      textPreview: json === null ? text.slice(0, 2000) : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      elapsedMs: roundMs(performance.now() - start),
      error: safeError(error),
    };
  }
}

async function authenticate() {
  if (accessToken) {
    return {
      skipped: true,
      reason: 'SSI_ACCESS_TOKEN supplied; auth endpoint was not called.',
    };
  }
  if (!API_KEY || !API_SECRET) {
    throw new Error('Missing SSI_API_KEY / SSI_API_SECRET. Put them in local .env.ssi-probe; never commit that file.');
  }

  const result = await timedFetch(`${BASE_URL}/api/v3/auth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept-Language': 'en',
      'User-Agent': 'my-chart2-ssi-probe/1',
    },
    body: JSON.stringify({ apiKey: API_KEY, apiSecret: API_SECRET }),
  });

  const payload = result.json && typeof result.json === 'object' ? result.json : {};
  accessToken = typeof payload.accessToken === 'string' ? payload.accessToken : '';
  const summary = {
    ok: result.ok && Boolean(accessToken),
    status: result.status,
    elapsedMs: result.elapsedMs,
    headers: result.headers,
    bodyBytes: result.bodyBytes,
    tokenType: payload.tokenType ?? null,
    expiresAt: payload.expiresAt ?? null,
    refreshExpiresAt: payload.refreshExpiresAt ?? null,
    responseKeys: Object.keys(payload),
    error: result.error || (!result.ok ? sanitize(payload) : null),
  };

  if (!summary.ok) {
    throw Object.assign(new Error(`SSI authentication failed (${result.status ?? 'network error'}).`), {
      probeSummary: summary,
    });
  }
  return summary;
}

async function networkProbe() {
  const host = new URL(BASE_URL).hostname;
  const dnsStart = performance.now();
  let dnsResult = null;
  try {
    const addresses = await lookup(host, { all: true });
    dnsResult = {
      ok: true,
      elapsedMs: roundMs(performance.now() - dnsStart),
      addresses: addresses.map(({ address, family }) => ({ address, family })),
    };
  } catch (error) {
    dnsResult = { ok: false, elapsedMs: roundMs(performance.now() - dnsStart), error: safeError(error) };
  }

  const tlsResult = await new Promise((resolve) => {
    const start = performance.now();
    const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: true });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, elapsedMs: roundMs(performance.now() - start), error: { message: 'TLS probe timeout' } });
    }, TIMEOUT_MS);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const certificate = socket.getPeerCertificate();
      const result = {
        ok: true,
        elapsedMs: roundMs(performance.now() - start),
        protocol: socket.getProtocol(),
        authorized: socket.authorized,
        remoteAddress: socket.remoteAddress,
        certificate: {
          subject: certificate?.subject?.CN ?? null,
          issuer: certificate?.issuer?.CN ?? null,
          validTo: certificate?.valid_to ?? null,
        },
      };
      socket.end();
      resolve(result);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, elapsedMs: roundMs(performance.now() - start), error: safeError(error) });
    });
  });

  return { host, dns: dnsResult, tls: tlsResult };
}

function ohlcUrl({ symbol, from, to, timeFrame, pageIndex = 1, pageSize = 500 }) {
  const url = new URL('/api/v3/data/ohlc', BASE_URL);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('from', from);
  url.searchParams.set('to', to);
  url.searchParams.set('timeFrame', timeFrame);
  url.searchParams.set('pageIndex', String(pageIndex));
  url.searchParams.set('pageSize', String(pageSize));
  return url;
}

async function probeOhlc({ label, symbol, from, to, timeFrame, pageIndex = 1, pageSize = 500, captureRaw = false }) {
  const request = { symbol, from, to, timeFrame, pageIndex, pageSize };
  const result = await timedFetch(ohlcUrl(request), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept-Language': 'en',
      'User-Agent': 'my-chart2-ssi-probe/1',
    },
  });
  const payload = result.json && typeof result.json === 'object' ? result.json : null;
  const data = Array.isArray(payload?.data) ? payload.data : [];
  const response = {
    pageSize: payload?.pageSize ?? null,
    pageIndex: payload?.pageIndex ?? null,
    count: data.length,
    payloadKeys: payload ? Object.keys(payload) : [],
    recordKeys: data[0] && typeof data[0] === 'object' ? Object.keys(data[0]) : [],
    first: data[0] ?? null,
    last: data.at(-1) ?? null,
    first3: data.slice(0, 3),
    last3: data.slice(-3),
  };

  const entry = {
    label,
    request,
    ok: result.ok,
    status: result.status,
    statusText: result.statusText,
    elapsedMs: result.elapsedMs,
    headers: result.headers,
    bodyBytes: result.bodyBytes,
    response: sanitize(response),
    error: result.error || (!result.ok ? sanitize(payload ?? result.textPreview) : null),
    rawResponse: captureRaw && result.ok ? sanitize(payload) : undefined,
  };

  console.log(`${entry.ok ? 'OK ' : 'ERR'} ${label}: ${entry.elapsedMs} ms, status=${entry.status}, records=${response.count}, requestedPageSize=${pageSize}, returnedPageSize=${response.pageSize ?? '?'}`);
  return entry;
}

async function probeBoard(board) {
  const url = new URL('/api/v3/data/securitiesByBoard', BASE_URL);
  url.searchParams.set('board', board);
  const result = await timedFetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept-Language': 'en',
      'User-Agent': 'my-chart2-ssi-probe/1',
    },
  });
  const payload = result.json;
  const data = Array.isArray(payload) ? payload : [];
  const entry = {
    board,
    ok: result.ok,
    status: result.status,
    elapsedMs: result.elapsedMs,
    headers: result.headers,
    bodyBytes: result.bodyBytes,
    count: data.length,
    recordKeys: data[0] && typeof data[0] === 'object' ? Object.keys(data[0]) : [],
    sample: sanitize(data.slice(0, 20)),
    error: result.error || (!result.ok ? sanitize(payload ?? result.textPreview) : null),
  };
  console.log(`${entry.ok ? 'OK ' : 'ERR'} board ${board}: ${entry.elapsedMs} ms, records=${entry.count}`);
  return entry;
}

function shouldStop(entry) {
  if (entry?.status === 429) {
    report.stoppedReason = `SSI returned 429 during ${entry.label || entry.board || 'probe'}; remaining tests were skipped.`;
    return true;
  }
  return false;
}

async function addOhlcTest(spec) {
  if (report.stoppedReason) return null;
  await sleep(GAP_MS);
  const entry = await probeOhlc(spec);
  report.tests.push(entry);
  shouldStop(entry);
  await persistReport();
  return entry;
}

async function persistReport() {
  report.finishedAt = new Date().toISOString();
  const output = path.resolve(OUTPUT_PATH);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(sanitize(report), null, 2)}\n`, 'utf8');
}

function printSummary() {
  const rows = report.tests.map((entry) => ({
    label: entry.label,
    status: entry.status,
    ms: entry.elapsedMs,
    records: entry.response?.count ?? 0,
    requested: entry.request?.pageSize ?? '',
    returned: entry.response?.pageSize ?? '',
    remaining: entry.headers?.['x-ratelimit-remaining'] ?? '',
  }));
  if (rows.length) console.table(rows);
  console.log(`\nSafe-to-commit report: ${OUTPUT_PATH}`);
  console.log('The script never writes API key, API secret, Authorization header, access token, or refresh token to the report.');
}

async function main() {
  if (SYMBOLS.length === 0) throw new Error('SSI_PROBE_SYMBOLS must contain at least one ticker.');

  console.log(`SSI real API probe -> ${BASE_URL}`);
  console.log(`Symbols: ${SYMBOLS.join(', ')}`);
  console.log(`Daily: ${DAILY_FROM} -> ${DAILY_TO}; intraday: ${INTRADAY_FROM} -> ${INTRADAY_TO}`);
  console.log('No automatic retry is used.\n');

  try {
    report.auth = await authenticate();
    console.log(`OK auth: ${report.auth.elapsedMs ?? 'skipped'} ms`);
  } catch (error) {
    report.auth = error?.probeSummary ?? { ok: false, error: safeError(error) };
    throw error;
  }

  report.network = await networkProbe();
  await persistReport();

  const primary = SYMBOLS[0];
  const secondary = SYMBOLS[1];

  // Most important number: first OHLC request for an uncached symbol, 500 daily candles.
  await addOhlcTest({
    label: `${primary}-1d-cold-target-500`,
    symbol: primary,
    from: DAILY_FROM,
    to: DAILY_TO,
    timeFrame: '1d',
    pageIndex: 1,
    pageSize: 500,
    captureRaw: CAPTURE_FULL,
  });

  // Determine whether REST accepts 10/100/500/1000 rows per page and what it actually returns.
  for (const pageSize of PAGE_SIZES) {
    await addOhlcTest({
      label: `${primary}-1d-pagesize-${pageSize}`,
      symbol: primary,
      from: DAILY_FROM,
      to: DAILY_TO,
      timeFrame: '1d',
      pageIndex: 1,
      pageSize,
    });
  }

  // Verify page 2 behavior/ordering/overlap for the chart backfill design.
  await addOhlcTest({
    label: `${primary}-1d-page2-500`,
    symbol: primary,
    from: DAILY_FROM,
    to: DAILY_TO,
    timeFrame: '1d',
    pageIndex: 2,
    pageSize: 500,
  });

  // Same request repeated: gives warm median/p95 candidate without SDK retry/caching logic in our code.
  for (let index = 1; index <= ITERATIONS; index += 1) {
    await addOhlcTest({
      label: `${primary}-1d-warm-${index}`,
      symbol: primary,
      from: DAILY_FROM,
      to: DAILY_TO,
      timeFrame: '1d',
      pageIndex: 1,
      pageSize: 500,
    });
  }

  // A second ticker approximates selecting another never-seen symbol after the SSI session is already warm.
  if (secondary) {
    for (let index = 1; index <= ITERATIONS; index += 1) {
      await addOhlcTest({
        label: `${secondary}-1d-symbol-switch-${index}`,
        symbol: secondary,
        from: DAILY_FROM,
        to: DAILY_TO,
        timeFrame: '1d',
        pageIndex: 1,
        pageSize: 500,
      });
    }
  }

  // Intraday is separately important because SSI documents a one-year retention window.
  for (const timeFrame of ['5m', '1h']) {
    for (let index = 1; index <= ITERATIONS; index += 1) {
      await addOhlcTest({
        label: `${primary}-${timeFrame}-${index}`,
        symbol: primary,
        from: INTRADAY_FROM,
        to: INTRADAY_TO,
        timeFrame,
        pageIndex: 1,
        pageSize: 500,
      });
    }
  }

  // Search UI can preload these lists once and filter locally; measure the real one-time cost.
  if (!report.stoppedReason) {
    for (const board of ['HOSE', 'HNX', 'UPCOM']) {
      await sleep(GAP_MS);
      const entry = await probeBoard(board);
      report.boardLists.push(entry);
      if (shouldStop(entry)) break;
      await persistReport();
    }
  }
}

try {
  await main();
} catch (error) {
  report.fatalError = safeError(error);
  console.error('\nProbe failed:', report.fatalError.message);
  process.exitCode = 1;
} finally {
  await persistReport();
  printSummary();
}
