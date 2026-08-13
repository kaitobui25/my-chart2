import { expect, test } from '@playwright/test';

test('Cyber candle theme is selectable only in Dark Mode', async ({ browser }) => {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('http://127.0.0.1:53173/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#toolbar-more-btn');

  await page.getByRole('button', { name: 'More tools' }).click();
  let select = page.locator('#candle-theme-select');
  await expect(select).toBeVisible();
  await expect(select).toHaveValue('default');
  await expect.poll(() => select.locator('option[value="cyber"]').evaluate((option) => (
    (option as HTMLOptionElement).disabled
  ))).toBe(false);

  await select.selectOption('cyber');
  await expect(select).toHaveValue('cyber');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('l2chart.candleTheme.v1'))).toBe('cyber');
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.candleTheme)).toBe('cyber');

  await page.locator('#theme-toggle').click();
  await expect.poll(() => page.evaluate(() => document.body.classList.contains('light'))).toBe(true);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('l2chart.candleTheme.v1'))).toBe('default');
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.candleTheme)).toBe('default');

  await page.getByRole('button', { name: 'More tools' }).click();
  select = page.locator('#candle-theme-select');
  await expect(select).toHaveValue('default');
  await expect.poll(() => select.locator('option[value="cyber"]').evaluate((option) => (
    (option as HTMLOptionElement).disabled
  ))).toBe(true);

  await page.locator('#theme-toggle').click();
  await expect.poll(() => page.evaluate(() => document.body.classList.contains('light'))).toBe(false);
  await page.getByRole('button', { name: 'More tools' }).click();
  select = page.locator('#candle-theme-select');
  await expect(select).toHaveValue('default');
  await expect.poll(() => select.locator('option[value="cyber"]').evaluate((option) => (
    (option as HTMLOptionElement).disabled
  ))).toBe(false);
  expect(pageErrors).toEqual([]);

  await page.close();
});
