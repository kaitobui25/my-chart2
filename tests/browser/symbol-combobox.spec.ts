import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/symbol-combobox.html');
  await expect(page.getByRole('button', { name: 'Open symbols' })).toBeVisible();
});

test('trigger shows the whole current symbol source without remote search', async ({ page }) => {
  await page.getByRole('button', { name: 'Open symbols' }).click();

  await expect(page.getByRole('listbox')).toBeVisible();
  await expect(page.getByRole('option')).toHaveText(['7203.T', '6758.T', '9984.T']);
  expect(await page.evaluate(() => window.symbolComboboxTest.state())).toMatchObject({
    searchCalls: 0,
    expanded: 'true',
  });
});

test('reopening reads the latest symbols instead of a cached list', async ({ page }) => {
  const trigger = page.getByRole('button', { name: 'Open symbols' });
  await trigger.click();
  await trigger.click();

  await page.evaluate(() => window.symbolComboboxTest.setSymbols(['6758.T', '9432.T']));
  await trigger.click();

  await expect(page.getByRole('option')).toHaveText(['6758.T', '9432.T']);
});

test('selecting an option commits once and closes the listbox', async ({ page }) => {
  await page.getByRole('button', { name: 'Open symbols' }).click();
  await page.getByRole('option', { name: '6758.T' }).click();

  await expect(page.getByLabel('Ticker')).toHaveValue('6758.T');
  await expect(page.getByRole('listbox')).toBeHidden();
  expect(await page.evaluate(() => window.symbolComboboxTest.state())).toMatchObject({
    commits: ['6758.T'],
    expanded: 'false',
  });
});

test('typing uses provider search and keyboard selection', async ({ page }) => {
  const input = page.getByLabel('Ticker');
  await input.fill('8306');

  await expect(page.getByRole('option')).toHaveText(['8306.TMitsubishi UFJ · TSE']);
  await input.press('ArrowDown');
  await input.press('Enter');

  await expect(input).toHaveValue('8306.T');
  expect(await page.evaluate(() => window.symbolComboboxTest.state())).toMatchObject({
    searchCalls: 1,
    commits: ['8306.T'],
    expanded: 'false',
  });
});
