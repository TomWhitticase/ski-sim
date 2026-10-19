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
];

for (const view of VIEWS) {
  test(view.name, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

    await page.goto(`/?resort=les-3-vallees&${view.query}`);
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
