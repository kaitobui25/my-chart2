/**
 * Deterministic integration smoke for the built Excel content add-in.
 *
 * Run from the repository root:
 *   npm run build:excel
 *   node tests/browser/excel-replay.smoke.mjs
 *
 * Uses the actual production bundle and chart canvas. Only the Yahoo Japan
 * HTTP responses and unavailable external Office/assistant services are faked.
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
const performanceRun = process.env.EXCEL_REPLAY_PERF === '1';
const candleCount = performanceRun ? 2_000 : 64;
const candles = fixtureCandles(candleCount);
const server = spawn(process.execPath, [
  'node_modules/vite/bin/vite.js',
  'preview',
  '--config',
  'examples/excel-content-addin/vite.config.ts',
  '--host',
  '127.0.0.1',
  '--port',
  String(port),
  '--strictPort',
], { cwd: repository, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

let serverOutput = '';
for (const stream of [server.stdout, server.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', chunk => { serverOutput += chunk; });
}

let browser;
try {
  await waitForPreview(origin, server);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 900, height: 650 },
    ignoreHTTPSErrors: true,
  });
  const errors = [];
  const marketRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://officeapis.public.onecdn.static.microsoft/**', async route => {
    await route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
  });
  await page.route('**/assistant-api/**', async route => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' });
  });
  await page.route('**/yfinance-jp-api/**', async route => {
    const url = new URL(route.request().url());
    marketRequests.push(url.pathname);
    if (url.pathname.endsWith('/history')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ candles }),
      });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
  });

  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  const context = page.locator('#assistant-context');
  try {
    await page.waitForFunction(({ total, perf }) => {
      const selector = perf ? '#status' : '#assistant-context';
      return document.querySelector(selector)?.textContent?.includes(`${total.toLocaleString(perf ? 'en-US' : 'en-US')} nến`);
    }, { total: candleCount, perf: performanceRun }, { timeout: 15_000 });
  } catch (error) {
    const status = await page.locator('#status').innerText().catch(() => 'missing');
    const assistantStatus = await context.innerText().catch(() => 'missing');
    throw new Error(`Market load failed: status=${status}, context=${assistantStatus}, requests=${marketRequests.join(',')}, pageErrors=${errors.join(',')}, preview=${serverOutput}`, { cause: error });
  }
  if (!performanceRun) assert.equal(await countFromContext(context), candles.length);
  assert.ok(await page.locator('#chart canvas').count() > 0, 'production chart canvas exists');
  console.log(`LOAD: ${candles.length} fake market candles, ${marketRequests.length} mocked market request(s)`);
  if (performanceRun) {
    await page.locator('#indicator-trigger').click();
    const ema = page.locator('#indicator-menu .indicator-menu-select').filter({ hasText: /^EMA$/ });
    await ema.click();
    assert.equal(await ema.getAttribute('aria-pressed'), 'true', 'EMA indicator activated');
    await page.locator('#indicator-trigger').click();
    console.log('INDICATOR: EMA activated');
  }

  // Escape cancels selection without removing market data.
  await page.locator('#replay-toggle').click();
  await page.locator('#replay-cancel').waitFor({ state: 'visible' });
  assert.match(await page.locator('#replay-status').innerText(), /Chọn nến bắt đầu/);
  await page.keyboard.press('Escape');
  await page.locator('#replay-controls').waitFor({ state: 'hidden' });
  if (!performanceRun) assert.equal(await countFromContext(context), candles.length);
  console.log(`CANCEL: Replay → selecting → Esc → idle; ${candleCount} candles retained`);

  // Select an actual candle using the real chart's pointer event path.
  await page.locator('#replay-toggle').click();
  await page.locator('#replay-cancel').waitFor({ state: 'visible' });
  const plot = page.locator('#chart canvas').first();
  assert.ok(await plot.count() === 1, 'actual L2Chart plot found');
  const box = await plot.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, 'chart plot has a measurable area');
  // The overlay canvas is intentionally in front of the price canvas.
  await page.mouse.click(box.x + box.width * 0.43, box.y + box.height * 0.5);
  await page.locator('#replay-actions').waitFor({ state: 'visible', timeout: 4_000 });
  const selected = await replayProgress(page);
  assert.ok(selected >= 2 && selected <= candles.length - 5,
    `valid click selects a nonfinal bar with room to play; selected=${selected}`);
  assert.ok(
    (await page.locator('#replay-status').innerText())
      .includes(`${selected.toLocaleString('vi-VN')}/${candleCount.toLocaleString('vi-VN')} nến`),
    'Replay progress shows the selected cursor and total',
  );
  const historyAtSelection = marketRequests.filter(path => path.endsWith('/history')).length;
  console.log(`SELECT: chart pointer click → paused, ${selected}/${candleCount} candles visible`);

  await page.locator('#replay-step').click();
  assert.equal(await replayProgress(page), selected + 1, 'step reveals exactly one candle');
  console.log(`STEP: ${selected} → ${selected + 1} candles`);

  for (let i = 0; i < 3; i++) await page.locator('#replay-speed').click();
  assert.equal(await page.locator('#replay-speed').innerText(), '10×');
  if (performanceRun) {
    await page.evaluate(() => {
      const element = document.querySelector('#replay-status');
      let previous = -1;
      globalThis.__excelReplayTimes = [];
      const observer = new MutationObserver(() => {
        const count = Number(element?.textContent?.match(/([\d.,]+)\/([\d.,]+) nến/)?.[1]?.replace(/\D/g, ''));
        if (Number.isFinite(count) && count !== previous) {
          globalThis.__excelReplayTimes.push({ count, now: performance.now() });
          previous = count;
        }
      });
      observer.observe(element, { childList: true, subtree: true, characterData: true });
    });
  }
  await page.locator('#replay-play-pause').click();
  await page.getByRole('button', { name: 'Tạm dừng Replay' }).waitFor();
  await page.waitForFunction(
    count => Number(document.querySelector('#replay-status')?.textContent?.match(/([\d.,]+)\/([\d.,]+) nến/)?.[1]?.replace(/\D/g, '')) > count,
    selected + 1,
    { timeout: 3_000 },
  );
  if (performanceRun) await page.waitForTimeout(900);
  await page.locator('#replay-play-pause').click();
  await page.getByRole('button', { name: 'Phát Replay' }).waitFor();
  const paused = await replayProgress(page);
  assert.ok(paused > selected + 1 && paused < candles.length,
    `play advances candles without immediately finishing; now=${paused}`);
  assert.equal(marketRequests.filter(path => path.endsWith('/history')).length, historyAtSelection,
    'playback must not fetch history');
  console.log(`PLAY/PAUSE: 10× advanced ${selected + 1} → ${paused}; no new history fetches`);
  if (performanceRun) {
    const samples = await page.evaluate(() => globalThis.__excelReplayTimes);
    const intervals = samples.slice(1).map((entry, index) => entry.now - samples[index].now);
    const medianMs = intervals.sort((a, b) => a - b)[Math.floor(intervals.length / 2)] ?? null;
    console.log(`PERF: EMA + 2,000 candles, ${intervals.length} sampled replay updates; median interval ${medianMs === null ? 'n/a' : medianMs.toFixed(1) + 'ms'}`);
  }

  await page.locator('#replay-stop').click();
  await page.locator('#replay-controls').waitFor({ state: 'hidden' });
  if (!performanceRun) {
    assert.equal(await countFromContext(context), candles.length, 'stop restores complete history');
  } else {
    assert.match(await page.locator('#status').innerText(), /2,000 nến/, 'market dataset retained on stop');
  }
  assert.equal(await page.locator('#replay-toggle').isEnabled(), true);
  if (!performanceRun) {
    await page.locator('#options-tab').click();
    const preserveZoom = page.locator('#preserve-replay-zoom');
    assert.equal(await preserveZoom.isChecked(), false, 'Replay zoom preservation defaults to Off');
    await preserveZoom.check();
    await page.locator('#chart-tab').click();
    const zoomedPlot = await page.locator('#chart canvas').first().boundingBox();
    assert.ok(zoomedPlot, 'chart is visible after leaving Options');
    await page.mouse.move(zoomedPlot.x + zoomedPlot.width * 0.6, zoomedPlot.y + zoomedPlot.height * 0.5);
    await page.mouse.wheel(0, -260); // User zooms before selecting a replay bar.
    await page.locator('#replay-toggle').click();
    await page.locator('#replay-cancel').waitFor({ state: 'visible' });
    const selectingPlot = await page.locator('#chart canvas').first().boundingBox();
    assert.ok(selectingPlot, 'chart canvas remains measurable while choosing a replay bar');
    // The exact visible bar position shifts with zoom, so try successively older on-screen bars.
    for (const fraction of [0.45, 0.3, 0.15, 0.08]) {
      await page.mouse.click(selectingPlot.x + selectingPlot.width * fraction, selectingPlot.y + selectingPlot.height * 0.5);
      if (await page.locator('#replay-actions').isVisible()) break;
    }
    assert.equal(
      await page.locator('#replay-actions').isVisible(),
      true,
      `zoomed Replay selected a past candle: ${await page.locator('#replay-status').innerText()}`,
    );
    await page.locator('#replay-step').click();
    await page.locator('#replay-stop').click();
    assert.equal(await countFromContext(context), candles.length, 'zoom-preserving Replay restores all bars');
    await page.locator('#options-tab').click();
    assert.equal(await preserveZoom.isChecked(), true, 'Replay zoom option persists across tabs');
    console.log('OPTIONS: default Off; enabled zoom preservation survives Replay and Stop');
  }
  assert.deepEqual(errors, [], 'no uncaught production bundle errors');
  console.log(`STOP: idle; all ${candles.length} original candles restored; no page errors`);
  console.log('PASS: built Excel Replay integration smoke');
} finally {
  await browser?.close();
  if (server.exitCode === null) server.kill();
}

async function countFromContext(locator) {
  const text = await locator.innerText();
  const count = text.match(/(\d+) nến/)?.[1];
  assert.ok(count, `assistant context should show candle count: ${text}`);
  return Number(count);
}

async function replayProgress(page) {
  const text = await page.locator('#replay-status').innerText();
  const count = text.match(/([\d.,]+)\/([\d.,]+) nến/)?.[1];
  assert.ok(count, `replay status should show cursor and total: ${text}`);
  return Number(count.replace(/\D/g, ''));
}

function fixtureCandles(total) {
  const result = [];
  let time = Date.UTC(total > 100 ? 2017 : 2025, 0, total > 100 ? 2 : 6);
  while (result.length < total) {
    const date = new Date(time);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) {
      const index = result.length;
      const open = 1_900 + index * 2;
      result.push({
        time: Math.floor(time / 1_000),
        open,
        high: open + 8,
        low: open - 6,
        close: open + (index % 2 === 0 ? 3 : -3),
        volume: 20_000 + index * 13,
      });
    }
    time += 86_400_000;
  }
  return result;
}

async function waitForPreview(url, processHandle) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Excel preview exited ${processHandle.exitCode}: ${serverOutput}`);
    }
    try {
      const available = await new Promise(resolve => {
        get(url, { rejectUnauthorized: false }, response => {
          response.resume();
          resolve(response.statusCode === 200);
        }).on('error', () => resolve(false));
      });
      if (available) return;
    } catch { /* server is starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Excel preview did not start at ${url}: ${serverOutput}`);
}
