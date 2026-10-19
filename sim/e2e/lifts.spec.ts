import { expect, type Page, test } from '@playwright/test';

async function start(page: Page, query: string) {
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'pointerLockElement', {
      get: () => document.querySelector('#scene'),
    });
  });
  await page.goto(`/?${query}`);
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10, null, { timeout: 90_000 });
  await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
}

const mode = (page: Page) => page.locator('#hud [data-mode]').textContent();
const altitude = async (page: Page) =>
  parseFloat(
    ((await page.locator('#hud [data-field="altitude"]').textContent()) ?? '').replace(/,/g, ''),
  );

test('ride the Cascades chairlift to the top and ski off', async ({ page }) => {
  test.setTimeout(120_000);
  // Just beside the bottom station, on skis.
  await start(page, 'at=45.295119,6.577488,2256&heading=108&pitch=-5');
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(300);
  await expect(page.locator('#prompt')).toContainText('ride Cascades');

  await page.keyboard.press('KeyE');
  await page.waitForTimeout(1500);
  expect(await mode(page)).toBe('LIFT');
  await expect(page.locator('#run [data-piste] span')).toHaveText('Cascades');
  const low = await altitude(page);
  await page.screenshot({ path: 'test-results/views/lift-chair-fp.png' });
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/views/lift-chair-chase.png' });

  // Fast-forward up the line (285 s ride, ×8).
  await page.keyboard.down('KeyW');
  await expect.poll(() => altitude(page), { timeout: 20_000 }).toBeGreaterThan(low + 20);
  await expect.poll(() => mode(page), { timeout: 60_000 }).toBe('SKI');
  await page.keyboard.up('KeyW');
  expect(await altitude(page)).toBeGreaterThan(2540); // top station ~2566 m
});

test('gondola, cable car and platter carriers are running', async ({ page }) => {
  await start(page, 'at=45.2880,6.5845,2400&heading=300&pitch=-10'); // above the Moraine base
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/views/lift-gondola.png' });

  const positions = await page.evaluate(async () => {
    const scene = (window.__sim as unknown as { scene: import('three').Scene }).scene;
    const mesh = scene.getObjectByName('carriers-gondola-10') as import('three').InstancedMesh;
    // Total movement of all drawn cabins over a second (some crawl through stations).
    const read = () => {
      const m = new (mesh.matrix.constructor as typeof import('three').Matrix4)();
      const xs: number[] = [];
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m);
        xs.push(m.elements[12]! + m.elements[14]!);
      }
      return xs;
    };
    const a = read();
    await new Promise((r) => setTimeout(r, 1000));
    const b = read();
    return { moved: Math.max(...a.map((x, i) => Math.abs(x - b[i]!))), count: mesh.count };
  });
  expect(positions.count).toBeGreaterThan(20);
  expect(positions.moved).toBeGreaterThan(3); // cabins on the line move at ~6 m/s

  await start(page, 'at=45.2790,6.5626,2420&heading=10&pitch=-5'); // below Cime Caron
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/views/lift-cable-car.png' });

  await start(page, 'at=45.2810,6.5745,2500&heading=128&pitch=-12'); // Plateau platters
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/views/lift-platter.png' });
});

test('cable car: wait for the cabin, then ride it up', async ({ page }) => {
  test.setTimeout(180_000);
  await start(page, 'at=45.280569,6.562613,2320&heading=186&pitch=0');
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(300);
  await expect(page.locator('#prompt')).toContainText('ride Cime Caron');
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(300);
  expect(await mode(page)).toBe('LIFT');
  await page.keyboard.down('KeyW');
  await expect.poll(() => mode(page), { timeout: 150_000 }).toBe('SKI');
  await page.keyboard.up('KeyW');
  expect(await altitude(page)).toBeGreaterThan(3100); // Cime de Caron ~3170 m
});

test('S on a lift skips straight to the top', async ({ page }) => {
  await start(page, 'at=45.2877102,6.5831979,2352&heading=133&pitch=-5'); // Moraine base
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(300);
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(500);
  expect(await mode(page)).toBe('LIFT'); // on the loading point
  await page.keyboard.press('KeyS'); // works at any point once you've chosen the lift
  await page.waitForTimeout(500);
  expect(await mode(page)).toBe('SKI');
  expect(await altitude(page)).toBeGreaterThan(2780); // Moraine top ~2814 m
});

test('stand on the loading point and the chair scoops you up — no E needed', async ({ page }) => {
  test.setTimeout(150_000);
  // Cascades loading point (pad 2249.4 m), facing up the line.
  await start(page, 'at=45.2950838,6.5775386,2251.2&heading=108&pitch=-5');
  await page.keyboard.press('KeyF');
  await page.keyboard.press('KeyV');
  await expect(page.locator('#prompt')).toContainText('loading point');
  await expect.poll(() => mode(page), { timeout: 20_000 }).toBe('LIFT');
  await page.waitForTimeout(700); // settled into the seat
  await page.screenshot({ path: 'test-results/views/lift-scooped.png' });
  // Ride to the top (fast-forward), then you're released onto the snow, moving.
  await page.keyboard.down('KeyW');
  await expect.poll(() => mode(page), { timeout: 120_000 }).toBe('SKI');
  await page.keyboard.up('KeyW');
  expect(await altitude(page)).toBeGreaterThan(2555);
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/views/lift-unloaded.png' });
  const speed = parseFloat((await page.locator('#hud [data-field="speed"]').textContent()) ?? '');
  expect(speed).toBeGreaterThan(3); // skiing off down the ramp, not standing in the station
});

test('E puts you on the gondola loading point and you board as a cabin passes', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await start(page, 'at=45.2877102,6.5831979,2352&heading=133&pitch=-5'); // near the Moraine base
  await page.keyboard.press('KeyF');
  await expect(page.locator('#prompt')).toContainText('ride Moraine');
  const before = await page.locator('#hud [data-field="lat"]').textContent();
  await page.keyboard.press('KeyE');
  // Straight onto the loading point: no walk there.
  await expect(page.locator('#prompt')).toContainText('Waiting for');
  expect(await page.locator('#hud [data-field="lat"]').textContent()).not.toBe(before);
  await expect(page.locator('#prompt')).toContainText(/hold W to fast-forward · S to skip/, {
    timeout: 60_000,
  });
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-results/views/lift-gondola-boarded.png' });
});
