import { expect, test } from '@playwright/test';

test('dev workstation installs terminal trace diagnostics', async ({ browser, request }) => {
  const health = await request.get('http://127.0.0.1:53173/__l2chart_dev_trace/health');
  expect(health.ok()).toBe(true);
  expect(await health.json()).toEqual({ ok: true, version: 1 });

  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:53173/', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => Boolean(
    (window as Window & { __L2CHART_DEV_TRACE_INSTALLED__?: boolean }).__L2CHART_DEV_TRACE_INSTALLED__,
  ))).toBe(true);
  await page.close();
});
