import { expect, test } from '@playwright/test';

test('controls modal opens from the main menu, in sections, and closes with ✕ or Esc', async ({
  page,
}) => {
  await page.goto('/');
  const modal = page.locator('#opt-controls');
  await expect(modal).toBeHidden();
  await page.locator('#open-controls').click();
  await expect(modal).toBeVisible();
  await expect(modal.locator('h3:visible')).toHaveText([
    'Getting around',
    'Ski',
    'Drone',
    'Paraglider',
    'Snowmobile',
    'Plane',
    'Helicopter',
    'View & sound',
  ]);
  await expect(modal.locator('dt', { hasText: /^G$/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/views/controls-modal.png' });

  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  await expect(page.locator('#overlay')).toBeVisible(); // back to the menu

  await page.locator('#open-controls').click();
  await modal.locator('.modal-close').click();
  await expect(modal).toBeHidden();
});
