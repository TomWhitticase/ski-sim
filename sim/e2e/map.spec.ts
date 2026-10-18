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
  // Viewpoint is ~450 m from the summit (45.2632, 6.5610), 80 m above it.
  expect(await hudNumber(page, 'lat')).toBeCloseTo(45.266, 2);
  expect(await hudNumber(page, 'altitude')).toBeGreaterThan(3200);
});

test('clicking the map teleports to that spot above the ground', async ({ page }) => {
  await load(page);
  await page.keyboard.press('KeyM');
  const canvas = page.locator('#world-map canvas');
  const box = (await canvas.boundingBox())!;
  // 200 px left of centre at the default 6 m/px is ~1.2 km west of the start.
  await page.mouse.click(box.x + box.width / 2 - 200, box.y + box.height / 2);
  await expect(page.locator('#world-map')).toBeHidden();
  await page.waitForTimeout(300);
  expect(await hudNumber(page, 'lon')).toBeLessThan(6.5803 - 0.012);
  expect(await hudNumber(page, 'lon')).toBeGreaterThan(6.5803 - 0.019);
});

test('Esc closes the map without teleporting', async ({ page }) => {
  await load(page);
  const before = await hudNumber(page, 'lat');
  await page.keyboard.press('KeyM');
  await page.keyboard.press('Escape');
  await expect(page.locator('#world-map')).toBeHidden();
  expect(await hudNumber(page, 'lat')).toBe(before);
});
