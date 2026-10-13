/**
 * Browser smoke for the production Excel content add-in Paper Trade tab.
 * The Yahoo API and Office host are mocked; all UI and accounting use real code.
 * Run: npm run build:excel && node tests/browser/excel-trading.smoke.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { get } from 'node:https';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const port = 54_000 + process.pid % 10_000;
const origin = `https://127.0.0.1:${port}`;
const prices = { '7203.T': 3000, 'JPY=X': 150, 'BTC-USD': 60000, 'GC=F': 3000 };
const now = Math.floor(Date.now() / 1000);
const candle = (price, time = now - 60) => ({
  time, open: price, high: price, low: price, close: price, volume: 1,
});

const server = spawn(process.execPath, [
  'node_modules/vite/bin/vite.js', 'preview',
  '--config', 'examples/excel-content-addin/vite.config.ts',
  '--host', '127.0.0.1', '--port', String(port), '--strictPort',
], { cwd: repository, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = '';
for (const stream of [server.stdout, server.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => { serverOutput += chunk; });
}

let browser;
try {
  await waitForPreview(origin, server);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 420, height: 640 }, ignoreHTTPSErrors: true });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://officeapis.public.onecdn.static.microsoft/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
  });
  await page.route('**/assistant-api/**', async (route) => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/yfinance-jp-api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/history')) {
      const price = prices[url.searchParams.get('symbol')] ?? 3000;
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ candles: [candle(price, now - 86460), candle(price)] }),
      });
    } else if (url.pathname.endsWith('/latest')) {
      const symbols = (url.searchParams.get('symbols') ?? '').split(',');
      const candles = Object.fromEntries(symbols
        .filter((symbol) => prices[symbol])
        .map((symbol) => [symbol, candle(prices[symbol])]));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candles }) });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
  });

  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.locator('#trade-tab').click();
  await page.locator('#trade-view').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#trade-price-row').isVisible(), false,
    'Market ticket must not show an unused limit/stop price input');
  await page.locator('#trade-symbol').selectOption('BTC-USD');
  await page.waitForFunction(() => document.querySelector('#trade-quote')?.dataset.state === 'ready',
    undefined, { timeout: 15_000 });
  assert.equal(await page.locator('#trade-volume').inputValue(), '0.001');
  assert.match(await page.locator('#trade-estimate').innerText(), /60.*USD/);

  await page.locator('#trade-submit').click();
  await page.locator('#trade-confirm-overlay').waitFor({ state: 'visible' });
  await page.locator('#trade-confirm-submit').click();
  await page.locator('#trade-positions .trade-row').first().waitFor({ state: 'visible' });
  assert.match(await page.locator('#trade-status').innerText(), /Đã khớp BTC-USD/);
  console.log('BUY: BTC-USD 0.001 filled from Yahoo mock');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#trade-tab').click();
  await page.locator('#trade-positions .trade-row').first().waitFor({ state: 'visible' });
  await page.locator('#trade-symbol').selectOption('BTC-USD');
  await page.waitForFunction(() => document.querySelector('#trade-quote')?.dataset.state === 'ready',
    undefined, { timeout: 15_000 });
  await page.locator('#trade-positions button[data-close-position]').first().click();
  await page.locator('#trade-positions .trade-row').waitFor({ state: 'detached' });
  assert.match(await page.locator('#trade-history').innerText(), /BTC-USD/);
  console.log('RELOAD/CLOSE: position restored, closed and recorded');

  await page.locator('#trade-type').selectOption('limit');
  assert.equal(await page.locator('#trade-price-row').isVisible(), true,
    'Limit ticket exposes its price input');
  await page.locator('#trade-price').fill('100');
  await page.locator('#trade-submit').click();
  await page.locator('#trade-confirm-submit').click();
  await page.locator('#trade-orders .trade-row').first().waitFor({ state: 'visible' });
  await page.locator('#trade-orders button[data-cancel-order]').first().click();
  await page.locator('#trade-orders .trade-row').waitFor({ state: 'detached' });
  console.log('LIMIT/CANCEL: BTC-USD working order cancelled');

  await page.locator('#trade-symbol').selectOption('JPY=X');
  assert.equal(await page.locator('#trade-volume').inputValue(), '0.01');
  await page.waitForFunction(() => document.querySelector('#trade-estimate')?.textContent?.includes('50 USD'),
    undefined, { timeout: 15_000 });
  await page.locator('#trade-symbol').selectOption('GC=F');
  assert.equal(await page.locator('#trade-volume').inputValue(), '1');
  assert.match(await page.locator('#trade-rules').innerText(), /multiplier ×100/);
  console.log('FX/FUTURES: symbol rules and account margin displayed');
  assert.deepEqual(errors, [], `No runtime exceptions: ${errors.join(' | ')}`);
  console.log('PASS: Excel Paper Trade browser smoke');
} finally {
  await browser?.close();
  if (server.exitCode === null) server.kill();
}

async function waitForPreview(url, process) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (process.exitCode !== null) throw new Error(`Preview exited: ${serverOutput}`);
    try {
      await new Promise((resolvePromise, reject) => {
        get(url, { rejectUnauthorized: false }, (response) => {
          response.resume();
          response.on('end', resolvePromise);
        }).on('error', reject);
      });
      return;
    } catch { /* Server is still starting. */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Preview did not start: ${serverOutput}`);
}
