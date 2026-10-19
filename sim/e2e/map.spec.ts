import { expect, type Page, test } from '@playwright/test';

async function load(page: Page, query = '') {
  await page.goto(`/${query}`);
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10, null, { timeout: 90_000 });
}

async function fakePointerLock(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'pointerLockElement', {
      get: () => document.querySelector('#scene'),
    });
  });
}

const hudNumber = async (page: Page, field: string) =>
  parseFloat(
    ((await page.locator(`#hud [data-field="${field}"]`).textContent()) ?? '').replace(/,/g, ''),
  );

/** Eye height above the terrain right after a teleport: standing, not hovering. */
async function expectOnGround(page: Page) {
  await page.keyboard.press('F3');
  await expect(page.locator('#debug')).toContainText('ground');
  const debug = (await page.locator('#debug').textContent()) ?? '';
  const ground = parseFloat(/ground ([\d.]+) m/.exec(debug)![1]!);
  const altitude = await hudNumber(page, 'altitude');
  expect(altitude - ground).toBeGreaterThan(1);
  expect(altitude - ground).toBeLessThan(4);
}

test('your location is restored after a reload', async ({ page }) => {
  await fakePointerLock(page);
  await load(page, '?at=45.2981,6.5803,2800&heading=0&pitch=0');
  await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1500);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(1500); // let the periodic save run
  const lat = await hudNumber(page, 'lat');
  expect(lat).toBeGreaterThan(45.2983); // ~35 m north of the start

  await load(page); // no ?at=, so the saved pose should win over the spawn point
  expect(await hudNumber(page, 'lat')).toBeCloseTo(lat, 3);
  expect(await hudNumber(page, 'altitude')).toBeCloseTo(2800, -1);
});

test('M opens the map; search and teleport to a peak', async ({ page }) => {
  await load(page);
  await page.keyboard.press('KeyM');
  const map = page.locator('#world-map');
  await expect(map).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/views/world-map.png' });

  await page.locator('.map-search').fill('caron');
  const visible = page.locator('.map-place:not([hidden])');
  await expect(visible.first()).toBeVisible();
  const names = await visible.locator('.map-place-name').allTextContents();
  expect(names).toContain('Cime de Caron');
  expect(names.every((n) => n.toLowerCase().includes('caron'))).toBe(true);

  await visible.filter({ hasText: 'Cime de Caron' }).first().click();
  await expect(map).toBeHidden();
  await page.waitForTimeout(300);
  // Viewpoint is ~450 m from the summit (45.2632, 6.5610), standing on the ground.
  expect(await hudNumber(page, 'lat')).toBeCloseTo(45.266, 2);
  await expectOnGround(page);
});

test('clicking the map teleports you onto the ground there', async ({ page }) => {
  await load(page);
  await page.keyboard.press('KeyM');
  const canvas = page.locator('#world-map canvas');
  const box = (await canvas.boundingBox())!;
  // 200 px left of centre at the default 6 m/px is ~1.2 km west of the start.
  await page.mouse.click(box.x + box.width / 2 - 200, box.y + box.height / 2);
  await expect(page.locator('#world-map')).toBeHidden();
  await page.waitForTimeout(300);
  expect(await hudNumber(page, 'lon')).toBeLessThan(6.5803 - 0.012);
  await expectOnGround(page);
  expect(await hudNumber(page, 'lon')).toBeGreaterThan(6.5803 - 0.019);
});

test('a map teleport cuts up into the sky, pans across and cuts down (GTA-style)', async ({
  page,
}) => {
  await fakePointerLock(page);
  await load(page);
  await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
  const cameraY = () =>
    page.evaluate(
      () => (window.__sim as unknown as { camera: import('three').Camera }).camera.position.y,
    );
  const start = await cameraY();
  await page.keyboard.press('KeyM');
  await page.locator('.map-search').fill('caron');
  await page
    .locator('.map-place:not([hidden])')
    .filter({ hasText: 'Cime de Caron' })
    .first()
    .click();
  await expect(page.locator('body')).toHaveClass(/sky-transition/);

  // Up through three cuts: the camera ends up a couple of km above the ground.
  let highest = start;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(150);
    highest = Math.max(highest, await cameraY());
  }
  expect(highest - start).toBeGreaterThan(1500);
  await expect(page.locator('#labels')).toBeHidden();
  await page.screenshot({ path: 'test-results/views/teleport-sky.png' });
  await page.waitForTimeout(700);
  await page.screenshot({ path: 'test-results/views/teleport-down.png' });

  // Then down to you, standing at the viewpoint below Cime de Caron.
  await expect(page.locator('body')).not.toHaveClass(/sky-transition/, { timeout: 10_000 });
  await page.waitForTimeout(900); // the camera settles into your view
  const eye = await hudNumber(page, 'altitude');
  expect(Math.abs((await cameraY()) - eye)).toBeLessThan(1);
  await expect(page.locator('#labels')).toBeVisible();
});

test('Esc closes the map without teleporting', async ({ page }) => {
  await load(page);
  const before = await hudNumber(page, 'lat');
  await page.keyboard.press('KeyM');
  await page.keyboard.press('Escape');
  await expect(page.locator('#world-map')).toBeHidden();
  expect(await hudNumber(page, 'lat')).toBe(before);
});
