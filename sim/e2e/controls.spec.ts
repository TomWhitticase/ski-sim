import { expect, type Page, test } from '@playwright/test';

// Headless Chromium can't grant real pointer lock, so fake it before the controls check.
async function startFlying(page: Page, query: string) {
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'pointerLockElement', {
      get: () => document.querySelector('#scene'),
    });
  });
  const resort = query.includes('resort=') ? '' : 'resort=les-3-vallees&';
  await page.goto(`/?${resort}${query}`);
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10, null, { timeout: 90_000 });
  await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
}

async function hud(page: Page) {
  const text = async (field: string) =>
    (await page.locator(`#hud [data-field="${field}"]`).textContent()) ?? '';
  return {
    altitude: parseFloat((await text('altitude')).replace(/,/g, '')),
    lat: parseFloat(await text('lat')),
    lon: parseFloat(await text('lon')),
    speed: parseFloat(await text('speed')),
  };
}

async function hold(page: Page, key: string, ms: number) {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

test('W flies forward (north when facing north) and the HUD reports speed', async ({ page }) => {
  await startFlying(page, 'at=45.2981,6.5803,2800&heading=0&pitch=0');
  const before = await hud(page);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1500);
  const moving = await hud(page);
  await page.keyboard.up('KeyW');

  expect(moving.lat).toBeGreaterThan(before.lat);
  expect(Math.abs(moving.lon - before.lon)).toBeLessThan(0.0002);
  expect(moving.speed).toBeGreaterThan(50); // default 25 m/s = 90 km/h
  expect(moving.altitude).toBeCloseTo(before.altitude, -1);
});

test('Ctrl sprints while flying forward and stops when forward is released', async ({ page }) => {
  await startFlying(page, 'at=45.2981,6.5803,2800&heading=0&pitch=0');
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1200);
  const cruising = (await hud(page)).speed;
  await page.keyboard.down('Control');
  await page.keyboard.up('Control'); // a tap is enough; sprint sticks while W is held
  await page.waitForTimeout(1200);
  const sprinting = (await hud(page)).speed;
  expect(cruising).toBeGreaterThan(195);
  expect(cruising).toBeLessThan(225); // 60 m/s = 216 km/h
  expect(sprinting).toBeGreaterThan(cruising * 2.5); // x3

  await page.keyboard.up('KeyW');
  await page.waitForTimeout(300);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1500);
  expect((await hud(page)).speed).toBeLessThan(230); // sprint ended with the stop
  await page.keyboard.up('KeyW');
});

test('D strafes east when facing north', async ({ page }) => {
  await startFlying(page, 'at=45.2981,6.5803,2800&heading=0&pitch=0');
  const before = await hud(page);
  await hold(page, 'KeyD', 1000);
  expect((await hud(page)).lon).toBeGreaterThan(before.lon);
});

test('Space rises and Shift descends', async ({ page }) => {
  await startFlying(page, 'at=45.2981,6.5803,2800&heading=0&pitch=0');
  const start = await hud(page);
  await hold(page, 'Space', 1000);
  const up = await hud(page);
  expect(up.altitude).toBeGreaterThan(start.altitude + 10);
  await hold(page, 'Shift', 1500);
  expect((await hud(page)).altitude).toBeLessThan(up.altitude - 10);
});

test('cannot fly below the ground', async ({ page }) => {
  // Start just above the village (ground ~2300 m) and dive.
  await startFlying(page, 'at=45.2981,6.5803,2320&heading=0&pitch=0');
  await hold(page, 'Shift', 2500);
  const { altitude } = await hud(page);
  expect(altitude).toBeGreaterThan(2250);
  expect(altitude).toBeLessThan(2330);
});

test('mouse turns the view', async ({ page }) => {
  await startFlying(page, 'at=45.2981,6.5803,2800&heading=0&pitch=0');
  // Turn right ~90° (movementX is ignored by mouse.move in headless; dispatch directly).
  await page.evaluate(() => {
    document.dispatchEvent(new MouseEvent('mousemove', { movementX: 714 } as MouseEventInit));
  });
  const before = await hud(page);
  await hold(page, 'KeyW', 1000);
  const after = await hud(page);
  expect(after.lon).toBeGreaterThan(before.lon); // now flying east
  expect(Math.abs(after.lat - before.lat)).toBeLessThan(0.0002);
});

test('1 and 2 toggle lift and peak names, and the choice persists', async ({ page }) => {
  await startFlying(page, 'at=45.2981,6.5803,2700&heading=200&pitch=-8');
  const shown = (kind: string) => page.locator(`#labels .label-${kind}:not([hidden])`).count();
  const toggle = (kind: string) => page.locator(`#opt-display [data-toggle="${kind}"]`);

  await page.waitForTimeout(500);
  expect(await shown('lift')).toBeGreaterThan(3);
  expect(await shown('peak')).toBeGreaterThan(3);
  await expect(toggle('lift')).toHaveAttribute('aria-checked', 'true');

  await page.keyboard.press('Digit1');
  await page.waitForTimeout(200);
  expect(await shown('lift')).toBe(0);
  expect(await shown('peak')).toBeGreaterThan(3);
  await expect(toggle('lift')).toHaveAttribute('aria-checked', 'false');

  await page.keyboard.press('Digit2');
  await page.waitForTimeout(200);
  expect(await shown('peak')).toBe(0);

  await page.reload();
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10);
  await expect(toggle('lift')).toHaveAttribute('aria-checked', 'false');
  await expect(toggle('peak')).toHaveAttribute('aria-checked', 'false');
  expect(await shown('lift')).toBe(0);
});

test('4 toggles mountain restaurant names, and the choice persists', async ({ page }) => {
  // Looking at Krazy Kanguruh and Mooserwirt above St. Anton.
  await startFlying(page, 'resort=arlberg&at=47.129080,10.256784,1467&heading=328&pitch=-10');
  const shown = () => page.locator('#labels .label-restaurant:not([hidden])');
  const toggle = page.locator('#opt-display [data-toggle="restaurant"]');
  await page.waitForTimeout(500);
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(shown().filter({ hasText: 'Krazy Kanguruh' })).toHaveCount(1);
  await page.keyboard.press('Digit4');
  await page.waitForTimeout(200);
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  expect(await shown().count()).toBe(0);
  expect(await page.locator('#labels .label-lift:not([hidden])').count()).toBeGreaterThan(0);
  await page.reload();
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10);
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  expect(await shown().count()).toBe(0);
});

test('the fly speed is shown, and the mouse wheel changes it', async ({ page }) => {
  await startFlying(page, 'at=45.2981,6.5803,2800&heading=0&pitch=0');
  const shown = page.locator('#fly-speed');
  await expect(shown).toBeVisible();
  await expect(shown.locator('b')).toHaveText('216 km/h');
  await page.mouse.move(800, 450);
  await page.mouse.wheel(0, -100); // wheel up: faster
  await page.waitForTimeout(100);
  await expect(shown.locator('b')).toHaveText('248 km/h');
  await page.mouse.wheel(0, 100);
  await page.mouse.wheel(0, 100);
  await page.waitForTimeout(100);
  await expect(shown.locator('b')).toHaveText('188 km/h');
  await page.keyboard.press('KeyF'); // skiing: no fly speed
  await expect(shown).toBeHidden();
});

test('V switches fly mode to third person and back', async ({ page }) => {
  await startFlying(page, 'at=45.2981,6.5803,2800&heading=0&pitch=0');
  const state = () =>
    page.evaluate(() => {
      const sim = window.__sim as unknown as {
        scene: import('three').Scene;
        camera: import('three').Camera;
      };
      return {
        skier: sim.scene.getObjectByName('body')!.parent!.visible,
        pegman: sim.scene.getObjectByName('pegman')!.visible,
        cameraZ: sim.camera.position.z,
      };
    });
  const firstPerson = await state();
  expect(firstPerson.skier).toBe(false);
  expect(firstPerson.pegman).toBe(false);

  await page.keyboard.press('KeyV');
  await page.waitForTimeout(200);
  const chase = await state();
  // Flying in third person you're the yellow Street View man, not the skier.
  expect(chase.pegman).toBe(true);
  expect(chase.skier).toBe(false);
  // Facing north (-z), the camera sits a few metres behind (south, +z).
  expect(chase.cameraZ - firstPerson.cameraZ).toBeGreaterThan(2);
  await page.screenshot({ path: 'test-results/views/fly-third-person.png' });

  // Flying still moves you, with the camera following.
  const before = await hud(page);
  await hold(page, 'KeyW', 800);
  expect((await hud(page)).lat).toBeGreaterThan(before.lat);

  await page.keyboard.press('KeyV');
  await page.waitForTimeout(200);
  expect((await state()).skier).toBe(false);
});
