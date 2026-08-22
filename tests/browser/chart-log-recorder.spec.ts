import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('chart log button records diagnostics and downloads txt on stop', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem('l2chart.autoSave.workspace.v1');
    localStorage.setItem('l2chart.priceProviderEnabled', 'false');
  });

  await page.goto('http://127.0.0.1:53173/', { waitUntil: 'domcontentloaded' });

  const button = page.getByRole('button', { name: 'Start chart log' });
  await expect(button).toBeVisible();
  await expect(button).toHaveText('LOG');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  const followsTrash = await page.locator('#global-drawing-toolbar-host .drawing-tool-button.danger').evaluate(
    (trash) => trash.nextElementSibling?.classList.contains('chart-log-button') ?? false,
  );
  expect(followsTrash).toBe(true);

  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(button).toHaveClass(/is-recording/);
  await expect(button).toHaveText('STOP');

  await page.evaluate(async () => {
    await fetch('/provider-runtime/health');
  });
  await page.locator('#ind-btn').click();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Stop chart log and download' }).click();
  const download = await downloadPromise;

  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(button).not.toHaveClass(/is-recording/);
  await expect(button).toHaveText('LOG');
  expect(download.suggestedFilename()).toMatch(/^l2chart-log-\d{8}-\d{6}\.txt$/);

  const path = await download.path();
  expect(path).not.toBeNull();
  const content = await readFile(path!, 'utf8');
  expect(content).toContain('L2Chart chart log');
  expect(content).toContain('[SESSION] START');
  expect(content).toContain('[STATE] START');
  expect(content).toContain('[NET NET');
  expect(content).toContain('/provider-runtime/health');
  expect(content).toContain('[UI] CLICK');
  expect(content).toContain('[SESSION] STOP');
});

test('starting a new chart log creates a fresh session', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem('l2chart.autoSave.workspace.v1');
    localStorage.setItem('l2chart.priceProviderEnabled', 'false');
  });
  await page.goto('http://127.0.0.1:53173/', { waitUntil: 'domcontentloaded' });

  const start = page.getByRole('button', { name: 'Start chart log' });
  await start.click();
  const firstDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Stop chart log and download' }).click();
  await firstDownload;

  await start.click();
  await page.evaluate(() => console.warn('second-session-marker'));
  const secondDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Stop chart log and download' }).click();
  const secondDownload = await secondDownloadPromise;
  const secondPath = await secondDownload.path();
  const secondContent = await readFile(secondPath!, 'utf8');

  expect(secondContent).toContain('second-session-marker');
  expect(secondContent.match(/\[SESSION\] START/g)).toHaveLength(1);
  expect(secondContent.match(/\[SESSION\] STOP/g)).toHaveLength(1);
});
