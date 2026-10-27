import { expect, type Page, test } from '@playwright/test';

// Roads (pipeline/roads.py, features/roads.ts): cleared asphalt with snowbanks and snow
// poles, snow-covered tracks in the terrain shader, the piste on top where they cross,
// and the roads on the world map.
const VIEWS = [
  // Val Thorens' streets from above the village, and the D 117's hairpins below it.
  { name: 'road-val-thorens-village', query: 'at=45.29930,6.57950,2420&heading=150&pitch=-32' },
  { name: 'road-val-thorens-hairpins', query: 'at=45.29900,6.57400,2420&heading=285&pitch=-18' },
  // Close up on a D 117 hairpin: ploughed banks (with gaps) and snow poles.
  { name: 'road-hairpin-banks', query: 'at=45.29967,6.56791,2185&heading=98&pitch=-15' },
  // The hairpins up to Courchevel 1850 and on to the altiport, and one close up.
  { name: 'road-courchevel-1850', query: 'at=45.41350,6.64250,1960&heading=225&pitch=-24' },
  { name: 'road-courchevel-hairpin', query: 'at=45.41040,6.63620,1850&heading=45&pitch=-15' },
  // A track under the snow above Val Thorens: packed, smoother snow, no asphalt.
  { name: 'road-snow-track', query: 'at=45.27786,6.59759,2671&heading=45&pitch=-20' },
  // Down the Méribel valley to Brides-les-Bains: roads beyond the meshes' range are the
  // terrain's.
  { name: 'road-valley-far', query: 'at=45.39500,6.57000,2300&heading=355&pitch=-10' },
  // Méribel: the Route du Belvédère under the Doron and Piou Piou runs (the piste wins).
  { name: 'road-piste-crossing', query: 'at=45.39440,6.57360,1745&heading=30&pitch=-38' },
];

async function load(page: Page, query: string) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`/?resort=les-3-vallees&${query}`);
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 30, null, { timeout: 90_000 });
  await page.evaluate(() => document.body.classList.add('flying'));
  return errors;
}

for (const view of VIEWS) {
  test(view.name, async ({ page }) => {
    const errors = await load(page, view.query);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `test-results/views/${view.name}.png` });
    expect(errors).toEqual([]);
  });
}

test('road tiles are built near the camera only', async ({ page }) => {
  await load(page, VIEWS[0]!.query);
  const counts = await page.evaluate(() => {
    const roads = (
      window.__sim as unknown as {
        scene: { getObjectByName(n: string): { children: { name: string; visible: boolean }[] } };
      }
    ).scene.getObjectByName('roads')!;
    const shown = roads.children.filter((c) => c.visible);
    return {
      surfaces: shown.filter((c) => c.name === 'road-surfaces').length,
      details: shown.filter((c) => c.name === 'road-details').length,
    };
  });
  // Within 3 km of the village: some, not all of the 3 Vallées' ~500 tiles.
  expect(counts.surfaces).toBeGreaterThan(3);
  expect(counts.surfaces).toBeLessThan(45);
  expect(counts.details).toBeGreaterThan(0);
  expect(counts.details).toBeLessThanOrEqual(counts.surfaces);
});

test('roads on the world map, in its key, and a drag stays fast', async ({ page }) => {
  await load(page, 'at=45.41500,6.63450,1900&heading=0&pitch=-10');
  await page.keyboard.press('KeyM');
  const map = page.locator('#world-map');
  await expect(map.locator('.map-key-list li', { hasText: 'Main road' })).toBeAttached();
  await expect(map.locator('.map-key-list li', { hasText: 'Road, cleared' })).toBeAttached();
  await expect(
    map.locator('.map-key-list li', { hasText: 'Road or track under snow' }),
  ).toBeAttached();
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/views/world-map-roads.png' });

  // A frame of a drag (draw, then a pixel read back so the canvas is really rasterised),
  // at the whole area, a valley and a village's zoom: with the roads, and without.
  const timings = await page.evaluate(() => {
    type Map = {
      mpp: number;
      centerEast: number;
      draw(): void;
      data: { roads?: unknown };
      roadLayer?: unknown;
      canvas: HTMLCanvasElement;
    };
    const wm = (window.__sim as unknown as { worldMap: Map }).worldMap;
    const ctx = wm.canvas.getContext('2d')!;
    const frame = (mpp: number) => {
      wm.mpp = mpp;
      const start = wm.centerEast;
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) {
        wm.centerEast = start + i * 3 * mpp; // a drag: 3 px a frame
        wm.draw();
        ctx.getImageData(0, 0, 1, 1);
      }
      wm.centerEast = start;
      return (performance.now() - t0) / 20;
    };
    const zooms = [40, 8, 1.5];
    for (const mpp of zooms) frame(mpp); // warm up (paths built, images decoded)
    const withRoads = zooms.map(frame);
    const roads = wm.data.roads;
    wm.data.roads = undefined;
    wm.roadLayer = undefined;
    const without = zooms.map(frame);
    wm.data.roads = roads;
    return { withRoads, without };
  });
  console.log('world map ms a frame at 40, 8, 1.5 m/px:', JSON.stringify(timings));
  // What the roads add (the readback makes the absolute numbers machine-bound).
  timings.withRoads.forEach((ms, i) => expect(ms - timings.without[i]!).toBeLessThan(12));

  const canvas = map.locator('canvas');
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/views/world-map-roads-courchevel.png' });
});
