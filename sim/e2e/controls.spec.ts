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

test('Ctrl does nothing in fly mode (no sprint): the wheel sets the speed', async ({ page }) => {
  await startFlying(page, 'at=45.2981,6.5803,2800&heading=0&pitch=0');
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1200);
  const cruising = (await hud(page)).speed;
  await page.keyboard.down('Control');
  await page.keyboard.up('Control');
  await page.waitForTimeout(1200);
  expect(cruising).toBeGreaterThan(195);
  expect(cruising).toBeLessThan(225); // 60 m/s = 216 km/h
  expect((await hud(page)).speed).toBeLessThan(230);
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

test('flying leaves your skier behind: F goes back to it, R skis from where you are', async ({
  page,
}) => {
  await startFlying(page, 'at=45.2981,6.5803,2800&heading=0&pitch=0');
  const mode = () => page.locator('#hud [data-mode]').textContent();
  const keys = page.locator('#fly-keys');
  const skierShown = () =>
    page.evaluate(() => {
      const scene = (window.__sim as unknown as { scene: import('three').Scene }).scene;
      return scene.getObjectByName('ski-left')!.parent!.visible;
    });
  const holdingController = () =>
    page.evaluate(() => {
      const scene = (window.__sim as unknown as { scene: import('three').Scene }).scene;
      const skier = scene.getObjectByName('ski-left')!.parent!;
      return skier.getObjectByName('drone-controller')!.visible;
    });
  // Flying with no body to go back to: F lands you, and that's all it offers.
  await expect(keys).toHaveText(/F\s*Ski from here/);
  await page.keyboard.press('KeyF');
  await expect.poll(mode).toBe('SKI');
  const left = await hud(page);

  // Out of body: the skier stays put (shown, with a tag, holding the drone's controller),
  // and you fly the drone.
  await page.keyboard.press('KeyF');
  await expect.poll(mode).toBe('DRONE');
  await expect(keys).toContainText('Back to your skier');
  await expect(keys).toContainText('Ski from here');
  expect(await skierShown()).toBe(true);
  expect(await holdingController()).toBe(true);
  await expect(page.locator('#fly-speed .lab').first()).toHaveText('Drone speed');
  await page.keyboard.press('KeyV'); // no first or third person while flying
  await expect(page.locator('#toggles [data-toggle="view"]')).toBeHidden();
  await hold(page, 'KeyW', 1200);
  expect((await hud(page)).lat).toBeGreaterThan(left.lat + 0.0003);
  await expect(page.locator('#labels .label-body')).toContainText('Your skier');
  await page.screenshot({ path: 'test-results/views/fly-out-of-body.png' });

  // F: back in the skier, right where it was.
  await page.keyboard.press('KeyF');
  await expect.poll(mode).toBe('SKI');
  const back = await hud(page);
  expect(await holdingController()).toBe(false);
  expect(Math.abs(back.lat - left.lat)).toBeLessThan(0.00005);
  expect(Math.abs(back.lon - left.lon)).toBeLessThan(0.00005);
  await expect(keys).toBeHidden();

  // R: the skier comes to you instead.
  await page.keyboard.press('KeyF');
  await hold(page, 'KeyW', 1200);
  const away = await hud(page);
  await page.keyboard.press('KeyR');
  await expect.poll(mode).toBe('SKI');
  const here = await hud(page);
  expect(Math.abs(here.lat - away.lat)).toBeLessThan(0.0002);
  expect(here.lat).toBeGreaterThan(left.lat + 0.0003);
  await expect(page.locator('#labels .label-body')).toBeHidden();
});

test('flying the drone, your skier stands holding its controller, watching the screen', async ({
  page,
}) => {
  // The frozen lake: flat, open ground.
  await page.addInitScript(() => localStorage.setItem('ski-sim.mode', 'ski'));
  await startFlying(page, 'at=45.28856,6.5752,2417.2&heading=90&pitch=-5');
  await page.waitForTimeout(1500); // settle on the snow
  await page.keyboard.press('KeyF');
  await expect(page.locator('#hud [data-mode]')).toHaveText('DRONE');
  await expect(page.locator('#hud .hud-speed .lab')).toContainText('DRONE');
  // Turn the drone round to look at the skier: `ahead` and `right` of them (m), `up`
  // above their feet, looking at their hands.
  const look = async (ahead: number, right: number, up: number, shot: string) => {
    await page.evaluate(
      ({ ahead, right, up }) => {
        type V = { x: number; y: number; z: number };
        const s = window.__sim as unknown as {
          ski: { feet: V; skier: { quaternion: V & { w: number } } };
          fly: { place: (p: object) => void };
        };
        const f = s.ski.feet;
        const q = s.ski.skier.quaternion;
        // Where the skier faces (-z of their root), flattened.
        const fx = -2 * (q.x * q.z + q.w * q.y);
        const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
        const len = Math.hypot(fx, fz);
        const [dx, dz] = [fx / len, fz / len];
        const x = f.x + dx * ahead - dz * right;
        const z = f.z + dz * ahead + dx * right;
        const hands = { x: f.x + dx * 0.3, y: f.y + 1.05, z: f.z + dz * 0.3 };
        const heading = (Math.atan2(hands.x - x, -(hands.z - z)) * 180) / Math.PI;
        const flat = Math.hypot(hands.x - x, hands.z - z);
        const pitch = (Math.atan2(hands.y - (f.y + up), flat) * 180) / Math.PI;
        s.fly.place({ east: x, north: -z, altitude: f.y + up, heading, pitch });
      },
      { ahead, right, up },
    );
    await page.waitForTimeout(800);
    await page.screenshot({ path: `test-results/views/${shot}.png` });
  };
  await look(1.9, 1.1, 1.7, 'drone-pilot');
  await look(-0.45, 0.55, 2.0, 'drone-pilot-screen'); // over the shoulder
  await expect(page.locator('#fly-keys')).toBeVisible();
  await page.locator('#fly-keys').screenshot({ path: 'test-results/views/drone-keys.png' });
});
