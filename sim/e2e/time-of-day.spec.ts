import { expect, type Page, test } from '@playwright/test';

type Sim = {
  environment: { sun: { azimuth: number; elevation: number } };
  clock: { seconds: number; rate: number };
};
const sun = (page: Page) =>
  page.evaluate(() => (window.__sim as unknown as Sim).environment.sun.elevation);
const clockSeconds = (page: Page) =>
  page.evaluate(() => (window.__sim as unknown as Sim).clock.seconds);

async function load(page: Page, query: string) {
  await page.goto(`/?resort=les-3-vallees&${query}`);
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 30, null, { timeout: 90_000 });
}

test('time of day modal: preset, slider and speed move the sun, and persist after reload', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await load(page, 'at=45.3005,6.5765,2420&heading=150&pitch=-18');
  const modal = page.locator('#opt-time');
  await expect(modal).toBeHidden();
  await page.keyboard.press('KeyT');
  await expect(modal).toBeVisible();
  await expect(modal.locator('.setup-preset')).toHaveText([
    /^Sunrise · 0\d:\d\d$/,
    /^Morning/,
    /^Midday · 12:\d\d$/,
    /^Afternoon/,
    /^Sunset · 1[78]:\d\d$/,
    /^Night · 22:00$/,
  ]);

  await modal.locator('.setup-preset', { hasText: 'Midday' }).click();
  await expect(modal.locator('.setup-preset.selected')).toContainText('Midday');
  const noon = await sun(page);
  expect(noon).toBeGreaterThan(30);

  // The slider sets the time directly; 21:00 puts the sun below the horizon.
  await modal.locator('input[name="time"]').fill(String(21 * 3600));
  await expect(modal.locator('.setup-field .setup-value')).toHaveText('21:00');
  await expect(modal.locator('.setup-hint')).toContainText('below the horizon');
  await expect(page.locator('#clock')).toHaveText('21:00'); // above the minimap
  expect(await sun(page)).toBeLessThan(-10);

  // ×600 runs ten minutes a second, and the open slider follows the clock.
  await modal.locator('.setup-preset', { hasText: 'Sunset' }).click();
  await modal.locator('.setup-option', { hasText: '×600' }).click();
  await expect(modal.locator('.setup-option.selected')).toHaveText('×600');
  const before = await clockSeconds(page);
  const sunBefore = await sun(page);
  await page.waitForTimeout(1500);
  const advanced = (await clockSeconds(page)) - before;
  expect(advanced).toBeGreaterThan(600);
  expect(advanced).toBeLessThan(1200);
  expect(await sun(page)).toBeLessThan(sunBefore);
  const slider = Number(await modal.locator('input[name="time"]').inputValue());
  expect(Math.abs(slider - (await clockSeconds(page)))).toBeLessThan(300);
  await page.screenshot({ path: 'test-results/views/time-of-day-modal.png' });

  // Pause at 09:30, close with Esc, reload: the time and rate are remembered.
  await modal.locator('.setup-option', { hasText: 'Paused' }).click();
  await modal.locator('input[name="time"]').fill(String(9.5 * 3600));
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  const morning = await sun(page);
  await page.reload();
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 30, null, { timeout: 90_000 });
  expect(await clockSeconds(page)).toBe(9.5 * 3600);
  expect(await sun(page)).toBeCloseTo(morning, 3);
  await expect(page.locator('#clock')).toHaveText('09:30Paused');
  await page.keyboard.press('KeyT');
  await expect(modal.locator('.setup-option.selected')).toHaveText('Paused');
  await expect(modal.locator('.setup-field .setup-value')).toHaveText('09:30');
  await page.waitForTimeout(500);
  expect(await clockSeconds(page)).toBe(9.5 * 3600);
  expect(errors).toEqual([]);
});

test('T opens the time of day from the game and F3 shows the sun', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'pointerLockElement', {
      get: () => document.querySelector('#scene'),
    });
  });
  await load(page, 'at=45.28856,6.5752,2400&heading=0&pitch=-5');
  await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
  await page.keyboard.press('F3');
  await page.keyboard.press('KeyT');
  const modal = page.locator('#opt-time');
  await expect(modal).toBeVisible();
  await modal.locator('.setup-preset', { hasText: 'Night' }).click();
  await page.keyboard.press('KeyT');
  await expect(modal).toBeHidden();
  await expect(page.locator('#debug')).toContainText(/sun az [\d.]+° el -\d/);
});

// The same view through the day. Presets come from the real sun for the resort.
for (const preset of ['Sunrise', 'Midday', 'Sunset', 'Night']) {
  test(`view at ${preset.toLowerCase()}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await load(page, 'at=45.3005,6.5765,2420&heading=150&pitch=-18');
    await page.keyboard.press('KeyT');
    await page.locator('.setup-option', { hasText: 'Paused' }).click();
    await page.locator('.setup-preset', { hasText: preset }).click();
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.body.classList.add('flying'));
    await page.waitForTimeout(800);
    await page.screenshot({ path: `test-results/views/time-${preset.toLowerCase()}.png` });
    expect(errors).toEqual([]);
  });
}
