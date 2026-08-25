import { expect, test } from '@playwright/test';

function monthlyCandles() {
  return Array.from({ length: 12 }, (_, index) => {
    const month = index + 1;
    const time = Date.UTC(2025, month - 1, 1) / 1000;
    const open = 80 + index;
    return {
      time,
      open,
      high: open + 3,
      low: open - 2,
      close: open + 1,
      volume: 1_000_000 + index * 10_000,
    };
  });
}

test('Vnstock 1M flow toggle emits stock-flow request from runtime provider state', async ({ browser }) => {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  let stockFlowRequests = 0;
  await page.route('**/vnstock-api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/health')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, configured: true, provider: 'KBS', routing: 'KBS', pollIntervalSeconds: 300 }),
      });
      return;
    }
    if (url.pathname.endsWith('/history')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ candles: monthlyCandles() }),
      });
      return;
    }
    if (url.pathname.endsWith('/latest')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candles: {} }) });
      return;
    }
    if (url.pathname.endsWith('/symbols')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ symbols: [{ symbol: 'VCB', name: 'Vietcombank', exchange: 'HOSE' }] }),
      });
      return;
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });

  await page.route('**/stock-flow-api**', async (route) => {
    const url = new URL(route.request().url());
    stockFlowRequests += 1;
    expect(url.searchParams.get('symbol')).toBe('VCB');
    expect(url.searchParams.get('from')).toMatch(/^\d{4}-\d{2}$/);
    expect(url.searchParams.get('to')).toMatch(/^\d{4}-\d{2}$/);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        symbol: 'VCB',
        from: '2025-01',
        to: '2025-12',
        unit: 'VND',
        months: [
          { period: '2025-11', foreign_net_value_vnd: 2_000_000_000, proprietary_net_value_vnd: -500_000_000 },
          { period: '2025-12', foreign_net_value_vnd: -1_000_000_000, proprietary_net_value_vnd: 750_000_000 },
        ],
      }),
    });
  });

  await page.addInitScript(() => {
    localStorage.removeItem('l2chart.autoSave.workspace.v1');
    localStorage.setItem('l2chart.priceProvider', 'vnstock');
    localStorage.setItem('l2chart.priceProviderEnabled', 'true');
    localStorage.setItem('l2chart.uiPreferences.v1', JSON.stringify({
      watchlistVisible: true,
      rightPanelVisible: false,
      symbols: ['VCB'],
    }));
    localStorage.setItem('l2chart.chartPreferences.v1', JSON.stringify({
      VCB: {
        defaultsVersion: 2,
        interval: '1M',
        mode: 'candles',
        indicators: ['visible-range-extrema'],
        indicatorParams: {},
        sessions: false,
      },
    }));
  });

  await page.goto('http://127.0.0.1:53173/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__L2CHART_ASSISTANT__?.getContext()?.symbol === 'VCB');

  const more = page.getByRole('button', { name: 'More tools' });
  await more.click();
  const toggle = page.getByRole('switch', { name: 'Dòng tiền tổ chức' });
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect.poll(() => stockFlowRequests).toBe(1);

  // The More menu intentionally closes after the switch click. Re-open it and
  // verify the indicator remains active rather than testing a detached element.
  await more.click();
  await expect(page.getByRole('switch', { name: 'Dòng tiền tổ chức' })).toHaveAttribute('aria-checked', 'true');
  expect(pageErrors).toEqual([]);

  await page.close();
});
