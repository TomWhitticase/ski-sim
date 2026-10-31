import { expect, type Page, test } from '@playwright/test';

// Pointer lock can't be granted headless, so fake it like the other control specs. A fresh
// context has no saved mode, which starts in the drone — seed skiing so we're on the snow.
async function enterGame(page: Page, query: string) {
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'pointerLockElement', {
      get: () => document.querySelector('#scene'),
    });
    if (!localStorage.getItem('ski-sim.mode')) localStorage.setItem('ski-sim.mode', 'ski');
  });
  const resort = query.includes('resort=') ? '' : 'resort=les-3-vallees&';
  await page.goto(`/?${resort}${query}`);
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10, null, { timeout: 90_000 });
  await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
}

const mode = (page: Page) => page.locator('#hud [data-mode]').textContent();

/** Whether the model is riding a board right now (the live ski controller). */
const onBoard = (page: Page) =>
  page.evaluate(
    () =>
      (window.__sim as unknown as { ski?: { model: { isSnowboard: boolean } } }).ski?.model
        .isSnowboard ?? false,
  );

test('G: switch to the board — the setup tab, HUD and model follow, and it persists', async ({
  page,
}) => {
  await enterGame(page, 'at=45.28856,6.5752,1900&heading=90&pitch=-5');
  // Starts on skis.
  expect(await mode(page)).toBe('SKI');
  expect(await onBoard(page)).toBe(false);

  await page.keyboard.press('KeyG');
  const modal = page.locator('#opt-ski');
  await expect(modal).toBeVisible();
  await modal.locator('.discipline-switch .setup-option', { hasText: 'Snowboard' }).click();
  await expect(modal).toContainText('Snowboard setup');
  await page.keyboard.press('KeyG');
  await expect(modal).toBeHidden();

  expect(await mode(page)).toBe('SNOWBOARD');
  expect(await onBoard(page)).toBe(true);

  await page.reload();
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10, null, { timeout: 90_000 });
  expect(await page.evaluate(() => localStorage.getItem('ski-sim.discipline'))).toBe('snowboard');
});

test('Y flips ski ↔ snowboard in game and lights the quick toggle', async ({ page }) => {
  await enterGame(page, 'at=45.28856,6.5752,1900&heading=90&pitch=-5');
  const toggle = page.locator('#toggles [data-toggle="discipline"]');
  expect(await mode(page)).toBe('SKI');
  await expect(toggle).not.toHaveClass(/\bon\b/);

  await page.keyboard.press('KeyY');
  expect(await mode(page)).toBe('SNOWBOARD');
  await expect(toggle).toHaveClass(/\bon\b/);

  await page.keyboard.press('KeyY');
  expect(await mode(page)).toBe('SKI');
  await expect(toggle).not.toHaveClass(/\bon\b/);
});

test('chase view: the boarder stands sideways across the board (no poles)', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('ski-sim.mode', 'ski');
    localStorage.setItem('ski-sim.view', 'chase');
    localStorage.setItem('ski-sim.discipline', 'snowboard');
  });
  await enterGame(page, 'at=45.28856,6.5752,1900&heading=90&pitch=-5');
  expect(await mode(page)).toBe('SNOWBOARD');
  // Hold S + A to swing the board ~90° across for a side-on view of the stance.
  await page.keyboard.down('KeyS');
  await page.keyboard.down('KeyA');
  await page.waitForTimeout(450);
  await page.keyboard.up('KeyA');
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-results/views/snowboard-stance.png' });
  await page.keyboard.up('KeyS');
});
