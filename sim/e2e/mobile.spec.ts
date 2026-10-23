import { type CDPSession, devices, expect, type Page, test } from '@playwright/test';

// Phones and tablets: touch controls, no pointer lock, layouts that fit. Chromium's mobile
// emulation (touch, a coarse pointer) on the real GPU; touches go in through CDP so there
// can be several at once (stick + look, pinch). Screens are saved to test-results/mobile/.

// iPhone 14's emulation, on Chromium (for WebGPU) rather than its default WebKit.
const { userAgent, isMobile, hasTouch } = devices['iPhone 14'];
const LANDSCAPE = { width: 844, height: 390 };
const PORTRAIT = { width: 390, height: 844 };
test.use({ userAgent, isMobile, hasTouch, deviceScaleFactor: 2, viewport: LANDSCAPE });

// A frozen lake (flat, under 15 cm of relief over 100 m) and the 21° slope above the
// village whose fall line points to bearing ~27°.
const LAKE = 'at=45.28856,6.5752,2400&heading=0&pitch=-10';
const SLOPE = 'at=45.2830,6.5760,2600&heading=27&pitch=-10';
// Just beside the Cascades chairlift's bottom station.
const CASCADES = 'at=45.295119,6.577488,2256&heading=108&pitch=-5';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `test-results/mobile/${name}.png` });

/** Real multi-touch through CDP: each finger by id, every event lists those still down. */
class Fingers {
  private readonly down = new Map<number, { x: number; y: number; id: number }>();
  private constructor(private readonly cdp: CDPSession) {}

  static async on(page: Page): Promise<Fingers> {
    return new Fingers(await page.context().newCDPSession(page));
  }

  private send(type: 'touchStart' | 'touchMove' | 'touchEnd') {
    return this.cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: [...this.down.values()],
    });
  }

  async press(id: number, x: number, y: number) {
    this.down.set(id, { id, x, y });
    await this.send('touchStart');
  }

  async move(id: number, x: number, y: number, steps = 6) {
    const from = this.down.get(id)!;
    for (let i = 1; i <= steps; i++) {
      this.down.set(id, {
        id,
        x: from.x + ((x - from.x) * i) / steps,
        y: from.y + ((y - from.y) * i) / steps,
      });
      await this.send('touchMove');
    }
  }

  async lift(id: number) {
    this.down.delete(id);
    await this.send('touchEnd');
  }

  async tap(x: number, y: number) {
    await this.press(99, x, y);
    await this.lift(99);
  }
}

/** Load a pose on skis (or flying) and wait for the world to draw. */
async function load(page: Page, query: string, mode: 'ski' | 'fly' = 'ski') {
  await page.addInitScript((m) => localStorage.setItem('ski-sim.mode', m), mode);
  await page.goto(`/?resort=les-3-vallees&${query}`);
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10, null, { timeout: 90_000 });
}

/** Tap to play, as a phone does after loading. */
async function tapToPlay(page: Page, fingers: Fingers) {
  await expect(page.locator('#click-to-play')).toBeVisible();
  await expect(page.locator('#click-to-play')).toContainText('Tap to play');
  const box = (await page.locator('#click-to-play').boundingBox())!;
  await fingers.tap(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('body')).toHaveClass(/flying/);
}

const sim = <T>(page: Page, read: string) =>
  page.evaluate((r) => {
    const s = window.__sim as unknown as Record<string, Record<string, unknown>>;
    const [obj, key] = r.split('.') as [string, string];
    return s[obj]![key];
  }, read) as Promise<T>;
const hud = async (page: Page, field: string) =>
  parseFloat(
    ((await page.locator(`#hud [data-field="${field}"]`).textContent()) ?? '').replace(/,/g, ''),
  );
const mode = (page: Page) => page.locator('#hud [data-mode]').textContent();

/** Centre of a touch button. */
async function centre(page: Page, selector: string) {
  const box = (await page.locator(selector).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test('a phone gets touch controls: the stick skates and steers, a drag looks round', async ({
  page,
}) => {
  await load(page, LAKE);
  await expect(page.locator('body')).toHaveClass(/touch/);
  await shot(page, 'tap-to-play-landscape');
  const fingers = await Fingers.on(page);
  await tapToPlay(page, fingers);
  expect(await mode(page)).toBe('SKI');
  await expect(page.locator('#touch-pause')).toBeVisible();
  await expect(page.locator('[data-touch="jump"]')).toBeVisible();
  await expect(page.locator('[data-touch="up"]')).toBeHidden(); // fly mode's
  await page.waitForTimeout(500);
  await shot(page, 'ski-landscape');

  // Look: a finger dragged rightwards on the right half turns you right (heading goes up),
  // as the mouse does.
  const before = await sim<number>(page, 'ski.heading');
  await fingers.press(1, 560, 200);
  await fingers.move(1, 700, 200);
  await fingers.lift(1);
  await page.waitForTimeout(100);
  const turned = (((await sim<number>(page, 'ski.heading')) - before + 540) % 360) - 180;
  expect(turned).toBeGreaterThan(10);

  // Stick forward: skate off across the flat lake.
  await fingers.press(2, 150, 300);
  await fingers.move(2, 150, 230);
  await expect.poll(() => hud(page, 'speed'), { timeout: 5000 }).toBeGreaterThan(5);
  await expect(page.locator('#touch-stick')).toHaveClass(/active/);
  await shot(page, 'ski-stick-landscape');
  // Stick to the right as well: steering right while you go.
  const heading = await sim<number>(page, 'ski.heading');
  await fingers.move(2, 205, 240);
  await page.waitForTimeout(800);
  const steered = (((await sim<number>(page, 'ski.heading')) - heading + 540) % 360) - 180;
  expect(steered).toBeGreaterThan(15);
  await fingers.lift(2);

  // The same, upright.
  await page.setViewportSize(PORTRAIT);
  await page.waitForTimeout(600);
  await expect(page.locator('#rotate-hint')).toBeVisible();
  await shot(page, 'ski-portrait');
  await page.locator('#rotate-hint button').tap();
  await expect(page.locator('#rotate-hint')).toBeHidden();
});

test('touch: jump, tuck and flips on the snow, pause with the ⏸ button', async ({ page }) => {
  await load(page, SLOPE);
  const fingers = await Fingers.on(page);
  // Dropped on the slope from fly height: wait to land and get going.
  await tapToPlay(page, fingers);
  await expect.poll(() => sim<boolean>(page, 'ski.airborne'), { timeout: 10_000 }).toBe(false);

  // Tuck is a toggle, lit while you're tucked.
  const tuck = await centre(page, '[data-touch="tuck"]');
  await fingers.tap(tuck.x, tuck.y);
  await expect(page.locator('[data-touch="tuck"]')).toHaveClass(/on/);
  await expect.poll(() => sim<boolean>(page, 'ski.tucked')).toBe(true);
  await fingers.tap(tuck.x, tuck.y);
  await expect.poll(() => sim<boolean>(page, 'ski.tucked')).toBe(false);

  // Jump: airborne at once; the flip buttons replace jump, tuck and stop in the air.
  await page.evaluate(() => {
    const w = window as unknown as { __sawFlip: boolean; __sim: { ski: { airborne: boolean } } };
    w.__sawFlip = false;
    const watch = () => {
      const flip = document.querySelector<HTMLElement>('[data-touch="flip-fwd"]');
      if (w.__sim.ski.airborne && flip && !flip.hidden) w.__sawFlip = true;
      if (!w.__sawFlip) requestAnimationFrame(watch);
    };
    watch();
  });
  const jump = await centre(page, '[data-touch="jump"]');
  await fingers.press(3, jump.x, jump.y);
  await page.waitForTimeout(80);
  await fingers.lift(3);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __sawFlip: boolean }).__sawFlip), {
      timeout: 3000,
    })
    .toBe(true);

  // Stop: snowplough down the slope.
  await expect.poll(() => sim<boolean>(page, 'ski.airborne'), { timeout: 5000 }).toBe(false);
  await page.waitForTimeout(3000);
  const fast = await hud(page, 'speed');
  const stop = await centre(page, '[data-touch="stop"]');
  await fingers.press(4, stop.x, stop.y);
  await page.waitForTimeout(3000);
  await shot(page, 'ski-stop-landscape');
  expect(await hud(page, 'speed')).toBeLessThan(fast);
  await fingers.lift(4);

  // Pause: the menu over the world; Resume goes straight back.
  const pause = await centre(page, '#touch-pause');
  await fingers.tap(pause.x, pause.y);
  await expect(page.locator('#overlay')).toBeVisible();
  await expect(page.locator('#overlay')).toHaveAttribute('data-screen', 'pause');
  await shot(page, 'pause-landscape');
  await page.setViewportSize(PORTRAIT);
  await page.waitForTimeout(300);
  await shot(page, 'pause-portrait');
  await page.locator('#resume').tap();
  await expect(page.locator('body')).toHaveClass(/flying/);
  await expect(page.locator('#overlay')).toBeHidden();
});

test('touch map: pinch zooms, a tap drops the marker, touch and hold teleports', async ({
  page,
}) => {
  await page.setViewportSize(PORTRAIT);
  await load(page, LAKE);
  const fingers = await Fingers.on(page);
  await tapToPlay(page, fingers);
  const map = await centre(page, '[data-touch="map"]');
  await fingers.tap(map.x, map.y);
  await expect(page.locator('#world-map')).toBeVisible();
  await expect(page.locator('.map-hint.touch-only')).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, 'map-portrait');

  // Pinch out: zoomed in, so the scale bar's round distance gets shorter.
  const metres = async () => {
    const t = (await page.locator('.map-scale').textContent()) ?? '';
    return t.endsWith('km') ? parseFloat(t) * 1000 : parseFloat(t);
  };
  const wide = await metres();
  await fingers.press(1, 160, 250);
  await fingers.press(2, 230, 250);
  await fingers.move(1, 80, 250, 4);
  await fingers.move(2, 310, 250, 4);
  await fingers.lift(1);
  await fingers.lift(2);
  await page.waitForTimeout(100);
  expect(await metres()).toBeLessThan(wide);

  // A tap drops the guide marker there.
  expect(await sim<unknown>(page, 'waypoint.current')).toBeNull();
  await fingers.tap(195, 200);
  await expect.poll(() => sim<unknown>(page, 'waypoint.current')).not.toBeNull();

  // Touch and hold somewhere else: teleported there.
  const lat = await hud(page, 'lat');
  await fingers.press(3, 120, 330);
  await page.waitForTimeout(800);
  await fingers.lift(3);
  await expect(page.locator('#world-map')).toBeHidden();
  await expect.poll(() => hud(page, 'lat'), { timeout: 10_000 }).not.toBeCloseTo(lat, 4);

  // The map on its side: the panel down the right.
  await expect(page.locator('body')).not.toHaveClass(/sky-transition/, { timeout: 10_000 });
  await page.setViewportSize(LANDSCAPE);
  await page.waitForTimeout(300);
  const again = await centre(page, '[data-touch="map"]');
  await fingers.tap(again.x, again.y);
  await expect(page.locator('#world-map')).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, 'map-landscape');
});

test('touch: Ride boards the chairlift, Skip takes you to the top', async ({ page }) => {
  await load(page, CASCADES);
  const fingers = await Fingers.on(page);
  await tapToPlay(page, fingers);
  const prompt = page.locator('#prompt');
  await expect(prompt).toContainText('Ride Cascades');
  await expect(prompt).toHaveAttribute('data-key', 'KeyE');
  await shot(page, 'ride-prompt-landscape');
  await prompt.tap();
  await expect.poll(() => mode(page)).toBe('LIFT');
  await expect(page.locator('[data-touch="skip"]')).toBeVisible();
  await expect(page.locator('[data-touch="ff"]')).toBeVisible();
  await expect(page.locator('[data-touch="jump"]')).toBeHidden();
  await page.waitForTimeout(1500);
  await shot(page, 'ride-landscape');
  await page.setViewportSize(PORTRAIT);
  await page.waitForTimeout(300);
  await shot(page, 'ride-portrait');

  const low = await hud(page, 'altitude');
  const skip = await centre(page, '[data-touch="skip"]');
  await fingers.tap(skip.x, skip.y);
  await expect.poll(() => mode(page), { timeout: 30_000 }).toBe('SKI');
  expect(await hud(page, 'altitude')).toBeGreaterThan(low + 100);
});

test('touch: fly with up, down and speed buttons; the ways out are buttons too', async ({
  page,
}) => {
  await load(page, LAKE, 'fly');
  const fingers = await Fingers.on(page);
  await tapToPlay(page, fingers);
  expect(await mode(page)).toBe('FLY');
  await expect(page.locator('[data-touch="up"]')).toBeVisible();
  await expect(page.locator('[data-touch="jump"]')).toBeHidden();

  const low = await hud(page, 'altitude');
  const up = await centre(page, '[data-touch="up"]');
  await fingers.press(1, up.x, up.y);
  await page.waitForTimeout(1200);
  await fingers.lift(1);
  expect(await hud(page, 'altitude')).toBeGreaterThan(low + 20);

  const speed = (await page.locator('#fly-speed b').textContent()) ?? '';
  const faster = await centre(page, '[data-touch="faster"]');
  await fingers.tap(faster.x, faster.y);
  await expect(page.locator('#fly-speed b')).not.toHaveText(speed);
  await shot(page, 'fly-landscape');
  await page.setViewportSize(PORTRAIT);
  await page.waitForTimeout(300);
  await shot(page, 'fly-portrait');

  // "Ski from here" (F) is a button: down onto the snow.
  await page.locator('#fly-keys [data-key="KeyF"]').tap();
  await expect.poll(() => mode(page)).toBe('SKI');

  // Paraglider and snowmobile from the tools.
  await page.setViewportSize(LANDSCAPE);
  await page.waitForTimeout(300);
  const glider = await centre(page, '[data-touch="glider"]');
  await fingers.tap(glider.x, glider.y);
  await expect.poll(() => mode(page)).toBe('GLIDE');
  await page.waitForTimeout(500);
  await shot(page, 'glide-landscape');
  const sled = await centre(page, '[data-touch="sled"]');
  await fingers.tap(sled.x, sled.y);
  await expect.poll(() => mode(page)).toBe('SNOWMOBILE');
  await expect(page.locator('[data-touch="hang"]')).toBeVisible();
  // Throttle on the stick.
  await fingers.press(2, 150, 300);
  await fingers.move(2, 150, 230);
  await expect.poll(() => hud(page, 'speed'), { timeout: 8000 }).toBeGreaterThan(5);
  await shot(page, 'sled-landscape');
  await fingers.lift(2);
});

for (const [name, size] of [
  ['portrait', PORTRAIT],
  ['landscape', LANDSCAPE],
  ['tablet', { width: 820, height: 1180 }],
] as const) {
  test(`menus fit a ${name} screen`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/');
    await expect(page.locator('#title-play')).toBeVisible();
    // Nothing runs off the side; the buttons are big enough to hit.
    const fits = () =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    expect(await fits()).toBe(true);
    const play = (await page.locator('#title-play').boundingBox())!;
    expect(play.height).toBeGreaterThanOrEqual(44);
    expect(play.x + play.width).toBeLessThanOrEqual(size.width);
    await shot(page, `menu-title-${name}`);

    await page.locator('#title-play').tap();
    await expect(page.locator('#menu-resorts .resort-card').first()).toBeVisible();
    await page.locator('#menu-resorts .resort-card', { hasText: 'Les 3 Vallées' }).tap();
    const choose = page.locator('#choose-start');
    await expect(choose).toBeInViewport();
    // The list doesn't scroll sideways: the search box starts inside the card.
    const card = (await page.locator('.resorts-card').boundingBox())!;
    expect((await page.locator('#menu-search').boundingBox())!.x).toBeGreaterThanOrEqual(card.x);
    await page.waitForTimeout(400);
    await shot(page, `menu-resorts-${name}`);

    await choose.tap();
    await expect(page.locator('#menu-starts .menu-item').first()).toBeVisible();
    await expect(page.locator('#ski-from')).toBeInViewport();
    await page.waitForTimeout(400);
    await shot(page, `menu-starts-${name}`);

    await page.locator('#menu-back').tap();
    await page.locator('#menu-back').tap();
    await page.locator('#open-settings').tap();
    await expect(page.locator('#options')).toBeVisible();
    await expect(page.locator('#options .hub-close')).toBeInViewport();
    await page.locator('[data-tab="opt-controls"]').tap();
    await expect(page.locator('#opt-controls .touch-only')).toBeVisible();
    await shot(page, `menu-options-${name}`);
    await page.locator('#options .hub-close').tap();

    await page.locator('#open-multiplayer').tap();
    await expect(page.locator('#mp-panel')).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, `menu-multiplayer-${name}`);
  });
}

test('phones without WebGPU get the WebGL 2 renderer, with no errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`/?resort=les-3-vallees&webgl=1&${LAKE}`);
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 30, null, { timeout: 90_000 });
  const webgpu = await page.evaluate(
    () =>
      (window.__sim as unknown as { renderer: { backend: { isWebGPUBackend?: boolean } } }).renderer
        .backend.isWebGPUBackend ?? false,
  );
  expect(webgpu).toBe(false);
  await shot(page, 'webgl-landscape');
  expect(errors).toEqual([]);
});
