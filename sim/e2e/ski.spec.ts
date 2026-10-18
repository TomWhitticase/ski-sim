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
  await page.keyboard.down('Shift');
  await page.waitForTimeout(6000);
  await page.keyboard.up('Shift');
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
  await page.keyboard.down('Shift'); // snowplough so we stay put for the shot
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
    return { skis: seen('ski-left') && seen('ski-right'), body: seen('body') };
  });
  expect(visible).toEqual({ skis: true, body: false });
  await page.screenshot({ path: 'test-results/views/ski-look-down.png' });
  await page.keyboard.up('Shift');
});

// A frozen lake: under 15 cm of height change across 100 m (ground ~2415.5 m).
const FLAT = 'at=45.28856,6.5752,2417.2&heading=90&pitch=-20';

test('W skates you up to speed on the flat; Ctrl tucks; Shift ploughs', async ({ page }) => {
  await start(page, FLAT);
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(500);
  expect(await hudNumber(page, 'speed')).toBeLessThan(3);

  await page.keyboard.down('KeyW');
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-results/views/ski-skate-fp.png' });
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(700);
  await page.screenshot({ path: 'test-results/views/ski-skate-chase.png' });
  await page.keyboard.up('KeyW');
  expect(await hudNumber(page, 'speed')).toBeGreaterThan(10); // skated to ~20 km/h

  await page.keyboard.down('Shift');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/views/ski-plough-chase.png' });
  await page.waitForTimeout(2500);
  expect(await hudNumber(page, 'speed')).toBeLessThan(4);
  await page.keyboard.up('Shift');

  await page.keyboard.down('Control');
  await page.waitForTimeout(700);
  await page.screenshot({ path: 'test-results/views/ski-tuck-chase.png' });
  await page.keyboard.up('Control');
});

test('carving tilts the skis onto their edges', async ({ page }) => {
  await start(page, SLOPE);
  await page.keyboard.press('KeyF');
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(3500); // build up speed
  await page.keyboard.down('KeyA');
  await page.waitForTimeout(450);
  await page.screenshot({ path: 'test-results/views/ski-carve-chase.png' });
  await page.keyboard.up('KeyA');
});
