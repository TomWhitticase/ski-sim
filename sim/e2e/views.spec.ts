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
  // Chamonix, sector by sector, then the high-mountain lifts and the lidar's edges (where
  // RGE ALTI takes over in Switzerland and Italy).
  { name: 'chamonix-spawn', query: 'resort=chamonix' },
  {
    name: 'chamonix-grands-montets',
    query: 'resort=chamonix&at=45.9840,6.9150,2250&heading=125&pitch=-8',
  },
  {
    name: 'chamonix-brevent',
    query: 'resort=chamonix&at=45.9200,6.8800,2100&heading=310&pitch=-8',
  },
  { name: 'chamonix-flegere', query: 'resort=chamonix&at=45.9330,6.8700,2200&heading=20&pitch=-8' },
  {
    name: 'chamonix-aiguille-du-midi',
    query: 'resort=chamonix&at=45.8812,6.8925,3830&heading=232&pitch=-6',
  },
  {
    name: 'chamonix-panoramic',
    query: 'resort=chamonix&at=45.8560,6.9200,3650&heading=322&pitch=-4',
  },
  { name: 'chamonix-le-tour', query: 'resort=chamonix&at=45.9950,6.9300,2300&heading=55&pitch=-8' },
  {
    name: 'chamonix-les-houches',
    query: 'resort=chamonix&at=45.9000,6.8150,1800&heading=235&pitch=-8',
  },
  {
    name: 'chamonix-swiss-edge',
    query: 'resort=chamonix&at=46.0250,6.9400,2700&heading=60&pitch=-12',
  },
  {
    name: 'chamonix-italian-edge',
    query: 'resort=chamonix&at=45.8600,6.9100,3700&heading=150&pitch=-12',
  },
  // Tignes – Val d'Isère: the spawn, Tignes le Lac and its lake, the Grande Motte glacier,
  // and Val d'Isère village under Bellevarde.
  { name: 'tignes-spawn', query: 'resort=tignes-val-disere' },
  {
    name: 'tignes-le-lac',
    query: 'resort=tignes-val-disere&at=45.4610,6.8980,2350&heading=60&pitch=-14',
  },
  {
    name: 'tignes-grande-motte',
    query: 'resort=tignes-val-disere&at=45.4420,6.8950,3100&heading=190&pitch=-12',
  },
  {
    name: 'val-disere-village',
    query: 'resort=tignes-val-disere&at=45.4560,6.9900,2150&heading=240&pitch=-14',
  },
  // Le Grand Domaine: Valmorel's village and Saint-François-Longchamp under the Col de la
  // Madeleine.
  {
    name: 'grand-domaine-valmorel',
    query: 'resort=grand-domaine&at=45.4560,6.4380,1700&heading=40&pitch=-12',
  },
  {
    name: 'grand-domaine-st-francois',
    query: 'resort=grand-domaine&at=45.4050,6.3700,1900&heading=80&pitch=-12',
  },
  // Off-piste on the snow: the Pylônes freeride itineraries at Grands Montets, dashed.
  {
    name: 'chamonix-freeride-dashes',
    query: 'resort=chamonix&at=45.94036,6.94993,3500&heading=40&pitch=-25',
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
  {
    name: 'verbier-mont-fort',
    query: 'resort=verbier-4-vallees&at=46.0960,7.2280,2200&heading=110&pitch=-6',
  },
  { name: 'st-moritz', query: 'resort=st-moritz&at=46.4900,9.8600,2300&heading=300&pitch=-8' },
  {
    name: 'ischgl-idalp',
    query: 'resort=ischgl-samnaun&at=47.0250,10.2850,2400&heading=150&pitch=-10',
  },
  { name: 'soelden', query: 'resort=soelden&at=46.9750,11.0200,2000&heading=240&pitch=-6' },
  { name: 'les-2-alpes', query: 'resort=les-2-alpes&at=45.0300,6.1100,2200&heading=150&pitch=-8' },
  {
    name: 'sella-ronda-sella',
    query: 'resort=sella-ronda&at=46.5650,11.7800,2600&heading=120&pitch=-8',
  },
  {
    name: 'kitzbuehel-hahnenkamm',
    query: 'resort=kitzbuehel&at=47.4500,12.3700,1900&heading=240&pitch=-8',
  },
  {
    name: 'st-moritz-corvatsch',
    query: 'resort=st-moritz&at=46.4600,9.8500,3200&heading=210&pitch=-10',
  },
  { name: 'alpe-dhuez', query: 'resort=alpe-dhuez&at=45.0750,6.0400,2300&heading=70&pitch=-8' },
  { name: 'vail', query: 'resort=vail&at=39.6550,-106.3700,3000&heading=180&pitch=-10' },
  {
    name: 'jackson-hole',
    query: 'resort=jackson-hole&at=43.5800,-110.7900,2500&heading=270&pitch=-6',
  },
  // Snow parks: VT Park's halfpipe from below and the side, and Open Park's meandering lines.
  { name: 'park-halfpipe', query: 'at=45.27925,6.57367,2511&heading=136&pitch=-4' },
  { name: 'park-halfpipe-side', query: 'at=45.27908,6.57497,2544&heading=226&pitch=-18' },
  { name: 'park-lines', query: 'at=45.35213,6.57983,2301&heading=170&pitch=-22' },
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
