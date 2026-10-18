import { expect, type Page, test } from '@playwright/test';

// A 21° slope above the village whose fall line points to bearing ~27°.
const SLOPE = 'at=45.2830,6.5760,2600&heading=27&pitch=-10';

async function start(page: Page, query: string) {
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'pointerLockElement', {
      get: () => document.querySelector('#scene'),
    });
  });
  await page.goto(`/?${query}`);
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10, null, { timeout: 90_000 });
  await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
}

const hudText = (page: Page, selector: string) =>
  page
    .locator(`#hud ${selector}`)
    .textContent()
    .then((t) => t ?? '');
const hudNumber = async (page: Page, field: string) =>
  parseFloat((await hudText(page, `[data-field="${field}"]`)).replace(/,/g, ''));

test('F drops you onto the snow in ski mode and gravity takes over', async ({ page }) => {
  await start(page, SLOPE);
  expect(await hudText(page, '[data-mode]')).toBe('FLY');

  await page.keyboard.press('KeyF');
  await page.waitForTimeout(100);
  expect(await hudText(page, '[data-mode]')).toBe('SKI');
  const top = await hudNumber(page, 'altitude');
  expect(top).toBeGreaterThan(2550); // on the snow (~2571 m), not 2600 m in the air
  expect(top).toBeLessThan(2590);

  await page.waitForTimeout(4000);
  const speed = await hudNumber(page, 'speed');
  expect(speed).toBeGreaterThan(30);
  expect(speed).toBeLessThan(140); // capped and sensible
  expect(await hudNumber(page, 'altitude')).toBeLessThan(top - 5); // ~25 m travelled from rest
  await page.screenshot({ path: 'test-results/views/ski-first-person.png' });

  await page.keyboard.press('KeyV');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/views/ski-chase.png' });

  // Snowplough to a stop.
  await page.keyboard.down('KeyS');
  await page.waitForTimeout(6000);
  await page.keyboard.up('KeyS');
  // (S brakes; on a 21° slope you may not fully stop, but you slow right down)
  expect(await hudNumber(page, 'speed')).toBeLessThan(speed);

  await page.keyboard.press('KeyF');
  await page.waitForTimeout(100);
  expect(await hudText(page, '[data-mode]')).toBe('FLY');
});

test('ski mode is remembered after a reload', async ({ page }) => {
  await start(page, SLOPE);
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10);
  expect(await hudText(page, '[data-mode]')).toBe('SKI');
});
