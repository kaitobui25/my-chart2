import { expect, test } from '@playwright/test';

interface ChartState {
  barSpacing: number;
  rightIndex: number;
  candleCount: number;
  drawingCount: number;
  chartRootCount: number;
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
