import { expect, test } from '@playwright/test';

// Fixed camera poses rendered to screenshots for visual review. Pose: lat,lon,altitude.
const VIEWS = [
  { name: 'spawn', query: '' },
  { name: 'caron-from-village', query: 'at=45.2985,6.5830,2450&heading=215&pitch=5' },
  { name: 'peclet-glacier', query: 'at=45.2900,6.5850,3100&heading=105&pitch=-5' },
  { name: 'orelle-valley', query: 'at=45.2500,6.5650,3200&heading=200&pitch=-20' },
  { name: 'mont-blanc-horizon', query: 'at=45.2632,6.5610,3210&heading=25&pitch=0' },
  { name: 'pistes-overview', query: 'at=45.3010,6.5800,2850&heading=190&pitch=-22' },
  { name: 'station-sign', query: 'at=45.295314,6.576639,2290&heading=108&pitch=-10' },
  { name: 'village-close', query: 'at=45.29700,6.58050,2335&heading=200&pitch=-6' },
  { name: 'village', query: 'at=45.3005,6.5765,2420&heading=150&pitch=-18' },
  { name: 'lifts-moraine', query: 'at=45.2770,6.5880,2750&heading=55&pitch=-12' },
  { name: 'cime-caron-cable-car', query: 'at=45.2760,6.5680,2900&heading=215&pitch=-5' },
  { name: 'arlberg-st-anton', query: 'resort=arlberg&at=47.1255,10.2720,1750&heading=305&pitch=4' },
  { name: 'arlberg-lech', query: 'resort=arlberg&at=47.1930,10.1650,2250&heading=320&pitch=-14' },
  {
    name: 'arlberg-valluga',
    query: 'resort=arlberg&at=47.1600,10.2180,2900&heading=200&pitch=-10',
  },
  {
    name: 'restaurant-krazy-kanguruh',
    query: 'resort=arlberg&at=47.129080,10.256784,1467&heading=328&pitch=-10',
  },
  {
    name: 'restaurant-mooserwirt',
    query: 'resort=arlberg&at=47.127399,10.257507,1423&heading=327&pitch=-10',
  },
  {
    name: 'restaurant-ulmer-huette',
    query: 'resort=arlberg&at=47.146937,10.208493,2299&heading=73&pitch=-12',
  },
  {
    name: 'arlberg-sonnenkopf',
    query: 'resort=arlberg&at=47.0960,10.0560,2200&heading=0&pitch=-12',
  },
  // A rail in the Tétras snow park above Val Thorens: on legs, off the snow.
  { name: 'park-rail', query: 'at=45.289038,6.573435,2422.7&heading=90&pitch=-18' },
  {
    name: 'paradiski-arc-1950',
    query: 'resort=paradiski&at=45.5700,6.8250,2150&heading=60&pitch=-8',
  },
  {
    name: 'paradiski-aiguille-rouge',
    query: 'resort=paradiski&at=45.5540,6.8440,3260&heading=40&pitch=-10',
  },
  {
    name: 'paradiski-vanoise-express',
    query: 'resort=paradiski&at=45.5510,6.7680,2050&heading=262&pitch=-14',
  },
  {
    name: 'paradiski-plagne-centre',
    query: 'resort=paradiski&at=45.5030,6.6700,2150&heading=40&pitch=-12',
  },
  // Land cover: Méribel's forests (pistes and lift lines cut through them), a skier's-eye
  // view under the trees, and the Vanoise glaciers.
  { name: 'meribel-forest', query: 'at=45.3890,6.5700,1700&heading=120&pitch=-5' },
  { name: 'forest-floor', query: 'at=45.3890,6.5700,1502&heading=120&pitch=0' },
  { name: 'courchevel-tree-line', query: 'at=45.4050,6.6300,1950&heading=200&pitch=-10' },
  { name: 'glaciers', query: 'at=45.2700,6.6600,3300&heading=120&pitch=-15' },
  // One overview per resort added from config alone (Copernicus terrain outside France).
  { name: 'romme-alpin', query: 'resort=romme-alpin&at=60.3700,15.4000,650&heading=10&pitch=-12' },
  { name: 'niseko-annupuri', query: 'resort=niseko&at=42.8500,140.7200,700&heading=295&pitch=-6' },
  {
    name: 'zermatt-matterhorn',
    query: 'resort=zermatt&at=45.9830,7.7600,3300&heading=255&pitch=-4',
  },
  {
    name: 'whistler-blackcomb',
    query: 'resort=whistler-blackcomb&at=50.1350,-122.9200,1500&heading=200&pitch=-10',
  },
  { name: 'park-city', query: 'resort=park-city&at=40.6650,-111.4750,2500&heading=230&pitch=-10' },
  {
    name: 'snow-space-flachau',
    query: 'resort=snow-space-salzburg&at=47.3650,13.3900,1500&heading=185&pitch=-10',
  },
  {
    name: 'oberstdorf-fellhorn',
    query: 'resort=oberstdorf-kleinwalsertal&at=47.3700,10.2500,1800&heading=220&pitch=-10',
  },
  {
    name: 'garmisch-zugspitze',
    query: 'resort=garmisch-zugspitze&at=47.4700,11.0600,2200&heading=235&pitch=-5',
  },
  {
    name: 'grandvalira-soldeu',
    query: 'resort=grandvalira&at=42.5950,1.6900,2600&heading=200&pitch=-12',
  },
  {
    name: 'portes-du-soleil-avoriaz',
    query: 'resort=portes-du-soleil&at=46.1650,6.7450,2200&heading=40&pitch=-12',
  },
];

for (const view of VIEWS) {
  test(view.name, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

    // Views are of the 3 Vallées unless they pick a resort.
    const resort = view.query.includes('resort=') ? '' : 'resort=les-3-vallees&';
    await page.goto(`/?${resort}${view.query}`);
    await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 30, null, { timeout: 90_000 });
    // Hide the start overlay so the scene is visible.
    await page.evaluate(() => document.body.classList.add('flying'));
    await page.waitForTimeout(500);
    await page.screenshot({ path: `test-results/views/${view.name}.png` });

    expect(errors).toEqual([]);
  });
}

test('snowmobile', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  // On the sled in the chase view, parked on a gentle piste below the village (the low altitude drops it onto the snow).
  await page.addInitScript(() => {
    localStorage.setItem('ski-sim.mode', 'sled');
    localStorage.setItem('ski-sim.view', 'chase');
    Object.defineProperty(Document.prototype, 'pointerLockElement', {
      get: () => document.querySelector('#scene'),
    });
  });
  await page.goto('/?resort=les-3-vallees&at=45.29515,6.58412,2000&heading=300&pitch=-12');
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 30, null, { timeout: 90_000 });
  await page.evaluate(() => document.body.classList.add('flying'));
  // Swing the chase camera round to a three-quarter view from the front.
  await page.evaluate(() =>
    document.dispatchEvent(new MouseEvent('mousemove', { movementX: -1300 } as MouseEventInit)),
  );
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/views/snowmobile.png' });
  expect(errors).toEqual([]);
});

test('snowmobile-night', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  // 22:00, clock paused: the headlight lights the piste ahead.
  await page.addInitScript(() => {
    localStorage.setItem('ski-sim.mode', 'sled');
    localStorage.setItem('ski-sim.view', 'chase');
    localStorage.setItem('ski-sim.time-of-day', JSON.stringify({ seconds: 22 * 3600, rate: 0 }));
  });
  await page.goto('/?resort=les-3-vallees&at=45.29515,6.58412,2000&heading=140&pitch=-8');
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 30, null, { timeout: 90_000 });
  await page.evaluate(() => document.body.classList.add('flying'));
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/views/snowmobile-night.png' });
  expect(errors).toEqual([]);
});

test('labels for places behind the camera stay hidden', async ({ page }) => {
  // Facing NNE from Cime de Caron: the Orelle sector (Rocher Blanc, Télécabine d'Orelle)
  // is directly behind.
  await page.goto('/?resort=les-3-vallees&at=45.2632,6.5610,3210&heading=25&pitch=0');
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 30, null, { timeout: 90_000 });
  const shown = await page.locator('#labels .label:not([hidden]) .label-name').allTextContents();
  expect(shown).toContain('Mont Blanc / Monte Bianco');
  expect(shown).not.toContain('Rocher Blanc');
  expect(shown).not.toContain("Télécabine d'Orelle");
});
