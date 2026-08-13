import { expect, test } from '@playwright/test';

interface ChartState {
  barSpacing: number;
  rightIndex: number;
  candleCount: number;
  drawingCount: number;
  chartRootCount: number;
  mode: string;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('L2Chart smoke fixture')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.chartTest.state().candleCount)).toBe(120);
});

test('renders on Canvas and supports wheel zoom and pointer pan', async ({ page }) => {
  const canvases = page.locator('#chart canvas');
  await expect(canvases).toHaveCount(4);
  await expect(canvases.first()).toHaveJSProperty('width', 960);
  expect(await canvases.first().evaluate((canvas) => {
    const element = canvas as HTMLCanvasElement;
    const context = element.getContext('2d');
    const pixels = context?.getImageData(0, 0, element.width, element.height).data;
    return pixels ? pixels.some((value, index) => index % 4 === 3 && value > 0) : false;
  })).toBe(true);

  const before = await page.evaluate(() => window.chartTest.state());
  const box = await canvases.first().boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -240);
  await expect.poll(
    () => page.evaluate(() => window.chartTest.state().barSpacing),
  ).toBeGreaterThan(before.barSpacing);

  const beforePan = await page.evaluate(() => window.chartTest.state().rightIndex);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2);
  await page.mouse.up();
  await expect.poll(
    () => page.evaluate(() => window.chartTest.state().rightIndex),
  ).not.toBe(beforePan);
});

test('keeps manual vertical pan across data refresh and history prepend', async ({ page }) => {
  const canvas = page.locator('#chart canvas').first();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  expect(await page.evaluate(() => window.chartTest.priceViewport())).toBeNull();

  const x = box.x + box.width * 0.55;
  const y = box.y + box.height * 0.5;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 110, { steps: 4 });
  await page.mouse.up();

  const afterDrag = await page.evaluate(() => window.chartTest.priceViewport());
  expect(afterDrag).not.toBeNull();
  if (!afterDrag) return;

  // Simulates IndexedDB-first rendering followed by a fresh network response.
  await page.evaluate(() => window.chartTest.refreshData());
  const afterRefresh = await page.evaluate(() => window.chartTest.priceViewport());
  expect(afterRefresh?.topPrice).toBeCloseTo(afterDrag.topPrice, 8);
  expect(afterRefresh?.bottomPrice).toBeCloseTo(afterDrag.bottomPrice, 8);

  // Loading older history must preserve the same manual vertical viewport too.
  await page.evaluate(() => window.chartTest.prependHistory());
  await expect.poll(() => page.evaluate(() => window.chartTest.state().candleCount)).toBe(125);
  const afterPrepend = await page.evaluate(() => window.chartTest.priceViewport());
  expect(afterPrepend?.topPrice).toBeCloseTo(afterDrag.topPrice, 8);
  expect(afterPrepend?.bottomPrice).toBeCloseTo(afterDrag.bottomPrice, 8);

  // Explicit user fit/reset remains the only way back to automatic price scale.
  await page.evaluate(() => window.chartTest.fitPriceScale());
  expect(await page.evaluate(() => window.chartTest.priceViewport())).toBeNull();
});

test('renders Heikin Ashi from raw candles and keeps realtime updates working', async ({ page }) => {
  const before = await page.evaluate(() => window.chartTest.lastCloses());
  expect(before.raw).toBe(before.displayed);

  await page.evaluate(() => window.chartTest.setMode('heikin-ashi'));
  await expect.poll(() => page.evaluate(() => window.chartTest.state().mode)).toBe('heikin-ashi');

  const transformed = await page.evaluate(() => window.chartTest.lastCloses());
  expect(transformed.raw).not.toBe(transformed.displayed);

  await page.evaluate(() => window.chartTest.updateLatest(112));
  expect(await page.evaluate(() => window.chartTest.state().candleCount)).toBe(120);
  const updated = await page.evaluate(() => window.chartTest.lastCloses());
  expect(updated.raw).not.toBe(updated.displayed);

  await page.evaluate(() => window.chartTest.appendCandle());
  expect(await page.evaluate(() => window.chartTest.state().candleCount)).toBe(121);
  expect(await page.evaluate(() => window.chartTest.state().mode)).toBe('heikin-ashi');
});

test('updates candles, restores drawing history, and destroys cleanly', async ({ page }) => {
  await page.evaluate(() => window.chartTest.updateLatest(112));
  expect(await page.evaluate(() => window.chartTest.state().candleCount)).toBe(120);

  await page.evaluate(() => window.chartTest.appendCandle());
  expect(await page.evaluate(() => window.chartTest.state().candleCount)).toBe(121);

  await page.evaluate(() => window.chartTest.setDrawing());
  expect(await page.evaluate(() => window.chartTest.state().drawingCount)).toBe(1);
  const serialized = await page.evaluate(() => window.chartTest.serializeDrawings());
  expect(JSON.parse(serialized)).toMatchObject([{
    id: 1,
    tool: 'trendline',
    paneIndex: 0,
  }]);
  expect(await page.evaluate(() => window.chartTest.deleteDrawing())).toBe(true);
  expect(await page.evaluate(() => window.chartTest.state().drawingCount)).toBe(0);
  expect(await page.evaluate(() => window.chartTest.undoDrawing())).toBe(true);
  expect(await page.evaluate(() => window.chartTest.state().drawingCount)).toBe(1);
  expect(await page.evaluate(() => window.chartTest.redoDrawing())).toBe(true);
  expect(await page.evaluate(() => window.chartTest.state().drawingCount)).toBe(0);
  await page.evaluate((payload) => window.chartTest.restoreDrawings(payload), serialized);
  expect(await page.evaluate(() => window.chartTest.state().drawingCount)).toBe(1);

  await page.evaluate(() => window.chartTest.destroy());
  const finalState: ChartState = await page.evaluate(() => window.chartTest.state());
  expect(finalState.chartRootCount).toBe(0);
});
