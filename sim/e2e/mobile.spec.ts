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

  /** Lift one finger. CDP's touchEnd releases the points it lists, so list only this one. */
  async lift(id: number) {
    const point = this.down.get(id)!;
    this.down.delete(id);
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [point] });
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

test('touch: the stick stays where the thumb landed; small tools; a tap on the minimap opens the map', async ({
  page,
}) => {
  await load(page, LAKE);
  const fingers = await Fingers.on(page);
  await tapToPlay(page, fingers);
  const stick = page.locator('#touch-stick');
  const placed = () =>
    stick.evaluate((el) => [(el as HTMLElement).style.left, (el as HTMLElement).style.top]);

  // Land at (150, 300) and run far past the ring to the right: full deflection, and the
  // stick doesn't creep after the thumb; the knob stays on the rim.
  await fingers.press(3, 150, 300);
  expect(await placed()).toEqual(['150px', '300px']);
  await fingers.move(3, 360, 300);
  await expect.poll(() => sim<number>(page, 'input.stickX')).toBeCloseTo(1, 2);
  expect(await placed()).toEqual(['150px', '300px']);
  const knob = await stick.locator('i').evaluate((el) => (el as HTMLElement).style.transform);
  expect(knob).toBe('translate(56px, 0px)');
  // Coming back a little past where it landed is a small push right (a base that had
  // followed the thumb out would read this as a hard left).
  // (Moves are delivered with the next frame, so wait for it.)
  await fingers.move(3, 172, 300);
  await expect.poll(() => sim<number>(page, 'input.stickX')).toBeLessThan(0.5);
  expect(await sim<number>(page, 'input.stickX')).toBeGreaterThan(0.1);
  await fingers.lift(3);

  // The tools: ~40 px at any size, still big enough to hit; "on" is a darker glass with a
  // light edge, not a block of accent blue.
  const sizes = async () =>
    page.locator('#touch-tools .touch-tool:visible').evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return [r.width, r.height];
      }),
    );
  for (const size of [LANDSCAPE, PORTRAIT, { width: 1180, height: 820 }]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(300);
    for (const [w, h] of await sizes()) {
      expect(w).toBeGreaterThanOrEqual(40);
      expect(w).toBeLessThanOrEqual(46);
      expect(h).toBe(w);
    }
  }
  await page.setViewportSize(LANDSCAPE);
  const on = page.locator('#touch-tools .touch-tool.on').first();
  await expect(on).toBeVisible();
  const look = await on.evaluate((el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, color: s.color, edge: s.boxShadow };
  });
  expect(look.bg).not.toBe('rgb(76, 194, 255)');
  expect(look.color).toBe('rgb(255, 255, 255)');
  expect(look.edge).toContain('inset');

  // Tap the minimap: the world map opens.
  const map = await centre(page, '#minimap');
  await fingers.tap(map.x, map.y);
  await expect(page.locator('#world-map')).toBeVisible();
  await shot(page, 'minimap-tap-map');
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

/**
 * Every frame from now: speed (km/h) and the skis' angle to the path (degrees, > 0 = swung
 * left), until `hockeyResult` reads them.
 */
const startHockeyLog = (page: Page) =>
  page.evaluate(() => {
    type Ski = { speed: number; velocity: { x: number; z: number }; skiYaw: number };
    const w = window as unknown as { __sim: { ski: Ski }; __hockey: number[][] };
    w.__hockey = [];
    const t0 = performance.now();
    const frame = () => {
      const { speed, velocity: v, skiYaw } = w.__sim.ski;
      const slip = skiYaw - Math.atan2(-v.x, -v.z);
      const deg = (Math.atan2(Math.sin(slip), Math.cos(slip)) * 180) / Math.PI;
      w.__hockey.push([performance.now() - t0, speed * 3.6, deg]);
      if (performance.now() - t0 < 3300) requestAnimationFrame(frame);
    };
    frame();
  });
/**
 * Timed from when the skis start to swing (so the touches' few frames of delivery don't
 * count): the share of speed kept 2 s later, and the skis' angle to the path from 0.6 s on.
 */
async function hockeyResult(page: Page) {
  await page.waitForTimeout(3400);
  const log = await page.evaluate(() => (window as unknown as { __hockey: number[][] }).__hockey);
  const slip0 = log[0]![2]!;
  const [t0, start] = log.find(([, , d]) => Math.abs(d! - slip0) > 10)!;
  const end = log.filter(([t]) => t! <= t0! + 2000).at(-1)![1]!;
  const slips = log.filter(([t]) => t! >= t0! + 600 && t! <= t0! + 2000).map(([, , d]) => d!);
  return {
    start: start!,
    kept: end / start!,
    minSlip: Math.min(...slips),
    maxSlip: Math.max(...slips),
  };
}

/** On the 21° slope, landed and running straight down at ~70 km/h. */
async function downTheSlope(page: Page) {
  await load(page, SLOPE);
  const fingers = await Fingers.on(page);
  await tapToPlay(page, fingers);
  await expect.poll(() => sim<boolean>(page, 'ski.airborne'), { timeout: 10_000 }).toBe(false);
  await page.waitForTimeout(5500);
  return fingers;
}

test('touch: Stop with the stick sideways is a hockey stop, as good as S + A', async ({ page }) => {
  // Keyboard and mouse first, for comparison: S + A (or D) swings the skis ~90°, then S
  // holds them. The slope isn't symmetrical, so each side is compared with its own.
  const keys = async (side: 'KeyA' | 'KeyD') => {
    await downTheSlope(page);
    await startHockeyLog(page);
    await page.keyboard.down('KeyS');
    await page.keyboard.down(side);
    await page.waitForTimeout(450);
    await page.keyboard.up(side);
    const result = await hockeyResult(page);
    await page.keyboard.up('KeyS');
    expect(result.start).toBeGreaterThan(50);
    return result;
  };
  const keysLeft = await keys('KeyA');
  const keysRight = await keys('KeyD');
  expect(keysLeft.kept).toBeLessThan(0.55);

  // Touch, Stop first: the thumb flicks the stick left and leaves it. The skis swing left,
  // square across the path, and stay there until Stop is let go.
  let fingers = await downTheSlope(page);
  await expect(page.locator('body')).toHaveClass(/touch/);
  const stop = await centre(page, '[data-touch="stop"]');
  await startHockeyLog(page);
  await fingers.press(1, stop.x, stop.y);
  await fingers.press(2, 150, 300);
  await fingers.move(2, 100, 305, 3);
  await fingers.lift(2);
  await page.waitForTimeout(700);
  await shot(page, 'ski-hockey-stop-landscape');
  const left = await hockeyResult(page);
  await fingers.lift(1);
  expect(left.start).toBeGreaterThan(50);
  expect(left.minSlip).toBeGreaterThan(80);
  expect(left.maxSlip).toBeLessThan(100);

  // Stick first (steering a little right), then Stop: a hockey stop to the right, upright.
  await page.setViewportSize(PORTRAIT);
  fingers = await downTheSlope(page);
  const stopUp = await centre(page, '[data-touch="stop"]');
  await startHockeyLog(page);
  await fingers.press(2, 120, 600);
  await fingers.move(2, 180, 595, 3);
  await fingers.press(1, stopUp.x, stopUp.y);
  await page.waitForTimeout(700);
  await shot(page, 'ski-hockey-stop-portrait');
  const right = await hockeyResult(page);
  await fingers.lift(1);
  await fingers.lift(2);
  expect(right.maxSlip).toBeLessThan(-80);
  expect(right.minSlip).toBeGreaterThan(-100);
  // As hard a stop as the keys': they hold the skis where you face, so on this slope the
  // path curves across it one way (a quicker stop) and back down it the other; touch keeps
  // the skis square to the path, about the same either way.
  console.log('hockey stop, speed kept 2 s in:', { keysLeft, keysRight, left, right });
  const keysAverage = (keysLeft.kept + keysRight.kept) / 2;
  expect(left.kept).toBeLessThan(keysAverage * 1.15);
  expect(right.kept).toBeLessThan(keysAverage * 1.15);
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

  // The marker's still set: its panel has a Go to marker button (J on a keyboard), naming
  // no key.
  await expect(page.locator('body')).not.toHaveClass(/sky-transition/, { timeout: 10_000 });
  const go = page.locator('#marker-hint .marker-go');
  await expect(go).toBeVisible();
  await expect(go).toHaveText('Go to marker');
  await expect(page.locator('#marker-hint kbd')).toBeHidden();
  await shot(page, 'marker-go-portrait');
  const marker = (await sim<{ east: number; north: number }>(page, 'waypoint.current'))!;
  await go.tap();
  await expect(page.locator('body')).not.toHaveClass(/sky-transition/, { timeout: 15_000 });
  const pose = await page.evaluate(() => {
    const s = window.__sim as unknown as { ski: { feet: { x: number; z: number } } };
    return { east: s.ski.feet.x, north: -s.ski.feet.z };
  });
  expect(Math.hypot(pose.east - marker.east, pose.north - marker.north)).toBeLessThan(5);

  // The map on its side: the panel down the right.
  await page.setViewportSize(LANDSCAPE);
  await page.waitForTimeout(300);
  const again = await centre(page, '[data-touch="map"]');
  await fingers.tap(again.x, again.y);
  await expect(page.locator('#world-map')).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, 'map-landscape');
  await page.locator('#world-map .map-close').tap();
  await expect(page.locator('#world-map')).toBeHidden();
  await expect(page.locator('#marker-hint .marker-go')).toBeVisible();
  await shot(page, 'marker-go-landscape');
});

test('touch: no Go to marker when teleporting is off', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem('ski-sim.rules', JSON.stringify({ teleport: false })),
  );
  await page.addInitScript(() =>
    localStorage.setItem('ski-sim.waypoint.les-3-vallees', JSON.stringify({ east: 0, north: 0 })),
  );
  await load(page, LAKE);
  const fingers = await Fingers.on(page);
  await tapToPlay(page, fingers);
  await expect(page.locator('body')).toHaveClass(/rules-no-teleport/);
  await expect(page.locator('#marker-hint')).toBeVisible();
  await expect(page.locator('#marker-hint .marker-go')).toBeHidden();
});

test('touch: the piste colours tool turns them on and off; labels still toggle', async ({
  page,
}) => {
  await load(page, LAKE);
  const fingers = await Fingers.on(page);
  await tapToPlay(page, fingers);
  const pistes = page.locator('[data-touch="pistes"]');
  const labels = page.locator('[data-touch="labels"]');
  const row = page.locator('#toggles [data-toggle="pistes"]');
  // The tests start with everything on (playwright.config.ts).
  await expect(pistes).toHaveClass(/\bon\b/);
  await expect(labels).toHaveClass(/\bon\b/);
  const tap = async (selector: string) => {
    const c = await centre(page, selector);
    await fingers.tap(c.x, c.y);
  };
  await tap('[data-touch="pistes"]');
  await expect(row).not.toHaveClass(/\bon\b/);
  await expect(pistes).not.toHaveClass(/\bon\b/);
  await tap('[data-touch="pistes"]');
  await expect(row).toHaveClass(/\bon\b/);
  await expect(pistes).toHaveClass(/\bon\b/);
  await tap('[data-touch="labels"]');
  await expect(labels).not.toHaveClass(/\bon\b/);
  await expect(page.locator('#toggles [data-toggle="lift"]')).not.toHaveClass(/\bon\b/);
  await expect(pistes).toHaveClass(/\bon\b/); // names only
  await tap('[data-touch="labels"]');
  await expect(labels).toHaveClass(/\bon\b/);
  await shot(page, 'tools-landscape');
  await page.setViewportSize(PORTRAIT);
  await page.waitForTimeout(400);
  await shot(page, 'tools-portrait');
  // Upright, the tool column stays clear of the minimap panel above it (with a marker's
  // panel too) and of the turn-sideways hint.
  await page.evaluate(() => {
    const s = window.__sim as unknown as {
      waypoint: { set(w: { east: number; north: number }): void };
    };
    s.waypoint.set({ east: 0, north: 0 });
  });
  await expect(page.locator('#marker-hint .marker-go')).toBeVisible();
  await expect(page.locator('#rotate-hint')).toBeVisible();
  await shot(page, 'tools-marker-portrait');
  const tools = (await page.locator('#touch-tools').boundingBox())!;
  const side = (await page.locator('.hud-side').boundingBox())!;
  const hint = (await page.locator('#rotate-hint').boundingBox())!;
  const stop = (await page.locator('[data-touch="stop"]').boundingBox())!;
  expect(tools.y).toBeGreaterThanOrEqual(side.y + side.height);
  expect(tools.y + tools.height).toBeLessThanOrEqual(stop.y);
  expect(hint.x + hint.width).toBeLessThanOrEqual(tools.x);
  expect(hint.y).toBeGreaterThanOrEqual(side.y + side.height);
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
  expect(await mode(page)).toBe('DRONE');
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

test('the helicopter and the plane by touch: buttons for collective, power and flaps, the stick flies', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await load(page, LAKE);
  const fingers = await Fingers.on(page);
  await tapToPlay(page, fingers);
  const flight = (field: string) => page.locator(`#flight [data-flight="${field}"]`).textContent();

  // The helicopter tool: one comes to you on the flat lake.
  const heliTool = await centre(page, '[data-touch="heli"]');
  await fingers.tap(heliTool.x, heliTool.y);
  await expect.poll(() => mode(page)).toBe('HELICOPTER');
  await expect(page.locator('[data-touch="climb"]')).toBeVisible();
  await expect(page.locator('[data-touch="jump"]')).toBeHidden();
  await expect(page.locator('[data-touch="sled"]')).toBeHidden();
  const ground = await hud(page, 'altitude');
  const climb = await centre(page, '[data-touch="climb"]');
  await fingers.press(1, climb.x, climb.y);
  await expect.poll(() => hud(page, 'altitude'), { timeout: 8000 }).toBeGreaterThan(ground + 10);
  await fingers.lift(1);
  // Stick forward: the cyclic, flying off.
  await fingers.press(2, 150, 300);
  await fingers.move(2, 150, 230);
  await expect
    .poll(async () => parseFloat((await flight('airspeed')) ?? '0'), { timeout: 8000 })
    .toBeGreaterThan(20);
  await shot(page, 'heli-landscape');
  await fingers.lift(2);
  await page.setViewportSize(PORTRAIT);
  await page.waitForTimeout(300);
  await shot(page, 'heli-portrait');
  await page.setViewportSize(LANDSCAPE);
  await page.waitForTimeout(300);
  // Down: it slows to a hover hands off and settles onto the snow; the tool gets you out.
  await page.waitForTimeout(8000);
  const down = await centre(page, '[data-touch="descend"]');
  await fingers.press(3, down.x, down.y);
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window.__sim as unknown as { heli: { canExit: boolean } }).heli.canExit,
        ),
      {
        timeout: 40_000,
      },
    )
    .toBe(true);
  await fingers.lift(3);
  // (The toolbar's changed since: the tools for other modes went.)
  const out = await centre(page, '[data-touch="heli"]');
  await fingers.tap(out.x, out.y);
  await expect.poll(() => mode(page)).toBe('SKI');

  // The plane tool: a Porter, with power, flaps and brake buttons.
  const planeTool = await centre(page, '[data-touch="plane"]');
  await fingers.tap(planeTool.x, planeTool.y);
  await expect.poll(() => mode(page)).toBe('PLANE');
  for (const id of ['power-up', 'power-down', 'flaps', 'brake']) {
    await expect(page.locator(`[data-touch="${id}"]`)).toBeVisible();
  }
  const flaps = await flight('flaps');
  const flapButton = await centre(page, '[data-touch="flaps"]');
  await fingers.tap(flapButton.x, flapButton.y);
  await expect.poll(() => flight('flaps')).not.toBe(flaps);
  const power = await centre(page, '[data-touch="power-up"]');
  await fingers.press(4, power.x, power.y);
  await page.waitForTimeout(1200);
  await fingers.lift(4);
  expect(parseFloat((await flight('power')) ?? '0')).toBeGreaterThan(40);
  await expect.poll(() => hud(page, 'speed'), { timeout: 8000 }).toBeGreaterThan(5);
  await shot(page, 'plane-landscape');
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

test.describe('iPad', () => {
  // An iPad on its side, emulated on Chromium (WebGPU). Safari's ✕ for leaving fullscreen
  // sits in the top-left corner and reports no safe area, so in fullscreen the pause
  // button and the stats move right of it.
  const ipad = devices['iPad Pro 11 landscape'];
  test.use({
    userAgent: ipad.userAgent,
    isMobile: ipad.isMobile,
    hasTouch: ipad.hasTouch,
    deviceScaleFactor: ipad.deviceScaleFactor,
    viewport: ipad.viewport,
  });

  test('in fullscreen nothing of ours sits under the browser exit button', async ({ page }) => {
    await load(page, LAKE);
    const fingers = await Fingers.on(page);
    await tapToPlay(page, fingers);
    const corner = async () =>
      page.evaluate(() =>
        ['#touch-pause', '.hud-stats', '#run', '#party']
          .map((s) => document.querySelector(s))
          .filter((el): el is Element => !!el && el.getClientRects().length > 0)
          .map((el) => el.getBoundingClientRect().left),
      );
    const before = await corner();
    expect(Math.min(...before)).toBeLessThan(40);
    await shot(page, 'ipad-windowed');

    const full = await centre(page, '[data-touch="fullscreen"]');
    await fingers.tap(full.x, full.y);
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
    await expect(page.locator('[data-touch="fullscreen"]')).toHaveClass(/\bon\b/);
    await page.waitForTimeout(400);
    // Where Safari draws its ✕ (about 44 px from the corner, both ways), outlined in the
    // screenshot for reference.
    const lefts = await corner();
    for (const left of lefts) expect(left).toBeGreaterThanOrEqual(60);
    await page.evaluate(() => {
      const x = document.createElement('div');
      x.id = 'safari-exit';
      x.style.cssText =
        'position:fixed;left:12px;top:12px;width:40px;height:40px;border-radius:50%;' +
        'background:rgba(60,60,67,.6);color:#fff;font:600 18px system-ui;display:grid;' +
        'place-items:center;z-index:99;pointer-events:none';
      x.textContent = '✕';
      document.body.append(x);
    });
    await shot(page, 'ipad-fullscreen');
    await page.evaluate(() => document.querySelector('#safari-exit')!.remove());

    await page.evaluate(() => document.exitFullscreen());
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
    await expect.poll(corner).toEqual(before);
  });
});
