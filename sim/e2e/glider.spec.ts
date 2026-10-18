import { expect, type Page, test } from '@playwright/test';

// The 21° slope above the village (fall line ~27°).
const SLOPE = 'at=45.2830,6.5760,2600&heading=27&pitch=-5';

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

const mode = (page: Page) => page.locator('#hud [data-mode]').textContent();
const hudNumber = async (page: Page, field: string) =>
  parseFloat(
    ((await page.locator(`#hud [data-field="${field}"]`).textContent()) ?? '').replace(/,/g, ''),
  );

test('P deploys a paraglider mid-run, keeping your speed', async ({ page }) => {
  await start(page, SLOPE);
  await page.keyboard.press('KeyF'); // ski
  await page.waitForTimeout(4500); // build up speed
  const skiing = await hudNumber(page, 'speed');
  expect(skiing).toBeGreaterThan(30);

  await page.keyboard.press('KeyP');
  await page.waitForTimeout(150);
  expect(await mode(page)).toBe('GLIDE');
  // Horizontal momentum carries over (the downhill, vertical part becomes lift):
  // well above the wing's 38 km/h trim speed, not reset to zero.
  expect(await hudNumber(page, 'speed')).toBeGreaterThan(Math.max(38, skiing * 0.5));
  await page.screenshot({ path: 'test-results/views/glide-first-person.png' });
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/views/glide-chase.png' });

  // Bank left: a turning wing in third person.
  await page.keyboard.down('KeyA');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'test-results/views/glide-turn.png' });
  await page.keyboard.up('KeyA');
});

test('gliding down onto the snow lands you on your skis, still moving', async ({ page }) => {
  // ~8 m over the frozen lake (ground ~2415.5 m): a short glide to touchdown.
  await start(page, 'at=45.28856,6.5752,2425&heading=90&pitch=-10');
  await page.keyboard.press('KeyP');
  await page.waitForTimeout(200);
  expect(await mode(page)).toBe('GLIDE');
  await expect.poll(() => mode(page), { timeout: 20_000 }).toBe('SKI');
  expect(await hudNumber(page, 'speed')).toBeGreaterThan(5); // landed with forward speed
});

test('P again releases the wing and you drop on your skis', async ({ page }) => {
  await start(page, 'at=45.2981,6.5803,2600&heading=0&pitch=0'); // ~300 m above the village
  await page.keyboard.press('KeyP');
  await page.waitForTimeout(300);
  expect(await mode(page)).toBe('GLIDE');
  await page.keyboard.press('KeyP');
  await page.waitForTimeout(100);
  expect(await mode(page)).toBe('SKI');
});
