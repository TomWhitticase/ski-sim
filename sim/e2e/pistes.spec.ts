import { expect, type Page, test } from '@playwright/test';

async function load(page: Page, query = '') {
  const resort = 'resort=les-3-vallees';
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'pointerLockElement', {
      get: () => document.querySelector('#scene'),
    });
  });
  await page.goto(query ? `/${query}&${resort}` : `/?${resort}`);
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10, null, { timeout: 90_000 });
}

const run = (page: Page) => page.locator('#run [data-piste] span');

test('teleporting to a piste puts you at its top, and the HUD names the run', async ({ page }) => {
  await load(page);
  await page.keyboard.press('KeyM');
  await page.locator('.map-search').fill('audzin');
  const item = page.locator('.map-place:not([hidden])').filter({ hasText: "Col de l'Audzin" });
  await expect(item.locator('.map-place-detail')).toContainText('Red');
  await item.click();
  await page.waitForTimeout(300);
  await expect(run(page)).toHaveText("Col de l'Audzin");
  // Controls are frozen while the camera flies there (GTA-style).
  await expect(page.locator('body')).not.toHaveClass(/sky-transition/, { timeout: 10_000 });

  // Ski it: skate off the gentle top (W), then gravity takes over on the run. (Heading
  // straight on you'd eventually meet the summit building: now solid, so track the
  // peak speed rather than the speed at one instant.)
  await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
  await page.keyboard.press('KeyF');
  await page.keyboard.down('KeyW');
  let peak = 0;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(250);
    const speed = parseFloat((await page.locator('#hud [data-field="speed"]').textContent()) ?? '');
    peak = Math.max(peak, speed);
  }
  await page.keyboard.up('KeyW');
  await expect(run(page)).not.toHaveText('Off-piste');
  expect(peak).toBeGreaterThan(15);
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
  await expect(page.locator('#run')).toBeHidden();
});

test('3 toggles piste colours and remembers the choice', async ({ page }) => {
  await load(page);
  const toggle = page.locator('#toggles [data-toggle="pistes"] b');
  await expect(toggle).toHaveText('ON');
  await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
  await page.keyboard.press('Digit3');
  await expect(toggle).toHaveText('OFF');
  await page.reload();
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10);
  await expect(toggle).toHaveText('OFF');
});
