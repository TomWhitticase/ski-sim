import { expect, test } from '@playwright/test';

test('main menu: pick a ski area and where to start, then ski from there', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'pointerLockElement', {
      get: () => document.querySelector('#scene'),
    });
  });
  await page.goto('/');
  const menu = page.locator('#overlay');
  await expect(menu.locator('h1')).toHaveText('ski-sim');
  await expect(menu.locator('#menu-resorts .menu-item.selected')).toContainText('Les 3 Vallées');
  const starts = menu.locator('#menu-starts .menu-item-name');
  await expect(starts).toContainText(['Val Thorens']);
  const names = await starts.allTextContents();
  expect(names).toEqual(expect.arrayContaining(['Courchevel', 'Les Ménuires', 'Méribel-Mottaret']));

  const start = menu.locator('#start');
  await expect(start).toBeEnabled({ timeout: 90_000 });
  await expect(start).toHaveText('Start skiing');
  await page.screenshot({ path: 'test-results/views/main-menu.png' });

  await menu.locator('#menu-starts .menu-item', { hasText: 'Courchevel' }).first().click();
  await start.click();
  await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
  await page.waitForTimeout(500);
  await expect(page.locator('#hud [data-mode]')).toHaveText('SKI');
  // Courchevel 1850 is around 45.41 N, 6.63 E, standing beside its main lift.
  const lat = parseFloat((await page.locator('#hud [data-field="lat"]').textContent()) ?? '');
  const lon = parseFloat((await page.locator('#hud [data-field="lon"]').textContent()) ?? '');
  expect(lat).toBeGreaterThan(45.38);
  expect(lon).toBeGreaterThan(6.6);
  await expect(page.locator('#prompt')).toContainText('ride'); // a lift right in front of you
});
