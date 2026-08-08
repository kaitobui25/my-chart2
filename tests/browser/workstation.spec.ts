import { expect, test } from '@playwright/test';

test('workstation assistant bridge keeps replay context contract', async ({ browser }) => {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('http://127.0.0.1:53173/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__L2CHART_ASSISTANT__?.getContext() !== null);

  const replay = await page.evaluate(() => window.__L2CHART_ASSISTANT__?.getContext()?.replay ?? null);
  expect(replay).toMatchObject({ phase: 'idle' });
  expect(pageErrors).toEqual([]);

  await page.close();
});

test('horizontal two-chart layout shares one replay clock', async ({ browser }) => {
  test.setTimeout(30_000);
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('l2chart.uiPreferences.v1', JSON.stringify({
      watchlistVisible: true,
      rightPanelVisible: false,
      symbols: ['HPG', 'HPG'],
    }));
  });

  const readActiveReplayChart = () => page.evaluate(() => {
    const context = window.__L2CHART_ASSISTANT__?.getContext();
    const last = context?.candles[context.candles.length - 1];
    return {
      symbol: context?.symbol ?? null,
      count: context?.candleCount ?? 0,
      lastTime: last?.time ?? null,
      phase: context?.replay.phase ?? null,
    };
  });

  await page.goto('http://127.0.0.1:53173/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__L2CHART_ASSISTANT__?.getContext() !== null);
  await page.locator('#layouts button[data-layout="2h"]').click();

  const allTiles = page.locator('#charts > .tile');
  const firstTile = allTiles.nth(0);
  const secondTile = allTiles.nth(1);
  await expect(firstTile).toBeVisible();
  await expect(secondTile).toBeVisible();

  const firstBox = await firstTile.boundingBox();
  const secondBox = await secondTile.boundingBox();
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  expect(secondBox!.y).toBeGreaterThan(firstBox!.y + firstBox!.height * 0.5);
  expect(Math.abs(secondBox!.x - firstBox!.x)).toBeLessThan(4);

  for (const tile of [firstTile, secondTile]) {
    await tile.locator('.tile-chart-shell').click({ position: { x: 8, y: 8 } });
    await page.waitForFunction(() => (window.__L2CHART_ASSISTANT__?.getContext()?.candleCount ?? 0) > 10);
    expect((await readActiveReplayChart()).symbol).toBe('HPG');
  }

  await page.locator('#replay-btn').click();
  await page.waitForFunction(() => window.__L2CHART_ASSISTANT__?.getContext()?.replay.phase === 'selecting');

  const chart = firstTile.locator('.tile-chart');
  const chartBox = await chart.boundingBox();
  expect(chartBox).not.toBeNull();
  await chart.click({
    position: {
      x: Math.round(chartBox!.width * 0.55),
      y: Math.round(chartBox!.height * 0.5),
    },
  });

  await page.waitForFunction(() => {
    const phase = window.__L2CHART_ASSISTANT__?.getContext()?.replay.phase;
    return phase === 'paused' || phase === 'playing';
  });

  await firstTile.locator('.tile-chart-shell').click({ position: { x: 8, y: 8 } });
  const beforeFirst = await readActiveReplayChart();
  await secondTile.locator('.tile-chart-shell').click({ position: { x: 8, y: 8 } });
  const beforeSecond = await readActiveReplayChart();
  expect(beforeFirst.phase).toBe('paused');
  expect(beforeSecond.phase).toBe('paused');
  expect(beforeFirst.count).toBe(beforeSecond.count);
  expect(beforeFirst.lastTime).toBe(beforeSecond.lastTime);

  await page.locator('#replay-step').click();

  await firstTile.locator('.tile-chart-shell').click({ position: { x: 8, y: 8 } });
  await expect.poll(async () => (await readActiveReplayChart()).lastTime).not.toBe(beforeFirst.lastTime);
  const afterFirst = await readActiveReplayChart();
  await secondTile.locator('.tile-chart-shell').click({ position: { x: 8, y: 8 } });
  const afterSecond = await readActiveReplayChart();
  expect(afterFirst.lastTime).not.toBe(beforeFirst.lastTime);
  expect(afterSecond.lastTime).not.toBe(beforeSecond.lastTime);
  expect(afterFirst.count).toBe(afterSecond.count);
  expect(afterFirst.lastTime).toBe(afterSecond.lastTime);
  expect(pageErrors).toEqual([]);

  await page.locator('#replay-stop').click();
  await page.close();
});
