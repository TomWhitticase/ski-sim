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

test('F switches to ski mode in mid-air: you fall, land and ski on', async ({ page }) => {
  // Flying ~29 m above a 21° slope (ground ~2571 m).
  await start(page, SLOPE);
  expect(await hudText(page, '[data-mode]')).toBe('FLY');

  await page.keyboard.press('KeyF');
  await page.waitForTimeout(100);
  expect(await hudText(page, '[data-mode]')).toBe('SKI');
  const switchedAt = await hudNumber(page, 'altitude');
  expect(switchedAt).toBeGreaterThan(2590); // not teleported to the ground

  await page.waitForTimeout(3000); // ~2.4 s of free fall, then on the snow
  const landed = await hudNumber(page, 'altitude');
  expect(landed).toBeLessThan(2575);
  await expect(page.locator('#hud [data-piste]')).toBeVisible();

  await page.waitForTimeout(2000);
  const speed = await hudNumber(page, 'speed');
  expect(speed).toBeGreaterThan(20); // skiing down the slope
  expect(speed).toBeLessThan(140); // capped and sensible
  expect(await hudNumber(page, 'altitude')).toBeLessThan(landed);
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

test('looking down in first person shows your skis', async ({ page }) => {
  await start(page, SLOPE);
  await page.keyboard.press('KeyF');
  // Look ~60° down (positive movementY pitches down).
  await page.evaluate(() =>
    document.dispatchEvent(new MouseEvent('mousemove', { movementY: 300 } as MouseEventInit)),
  );
  await page.keyboard.down('KeyS'); // snowplough so we stay put for the shot
  await page.waitForTimeout(600);
  const visible = await page.evaluate(() => {
    const scene = (window.__sim as unknown as { scene: import('three').Scene }).scene;
    const seen = (name: string) => {
      let o = scene.getObjectByName(name);
      while (o) {
        if (!o.visible) return false;
        o = o.parent ?? undefined;
      }
      return true;
    };
    return { kit: seen('kit'), body: seen('body') };
  });
  expect(visible).toEqual({ kit: true, body: false });
  await page.screenshot({ path: 'test-results/views/ski-look-down.png' });
  await page.keyboard.up('KeyS');
});
