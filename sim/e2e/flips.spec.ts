import { expect, type Page, test } from '@playwright/test';

// A frozen lake: under 15 cm of height change across 100 m (ground ~2415.5 m).
const FLAT = 'at=45.28856,6.5752,2417.2&heading=90&pitch=-5';

interface Landing {
  flips: number;
  outcome: 'clean' | 'sketchy' | 'crash';
}
interface SkiHandle {
  feet: { x: number; y: number; z: number };
  velocity: { clone(): { set(x: number, y: number, z: number): unknown } };
  place(pose: object, velocity: unknown): void;
  airborne: boolean;
  crashed: boolean;
  lastLanding: Landing | null;
  state: { pitch: number; takeoffPitch: number };
}

async function start(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'pointerLockElement', {
      get: () => document.querySelector('#scene'),
    });
  });
  await page.goto(`/?${FLAT}`);
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10, null, { timeout: 90_000 });
  await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
  await page.keyboard.press('KeyF'); // ski mode, standing on the ice
  await page.waitForTimeout(500);
}

/** Throw the skier straight up off the lake at `up` m/s (2·up/g seconds of air). */
async function launch(page: Page, up: number) {
  await page.evaluate((up) => {
    const ski = (window.__sim as unknown as { ski: SkiHandle }).ski;
    const f = ski.feet;
    const pose = { east: f.x, north: -f.z, altitude: f.y + 1.7 + 0.6, heading: 90, pitch: -5 };
    ski.place(pose, ski.velocity.clone().set(4, up, 0)); // heading east across the ice
  }, up);
}

/**
 * Screenshot the skier once the rotation passes `degrees` (signed: negative for front
 * flips; null for right away). The skier is frozen in-page on that exact frame, since a Playwright round trip
 * takes long enough to rotate another 50°+. `side` swings the camera round to look at
 * the flip side-on.
 */
async function snapshot(page: Page, degrees: number | null, path: string, side = false) {
  await page.evaluate(
    ([d, side]) =>
      new Promise<void>((resolve) => {
        const ski = (window.__sim as unknown as { ski: SkiHandle & { update(): void } }).ski;
        const check = () => {
          const s = ski.state;
          const a = ((s.pitch - s.takeoffPitch) * 180) / Math.PI;
          if (d !== null && !(d > 0 ? a >= d : a <= d)) return requestAnimationFrame(check);
          ski.update = () => {}; // freeze (the frame loop keeps rendering)
          if (side) {
            // Heading east: look north at the centre of mass from 6 m south of it.
            const cam = (window.__sim as unknown as { camera: import('three').Camera }).camera;
            const c = (ski as unknown as { com: import('three').Vector3 }).com;
            cam.position.set(c.x, c.y + 0.6, c.z + 6);
            cam.lookAt(c);
          }
          resolve();
        };
        requestAnimationFrame(check);
      }),
    [degrees, side] as const,
  );
  await page.waitForTimeout(150); // a couple of rendered frames
  await page.screenshot({ path });
  await page.evaluate(() => {
    delete (window.__sim as unknown as { ski: { update?: unknown } }).ski.update;
  });
}

/**
 * Let go of `code` on the exact frame the rotation passes `degrees`, from inside the page:
 * a Playwright round trip (say, mid-flip screenshot) could otherwise release it late.
 */
const releaseAt = (page: Page, code: string, degrees: number) =>
  page.evaluate(
    ([code, d]) => {
      const check = () => {
        const s = (window.__sim as unknown as { ski: SkiHandle }).ski.state;
        const a = ((s.pitch - s.takeoffPitch) * 180) / Math.PI;
        if (d > 0 ? a >= d : a <= d) document.dispatchEvent(new KeyboardEvent('keyup', { code }));
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    },
    [code, degrees] as const,
  );

const landed = (page: Page) =>
  page
    .waitForFunction(() => {
      const ski = (window.__sim as unknown as { ski: SkiHandle }).ski;
      return !ski.airborne && ski.lastLanding;
    })
    .then(() =>
      page.evaluate(() => (window.__sim as unknown as { ski: SkiHandle }).ski.lastLanding!),
    );

test('holding ] off a big jump lands a backflip', async ({ page }) => {
  await start(page);
  await page.keyboard.press('KeyV'); // chase camera
  await launch(page, 10); // ~2 s of air
  await releaseAt(page, 'BracketRight', 290); // momentum and spotting bring it round
  await page.keyboard.down('BracketRight');
  await snapshot(page, 100, 'test-results/views/flip-back-chase.png');
  await snapshot(page, 160, 'test-results/views/flip-back-side.png', true);
  const landing = await landed(page);
  // Right after touchdown the model only settles the landing error, never unwinds the flip.
  const settle = await page.evaluate(
    () => (window.__sim as unknown as { ski: { flip: number } }).ski.flip,
  );
  await page.keyboard.up('BracketRight');
  expect(landing.flips).toBe(1);
  expect(landing.outcome).not.toBe('crash');
  expect(Math.abs(settle)).toBeLessThan(0.7);
  await page.screenshot({ path: 'test-results/views/flip-landed.png' });
  expect(
    await page.evaluate(() => (window.__sim as unknown as { ski: SkiHandle }).ski.crashed),
  ).toBe(false);
});

test('holding [ does a front flip', async ({ page }) => {
  await start(page);
  await page.keyboard.press('KeyV');
  await launch(page, 10);
  await releaseAt(page, 'BracketLeft', -290);
  await page.keyboard.down('BracketLeft');
  await snapshot(page, -110, 'test-results/views/flip-front-chase.png');
  await snapshot(page, -200, 'test-results/views/flip-front-side.png', true);
  const landing = await landed(page);
  await page.keyboard.up('BracketLeft');
  expect(landing.flips).toBe(-1);
  expect(landing.outcome).not.toBe('crash');
});

test('first person turns the view with the flip, and recovers on landing', async ({ page }) => {
  await start(page);
  await launch(page, 10);
  await releaseAt(page, 'BracketRight', 290);
  await page.keyboard.down('BracketRight');
  await snapshot(page, 200, 'test-results/views/flip-first-person.png');
  await landed(page);
  await page.keyboard.up('BracketRight');
  await page.waitForTimeout(300);
  // Back upright: the camera's up vector points up again.
  const up = await page.evaluate(() => {
    const cam = (window.__sim as unknown as { camera: import('three').Camera }).camera;
    const v = new (cam.position.constructor as typeof import('three').Vector3)(0, 1, 0);
    return v.applyQuaternion(cam.quaternion).y;
  });
  expect(up).toBeGreaterThan(0.9);
});

test('[ and ] lean you forward and back on the snow', async ({ page }) => {
  await start(page);
  await page.keyboard.press('KeyV');
  for (const [key, name] of [
    ['BracketLeft', 'forward'],
    ['BracketRight', 'back'],
  ]) {
    await page.keyboard.down(key!);
    await page.waitForTimeout(600);
    await snapshot(page, null, `test-results/views/lean-${name}-side.png`, true);
    await page.keyboard.up(key!);
  }
  expect(
    await page.evaluate(() => (window.__sim as unknown as { ski: SkiHandle }).ski.airborne),
  ).toBe(false);
});

test('over-rotating into the snow crashes, then you get back up', async ({ page }) => {
  await start(page);
  await page.keyboard.press('KeyV');
  await launch(page, 6); // ~1.2 s: not enough air for a full turn
  await page.keyboard.down('BracketRight');
  const landing = await landed(page);
  await page.keyboard.up('BracketRight');
  expect(landing.outcome).toBe('crash');
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'test-results/views/flip-crash.png' });
  // Up again within ~2 s.
  await page.waitForFunction(
    () => !(window.__sim as unknown as { ski: SkiHandle }).ski.crashed,
    null,
    { timeout: 3000 },
  );
});
