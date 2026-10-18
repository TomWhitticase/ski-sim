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
  await expect(page.locator('#hud [data-piste] span')).toHaveText('Cascades');
  const low = await altitude(page);
  await page.screenshot({ path: 'test-results/views/lift-chair-fp.png' });
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/views/lift-chair-chase.png' });

  // Fast-forward up the line (285 s ride, ×8).
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(6000);
  expect(await altitude(page)).toBeGreaterThan(low + 20); // climbing
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
    const read = () => {
      const m = new (mesh.matrix.constructor as typeof import('three').Matrix4)();
      mesh.getMatrixAt(0, m);
      return m.elements[12]! + m.elements[14]!;
    };
    const a = read();
    await new Promise((r) => setTimeout(r, 1000));
    return { a, b: read(), count: mesh.count };
  });
  expect(positions.count).toBeGreaterThan(20);
  expect(positions.a).not.toBeCloseTo(positions.b, 0); // moving

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
