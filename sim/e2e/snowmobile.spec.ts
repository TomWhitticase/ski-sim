import { expect, type Page, test } from '@playwright/test';

// The frozen lake (under 15 cm of relief over 100 m; ice ~2415.5 m), facing east.
const LAKE = 'at=45.28856,6.5752,2418&heading=90&pitch=-5';

interface SledHandle {
  position: { x: number; y: number; z: number };
  sledHeading: number;
  speed: number;
  status: 'riding' | 'parked' | 'away';
  velocity: { x: number; z: number };
}

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
const sled = (page: Page) =>
  page.evaluate(() => {
    const s = (window.__sim as unknown as { sled: SledHandle }).sled;
    // Heading is clockwise from north; world x = east, z = -north.
    const h = (s.sledHeading * Math.PI) / 180;
    const f = { x: Math.sin(h), z: -Math.cos(h) };
    return {
      x: s.position.x,
      y: s.position.y,
      z: s.position.z,
      heading: s.sledHeading,
      speed: s.speed,
      status: s.status,
      /** Speed along the way the sled points (< 0 reversing). */
      forward: s.velocity.x * f.x + s.velocity.z * f.z,
    };
  });
const turned = (from: number, to: number) => Math.abs(((to - from + 540) % 360) - 180);

test('B gets on a snowmobile: W drives off across the lake and A/D steer', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await start(page, LAKE);
  await page.keyboard.press('KeyB');
  await page.waitForTimeout(150);
  expect(await mode(page)).toBe('SNOWMOBILE');
  await page.waitForTimeout(1200); // drop the last metre onto the ice and settle
  const parked = await sled(page);
  expect(parked.speed).toBeLessThan(0.5);
  expect(parked.y).toBeGreaterThan(2414);
  expect(parked.y).toBeLessThan(2417);
  await page.screenshot({ path: 'test-results/views/snowmobile-first-person.png' });

  await page.keyboard.down('KeyW');
  await page.waitForTimeout(3000);
  const driving = await sled(page);
  // The lake is off-piste, so this is powder: slower off the line than on a piste
  // (~5 m/s²), but past 30 km/h after three seconds.
  expect(
    await page.evaluate(
      () => (window.__sim as unknown as { sled: { inPowder: boolean } }).sled.inPowder,
    ),
  ).toBe(true);
  expect(await hudNumber(page, 'speed')).toBeGreaterThan(30);
  expect(driving.speed * 3.6).toBeLessThan(130);
  expect(Math.hypot(driving.x - parked.x, driving.z - parked.z)).toBeGreaterThan(15);
  expect(turned(parked.heading, driving.heading)).toBeLessThan(5); // straight on

  await page.keyboard.down('KeyA');
  await page.waitForTimeout(1200);
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'test-results/views/snowmobile-turn.png' });
  await page.keyboard.up('KeyA');
  const left = await sled(page);
  // A turns left: the heading (clockwise from north) goes down.
  expect(turned(driving.heading, left.heading)).toBeGreaterThan(25);
  expect((driving.heading - left.heading + 360) % 360 < 180).toBe(true);

  await page.keyboard.down('KeyD');
  await page.waitForTimeout(800);
  await page.keyboard.up('KeyD');
  const right = await sled(page);
  expect((right.heading - left.heading + 360) % 360 < 180).toBe(true); // D turns right
  await page.keyboard.up('KeyW');
  await page.screenshot({ path: 'test-results/views/snowmobile-chase.png' });
  expect(errors).toEqual([]);
});

test('S brakes to a stop, then holding it reverses', async ({ page }) => {
  await start(page, LAKE);
  await page.keyboard.press('KeyB');
  await page.waitForTimeout(1000);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2000);
  await page.keyboard.up('KeyW');
  const moving = await sled(page);
  expect(moving.forward).toBeGreaterThan(6);

  await page.keyboard.down('KeyS');
  await expect.poll(async () => (await sled(page)).forward, { timeout: 6000 }).toBeLessThan(0.5);
  // Keep holding: the reverse gear engages and you creep backwards.
  await expect.poll(async () => (await sled(page)).forward, { timeout: 4000 }).toBeLessThan(-1);
  const reversing = await sled(page);
  expect(reversing.forward).toBeGreaterThan(-3.5);
  await page.keyboard.up('KeyS');
});

test('B again steps off onto your skis; the sled stays parked and B gets back on', async ({
  page,
}) => {
  await start(page, LAKE);
  await page.keyboard.press('KeyB');
  await page.waitForTimeout(1200);
  const at = await sled(page);
  await page.keyboard.press('KeyB');
  await page.waitForTimeout(150);
  expect(await mode(page)).toBe('SKI');
  const parked = await sled(page);
  expect(parked.status).toBe('parked');
  await expect(page.locator('#prompt')).toHaveText(/get back on the snowmobile/);
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'test-results/views/snowmobile-parked.png' });

  await page.keyboard.press('KeyB');
  await page.waitForTimeout(150);
  expect(await mode(page)).toBe('SNOWMOBILE');
  const back = await sled(page);
  expect(Math.hypot(back.x - at.x, back.z - at.z)).toBeLessThan(1); // the same sled
});

test('snowmobile mode is remembered after a reload', async ({ page }) => {
  await start(page, LAKE);
  await page.keyboard.press('KeyB');
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10);
  expect(await mode(page)).toBe('SNOWMOBILE');
});
