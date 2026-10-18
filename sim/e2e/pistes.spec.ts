import { expect, type Page, test } from '@playwright/test';

async function load(page: Page, query = '') {
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'pointerLockElement', {
      get: () => document.querySelector('#scene'),
    });
  });
  await page.goto(`/${query}`);
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10, null, { timeout: 90_000 });
}

const run = (page: Page) => page.locator('#hud [data-piste] span');

test('teleporting to a piste puts you at its top, and the HUD names the run', async ({ page }) => {
  await load(page);
  await page.keyboard.press('KeyM');
  await page.locator('.map-search').fill('audzin');
  const item = page.locator('.map-place:not([hidden])').filter({ hasText: "Col de l'Audzin" });
  await expect(item.locator('.map-place-detail')).toContainText('Red');
  await item.click();
  await page.waitForTimeout(300);
  await expect(run(page)).toHaveText("Col de l'Audzin");

  // Ski it: skate off the gentle top (W), then gravity takes over on the run.
  await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
  await page.keyboard.press('KeyF');
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2500); // the top is nearly flat: skate over the crest
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(3000);
  await expect(run(page)).not.toHaveText('Off-piste');
  const speed = parseFloat((await page.locator('#hud [data-field="speed"]').textContent()) ?? '');
  expect(speed).toBeGreaterThan(8); // gentle 6-8° run-in: ~14 km/h after 3 s
});

test('off the pistes the HUD says so, and flying high hides the run row', async ({ page }) => {
  // East of the village, >80 m from any mapped run (checked against the lookup grid).
  await load(page, '?at=45.2870,6.5950,2500&heading=0&pitch=-10');
  await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
  await page.keyboard.press('KeyF'); // ski mode: stand on the snow there
  await page.waitForTimeout(300);
  await expect(run(page)).toHaveText('Off-piste');

  await page.evaluate(() => localStorage.clear()); // forget ski mode
  await load(page, '?at=45.2981,6.5803,3500&heading=0&pitch=0'); // 1 km above the village
  await page.waitForTimeout(300);
  await expect(page.locator('#hud .hud-piste')).toBeHidden();
});

test('O toggles piste colours and remembers the choice', async ({ page }) => {
  await load(page);
  const toggle = page.locator('#hud [data-toggle="pistes"] b');
  await expect(toggle).toHaveText('ON');
  await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
  await page.keyboard.press('KeyO');
  await expect(toggle).toHaveText('OFF');
  await page.reload();
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10);
  await expect(toggle).toHaveText('OFF');
});
