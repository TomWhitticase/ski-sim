import { expect, type Page, test } from '@playwright/test';

async function openMenu(page: Page) {
  await page.goto('/');
  await expect(page.locator('#start')).toBeEnabled({ timeout: 90_000 });
}

test('ski setup modal: choose a preset, tweak a ski, and it persists after reload', async ({
  page,
}) => {
  await openMenu(page);
  const modal = page.locator('#ski-setup-modal');
  await expect(modal).toBeHidden();
  await page.locator('#open-ski-setup').click();
  await expect(modal).toBeVisible();
  // Defaults to All-mountain.
  await expect(modal.locator('.setup-preset.selected')).toHaveText('All-mountain');

  await modal.locator('.setup-preset', { hasText: 'Giant slalom' }).click();
  await expect(modal.locator('.setup-preset.selected')).toHaveText('Giant slalom');
  await expect(modal.locator('input[name="length"]')).toHaveValue('188');
  await expect(modal.locator('[data-field="profile"] .selected')).toHaveText('Camber');
  await page.screenshot({ path: 'test-results/views/ski-setup-modal.png' });

  // Esc closes it.
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();

  await page.reload();
  await expect(page.locator('#start')).toBeEnabled({ timeout: 90_000 });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ski-sim.ski-setup')!));
  expect(saved).toMatchObject({ length: 188, waist: 68, profile: 'camber', wax: 'race' });
  await page.locator('#open-ski-setup').click();
  await expect(modal.locator('.setup-preset.selected')).toHaveText('Giant slalom');

  // Moving a slider makes it a custom setup; Reset goes back to All-mountain.
  await modal.locator('input[name="length"]').fill('170');
  await expect(modal.locator('.setup-preset.selected')).toHaveCount(0);
  await expect(modal.locator('.setup-field', { hasText: 'Length' })).toContainText('170 cm');
  await modal.locator('.setup-reset').click();
  await expect(modal.locator('.setup-preset.selected')).toHaveText('All-mountain');
  await modal.locator('.modal-footer .modal-close').click();
  await expect(modal).toBeHidden();
});

test('G opens the ski setup from the game and the skis change on the model', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'pointerLockElement', {
      get: () => document.querySelector('#scene'),
    });
  });
  await page.goto('/?at=45.28856,6.5752,2400&heading=0&pitch=-5');
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10, null, { timeout: 90_000 });
  await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
  const skiLength = () =>
    page.evaluate(() => {
      type Obj = {
        name: string;
        children: Obj[];
        geometry?: {
          boundingBox: { max: { z: number }; min: { z: number } } | null;
          computeBoundingBox(): void;
        };
      };
      const find = (o: Obj): Obj | undefined =>
        o.name === 'ski-left' ? o : o.children.map(find).find(Boolean);
      const ski = find((window.__sim as unknown as { scene: Obj }).scene)!.children[0]!;
      ski.geometry!.computeBoundingBox();
      const box = ski.geometry!.boundingBox!;
      return box.max.z - box.min.z;
    });
  expect(await skiLength()).toBeCloseTo(1.78, 2);

  await page.keyboard.press('KeyG');
  const modal = page.locator('#ski-setup-modal');
  await expect(modal).toBeVisible();
  await modal.locator('.setup-preset', { hasText: 'Park' }).click();
  expect(await skiLength()).toBeCloseTo(1.56, 2);
  await page.keyboard.press('KeyG');
  await expect(modal).toBeHidden();
});

test('chase view: skis in proportion to the skier, and following the setup', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'pointerLockElement', {
      get: () => document.querySelector('#scene'),
    });
    localStorage.setItem('ski-sim.mode', 'ski');
    localStorage.setItem('ski-sim.view', 'chase');
  });
  // The frozen lake: flat ground.
  await page.goto('/?at=45.28856,6.5752,1900&heading=90&pitch=-5');
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10, null, { timeout: 90_000 });
  await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
  // Hold S and swing the skis ~90° across for a side-on view.
  const sideOn = async (name: string) => {
    await page.keyboard.down('KeyS');
    await page.keyboard.down('KeyA');
    await page.waitForTimeout(450);
    await page.keyboard.up('KeyA');
    await page.waitForTimeout(800);
    await page.screenshot({ path: `test-results/views/${name}.png` });
    await page.keyboard.up('KeyS');
    await page.waitForTimeout(800);
  };
  await sideOn('ski-proportions');
  await page.keyboard.press('KeyG');
  await page.locator('.setup-preset', { hasText: 'Freeride' }).click();
  await page.keyboard.press('KeyG');
  await sideOn('ski-proportions-freeride');
});
