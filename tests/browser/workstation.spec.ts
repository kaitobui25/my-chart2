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
