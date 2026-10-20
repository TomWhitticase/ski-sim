import { expect, test } from '@playwright/test';

const fov = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window.__sim as unknown as { camera: { fov: number } }).camera.fov);

test('O opens settings: field of view and camera options apply live and persist', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  // Standing on skis on the frozen lake (flat, so no speed widening): flying is out of
  // body, with no first/third person to switch.
  await page.addInitScript(() => localStorage.setItem('ski-sim.mode', 'ski'));
  await page.goto('/?resort=les-3-vallees&at=45.28856,6.5752,2417.2&heading=90&pitch=-5');
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 30, null, { timeout: 90_000 });
  expect(await fov(page)).toBeCloseTo(85, 0); // first person by default

  const modal = page.locator('#opt-camera');
  await page.keyboard.press('KeyO');
  await expect(modal).toBeVisible();
  await modal.locator('input[name="fovFirst"]').fill('95');
  await expect(
    modal.locator('.setup-field').filter({ has: page.locator('input[name="fovFirst"]') }),
  ).toContainText('95°');
  await expect.poll(() => fov(page)).toBeCloseTo(95, 0);
  await modal.locator('input[name="speedFov"]').fill('0');
  await expect(
    modal.locator('.setup-field').filter({ has: page.locator('input[name="speedFov"]') }),
  ).toContainText('Off');
  await modal.locator('[data-invert="true"]').click();
  await page.screenshot({ path: 'test-results/views/settings-modal.png' });
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  await page.screenshot({ path: 'test-results/views/settings-wide-fov.png' });
  // Third person has its own (narrower) field of view.
  await page.keyboard.press('KeyV');
  await expect.poll(() => fov(page)).toBeCloseTo(70, 0);
  await page.keyboard.press('KeyV');
  await expect.poll(() => fov(page)).toBeCloseTo(95, 0);

  await page.reload();
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 30, null, { timeout: 90_000 });
  expect(await fov(page)).toBeCloseTo(95, 0);
  await page.locator('#open-settings').click();
  await expect(modal.locator('[data-invert="true"]')).toHaveAttribute('aria-checked', 'true');
  await modal.locator('.setup-reset').click();
  await expect.poll(() => fov(page)).toBeCloseTo(85, 0);
  await expect(modal.locator('[data-invert="false"]')).toHaveAttribute('aria-checked', 'true');
  expect(errors).toEqual([]);
});
