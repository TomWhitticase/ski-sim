import { expect, type Page, test } from '@playwright/test';

import { answer, type Hourly, type Place, withWeather } from './weather-mock';

// The weather as a field (weather-field.ts), Open-Meteo mocked by place: one morning with
// a sea of cloud filling the Belleville valley to 2,600 m while the Maurienne side, over
// the ridge to the south, is in sunshine. Val Thorens is in the cloud; the top of the
// Orelle gondola is in the sun; from above, the valley is a sea of cloud. Screenshots go
// to test-results/weather/.

type Sim = {
  weather: {
    status: string;
    day: { source: string; model: string; sites: unknown[] } | null;
    conditions: { inCloud: number; overcast: number; cloudTop: number; visibility: number };
  };
};

/** North of the ridge (Belleville, Val Thorens) or south of it (Maurienne, Orelle). */
const RIDGE = 45.27;
const TOP = 2600;

const seaOfCloud = (p: Place): Hourly =>
  p.lat > RIDGE && p.elevation < TOP
    ? { temperature: -3, humidity: 100, cloud: 100, low: 100, wind: 3, gusts: 8 }
    : { temperature: p.lat > RIDGE ? 2 : -1, humidity: 40, cloud: 0, low: 0, wind: 4, gusts: 10 };

const POSES = {
  // In Val Thorens, looking up the valley.
  valThorens: 'at=45.2985,6.5830,2330&heading=215&pitch=0',
  // Above the top of the Orelle gondola, looking north to the ridge.
  orelle: 'at=45.2440,6.5700,2600&heading=10&pitch=2',
  // High over the Belleville valley looking north down it: the sea of cloud.
  above: 'at=45.2760,6.5620,3500&heading=355&pitch=-12',
};

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
    { timeout: 15_000 },
  );
  await page.waitForTimeout(1200);
  return page.evaluate(() => (window.__sim as unknown as Sim).weather.conditions);
}

test('weather field: Val Thorens in cloud, Orelle in the sun, a sea of cloud below', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const errors = watchErrors(page);
  const requests: string[] = [];
  await withWeather(page, '2024-01-10', (url) => answer(url, seaOfCloud), requests);

  const vt = await load(page, POSES.valThorens);
  await page.screenshot({ path: 'test-results/weather/field-val-thorens.png' });
  expect(vt.inCloud).toBeGreaterThan(0.8);
  expect(vt.visibility).toBeLessThan(200);

  // Archived model runs for a 2024 day, from Météo-France's AROME for a French resort: the
  // points in one request, pressure-level cloud over a few in another, and as AROME's came
  // back empty, the best match's.
  expect(requests).toHaveLength(3);
  const points = new URL(requests[0]!);
  expect(points.hostname).toBe('historical-forecast-api.open-meteo.com');
  expect(points.searchParams.get('models')).toBe('meteofrance_seamless');
  const n = points.searchParams.get('elevation')!.split(',').length;
  expect(n).toBeGreaterThanOrEqual(20);
  expect(n).toBeLessThanOrEqual(50);
  expect(new URL(requests[1]!).searchParams.get('hourly')).toContain('cloud_cover_850hPa');
  expect(new URL(requests[2]!).searchParams.get('models')).toBe('best_match');
  const day = await page.evaluate(() => (window.__sim as unknown as Sim).weather.day!);
  expect(day.source).toBe('historical');
  expect(day.model).toBe('meteofrance_seamless');
  expect(day.sites).toHaveLength(n);

  const orelle = await load(page, POSES.orelle);
  await page.screenshot({ path: 'test-results/weather/field-orelle.png' });
  expect(orelle.inCloud).toBeLessThan(0.05);
  expect(orelle.overcast).toBeLessThan(0.3);
  expect(orelle.visibility).toBeGreaterThan(20_000);

  const above = await load(page, POSES.above);
  await page.screenshot({ path: 'test-results/weather/field-sea-of-cloud.png' });
  expect(above.inCloud).toBe(0);
  expect(above.overcast).toBeLessThan(0.3);
  expect(above.cloudTop).toBeGreaterThan(TOP - 250);
  expect(above.cloudTop).toBeLessThan(TOP + 250);
  // Each place from the one fetch: the day is cached.
  expect(requests).toHaveLength(3);

  // Data & credits names the model the day came from.
  await page.keyboard.press('KeyO');
  await page.locator('#options [data-tab="opt-credits"]').click();
  await expect(page.locator('#opt-credits')).toContainText('Météo-France AROME');
  expect(errors).toEqual([]);
});

// A deck from 2,700 to 3,300 m all over: under it in Val Thorens the summits are in the
// cloud (a ceiling); above it, only the highest peaks stand out.
const deck = (p: Place): Hourly =>
  p.elevation > 2700 && p.elevation < 3300
    ? { temperature: -9, humidity: 100, cloud: 100, low: 100, wind: 6, gusts: 14 }
    : {
        temperature: p.elevation > 3300 ? -14 : -4,
        humidity: 70,
        cloud: 100,
        low: 80,
        wind: 5,
        gusts: 12,
      };

test('weather field: under a cloud ceiling and above it', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchErrors(page);
  await withWeather(page, '2024-01-11', (url) => answer(url, deck));
  const under = await load(page, 'at=45.2985,6.5830,2450&heading=215&pitch=8');
  await page.screenshot({ path: 'test-results/weather/field-ceiling.png' });
  expect(under.inCloud).toBe(0);
  expect(under.overcast).toBeGreaterThan(0.8);
  expect(under.cloudTop).toBeGreaterThan(3000);
  const above = await load(page, 'at=45.2985,6.5830,3700&heading=215&pitch=-8');
  await page.screenshot({ path: 'test-results/weather/field-above-deck.png' });
  expect(above.inCloud).toBe(0);
  expect(above.overcast).toBeLessThan(0.3);
  expect(errors).toEqual([]);
});
