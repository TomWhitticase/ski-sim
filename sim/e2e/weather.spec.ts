import { readFileSync } from 'node:fs';

import { expect, type Page, test } from '@playwright/test';

import { answer, SCENES, withWeather } from './weather-mock';

// Weather (C), with Open-Meteo mocked (weather-mock.ts): the menu, the cache, errors, and
// real days saved from Open-Meteo (e2e/fixtures, CC BY 4.0). The made-up conditions are
// views in views.spec.ts. Screenshots go to test-results/weather/.

type Sim = { weather: { status: string; date: string } };

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return errors;
}

async function load(page: Page, pose: string) {
  await page.goto(`/?resort=les-3-vallees&${pose}`);
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 30, null, { timeout: 90_000 });
  await page.evaluate(() => document.body.classList.add('flying'));
  await page.waitForFunction(
    () => (window.__sim as unknown as Partial<Sim> | undefined)?.weather?.status === 'ready',
    null,
    {
      timeout: 10_000,
    },
  );
  // Let the snow fill its box and the conditions refresh.
  await page.waitForTimeout(1200);
}

// Looking up the Caron from above Val Thorens, and down a piste.
const POSES = {
  wide: 'at=45.2985,6.5830,2450&heading=215&pitch=5',
  slope: 'at=45.2830,6.5760,2000&heading=27&pitch=-6',
};

// Real days from Open-Meteo: Storm Eleanor (4 January 2018) and a bluebird 10 February 2023.
for (const [name, date, seconds] of [
  ['eleanor', '2018-01-04', 10 * 3600],
  ['bluebird', '2023-02-10', 11 * 3600],
] as const) {
  test(`weather real day ${name}`, async ({ page }) => {
    const errors = watchErrors(page);
    const json = JSON.parse(readFileSync(`e2e/fixtures/open-meteo-${date}.json`, 'utf8'));
    await withWeather(page, date, () => json, [], seconds);
    await load(page, POSES.wide);
    await page.screenshot({ path: `test-results/weather/real-${name}.png` });
    await page.evaluate(() => localStorage.setItem('ski-sim.mode', 'ski'));
    await load(page, POSES.slope);
    await page.screenshot({ path: `test-results/weather/real-${name}-slope.png` });
    expect(errors).toEqual([]);
  });
}

test('weather menu: conditions, one request per day, cached, and Clear', async ({ page }) => {
  const errors = watchErrors(page);
  const requests: string[] = [];
  await withWeather(page, '2023-01-15', (url) => answer(url, SCENES['heavy-snow']!), requests);
  await load(page, POSES.wide);
  expect(requests).toHaveLength(1);
  // Three heights in one request, the archive for an old day, the date ± 1 in UTC.
  const url = new URL(requests[0]!);
  expect(url.hostname).toBe('archive-api.open-meteo.com');
  expect(url.searchParams.get('elevation')!.split(',')).toHaveLength(3);
  expect(url.searchParams.get('start_date')).toBe('2023-01-14');
  expect(url.searchParams.get('end_date')).toBe('2023-01-16');

  await page.keyboard.press('KeyC');
  const panel = page.locator('#opt-weather');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.weather-summary')).toContainText(/Heavy snow · −\d+ °C · wind/);
  await expect(panel.locator('.weather-hour')).toHaveCount(24);
  await expect(panel.locator('[data-mode="past"]')).toHaveClass(/selected/);
  await expect(panel.locator('input[type="date"]')).toHaveValue('2023-01-15');
  // The sun follows the date: the sim day is the picked one.
  expect(await page.evaluate(() => (window.__sim as unknown as Sim).weather.date)).toBe(
    '2023-01-15',
  );
  await page.screenshot({ path: 'test-results/weather/menu.png' });

  // Another day: one more request; back to the first: from the cache.
  await panel.locator('input[type="date"]').fill('2023-01-20');
  await page.waitForFunction(() => (window.__sim as unknown as Sim).weather.date === '2023-01-20');
  await page.waitForFunction(() => (window.__sim as unknown as Sim).weather.status === 'ready');
  expect(requests).toHaveLength(2);
  await panel.locator('input[type="date"]').fill('2023-01-15');
  await page.waitForFunction(() => (window.__sim as unknown as Sim).weather.status === 'ready');
  expect(requests).toHaveLength(2);

  // Clear: no weather, the bluebird day, and it stays that way after a reload.
  await panel.locator('[data-mode="clear"]').click();
  await expect(panel.locator('.weather-summary')).toHaveText('Clear · no weather');
  expect(await page.evaluate(() => (window.__sim as unknown as Sim).weather.status)).toBe('off');
  await page.reload();
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 30, null, { timeout: 90_000 });
  expect(requests).toHaveLength(2);
  expect(errors).toEqual([]);
});

test('weather: an Open-Meteo error falls back to clear skies with a message', async ({ page }) => {
  const errors = watchErrors(page);
  await page.route('**/*open-meteo.com/**', (route) =>
    route.fulfill({ status: 429, json: { error: true, reason: 'Too many requests' } }),
  );
  await page.addInitScript(() =>
    localStorage.setItem(
      'ski-sim.weather',
      JSON.stringify({ 'les-3-vallees': { mode: 'past', date: '2023-01-15' } }),
    ),
  );
  await page.goto(`/?resort=les-3-vallees&${POSES.wide}`);
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 30, null, { timeout: 90_000 });
  await page.waitForFunction(() => (window.__sim as unknown as Sim).weather.status === 'error');
  await page.evaluate(() => document.body.classList.add('flying'));
  await page.keyboard.press('KeyC');
  await expect(page.locator('#opt-weather .weather-status')).toHaveText(
    'Open-Meteo: Too many requests · showing clear skies',
  );
  // The browser logs the failed request itself; nothing else may go wrong.
  expect(errors.filter((e) => !e.startsWith('Failed to load resource'))).toEqual([]);
});

test('weather off: the sim touches no weather service', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (r) => r.url().includes('open-meteo') && requests.push(r.url()));
  await page.goto(`/?resort=les-3-vallees&${POSES.wide}`);
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 30, null, { timeout: 90_000 });
  await page.waitForTimeout(500);
  expect(requests).toEqual([]);
});
