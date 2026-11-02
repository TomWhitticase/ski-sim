import { type Page, test } from '@playwright/test';

// Snowboard pose review: drives the rider into each situation for real (physics, keys), freezes
// the controller on that frame and renders it from fixed angles round the board. Not part of the
// normal run: `REVIEW=before|after pnpm exec playwright test e2e/snowboard-review.spec.ts`
// writes test-results/snowboard-review/<REVIEW>/<situation>-<angle>.png (or under REVIEW_OUT),
// and `node scripts/snowboard-review.mjs <dir>` builds the contact sheet from them.
const REVIEW = process.env.REVIEW;
test.skip(!REVIEW, 'set REVIEW=before|after to render the snowboard review');
test.describe.configure({ mode: 'serial' });

// Playwright clears test-results/ at the start of every run, so a review can be rendered
// elsewhere (REVIEW_OUT) and gathered into the contact sheet afterwards.
const OUT = `${process.env.REVIEW_OUT ?? 'test-results/snowboard-review'}/${REVIEW}`;
const FLAT = 'at=45.28856,6.5752,1900&heading=90&pitch=-5'; // the frozen lake
// A 21° slope above the village whose fall line points to bearing ~27°.
const SLOPE = 'at=45.2830,6.5760,2600&heading=27&pitch=-10';
const CHAIR = 'at=45.295119,6.577488,2256&heading=108&pitch=-5'; // beside Cascades' bottom

type Angle = 'toe' | 'heel' | 'nose' | 'tail' | 'above' | 'three-quarter' | 'legs';
const ALL: Angle[] = ['toe', 'heel', 'nose', 'tail', 'above', 'three-quarter', 'legs'];
const FEW: Angle[] = ['toe', 'heel', 'three-quarter', 'legs'];

interface Opts {
  goofy?: boolean;
  view?: 'chase' | 'first-person';
  touch?: boolean;
}

async function enter(page: Page, query: string, opts: Opts = {}) {
  await page.addInitScript(
    ({ goofy, view }) => {
      Object.defineProperty(Document.prototype, 'pointerLockElement', {
        get: () => document.querySelector('#scene'),
      });
      localStorage.setItem('ski-sim.mode', 'ski');
      localStorage.setItem('ski-sim.view', view);
      localStorage.setItem('ski-sim.discipline', 'snowboard');
      localStorage.setItem(
        'ski-sim.board-setup',
        JSON.stringify({
          stance: goofy ? 'goofy' : 'regular',
          length: 156,
          waist: 252,
          radius: 8,
          flex: 6,
          angleFront: 15,
          angleBack: -6,
        }),
      );
      localStorage.setItem('ski-sim.time-of-day', JSON.stringify({ time: 11.5, rate: 0 }));
    },
    { goofy: !!opts.goofy, view: opts.view ?? 'chase' },
  );
  await page.goto(`/?resort=les-3-vallees&${query}${opts.touch ? '&touch=1' : ''}`);
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10, null, { timeout: 90_000 });
  await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
  await page.addStyleTag({
    content: '#hud, #labels, .world-label, #click-to-play { visibility: hidden !important; }',
  });
  await page.waitForTimeout(800);
}

type Sim = Record<string, unknown>;

/** Set off from where the rider stands: heading (deg from north), speed along it (m/s). */
async function launch(page: Page, heading: number, speed: number, travel = heading) {
  await page.evaluate(
    ([heading, speed, travel]) => {
      const sim = window.__sim as unknown as Sim;
      const ski = sim.ski as {
        feet: import('three').Vector3;
        velocity: import('three').Vector3;
        place(p: object, v?: import('three').Vector3): void;
      };
      const f = ski.feet;
      const t = (travel * Math.PI) / 180;
      const v = ski.velocity.clone().set(Math.sin(t) * speed, 0, -Math.cos(t) * speed);
      ski.place({ east: f.x, north: -f.z, altitude: f.y + 1.7, heading, pitch: -5 }, v);
    },
    [heading, speed, travel] as const,
  );
}

/** Freeze the controllers on the next frame where `until` holds (in-page, no round trip). */
async function freeze(page: Page, until = 'true', timeout = 8000) {
  await page.evaluate(
    ([until, timeout]) =>
      new Promise<void>((resolve) => {
        const sim = window.__sim as unknown as Sim;
        const ski = sim.ski as Record<string, unknown>;
        const ok = new Function('ski', `return (${until});`) as (s: unknown) => boolean;
        const t0 = performance.now();
        const check = () => {
          if (!ok(ski) && performance.now() - t0 < timeout) return requestAnimationFrame(check);
          for (const k of ['ski', 'ride', 'fly']) {
            const c = sim[k] as { update?: unknown } | undefined;
            if (c) c.update = () => {};
          }
          resolve();
        };
        requestAnimationFrame(check);
      }),
    [until, timeout] as const,
  );
}

async function unfreeze(page: Page) {
  await page.evaluate(() => {
    const sim = window.__sim as unknown as Sim;
    for (const k of ['ski', 'ride', 'fly']) delete (sim[k] as { update?: unknown }).update;
  });
}

/** Camera round the rider, in the board's frame (x toward the toe edge of a regular rider). */
async function shoot(page: Page, name: string, angles: Angle[] = ALL) {
  for (const angle of angles) {
    await page.evaluate((angle) => {
      const sim = window.__sim as unknown as Sim;
      const root = (sim.ski as { skier: import('three').Object3D }).skier;
      const cam = sim.camera as import('three').PerspectiveCamera;
      root.updateMatrixWorld(true);
      const e = root.matrixWorld.elements;
      // Board axes in the world, flattened: right (+x) and back (+z, nose at -z).
      const rx = e[0]!,
        rz = e[2]!;
      const bx = e[8]!,
        bz = e[10]!;
      const o = { x: e[12]!, y: e[13]!, z: e[14]! };
      const at = (x: number, z: number, y: number) => ({
        x: o.x + rx * x + bx * z,
        y: o.y + y,
        z: o.z + rz * x + bz * z,
      });
      const poses: Record<string, [ReturnType<typeof at>, number]> = {
        toe: [at(3.4, 0, 1.0), 0.85],
        heel: [at(-3.4, 0, 1.0), 0.85],
        nose: [at(0, -3.6, 1.0), 0.85],
        tail: [at(0, 3.6, 1.0), 0.85],
        above: [at(0.4, 0.01, 4.2), 0.5],
        'three-quarter': [at(2.5, -2.3, 1.7), 0.8],
        legs: [at(1.5, -0.7, 0.55), 0.4],
      };
      const [p, look] = poses[angle]!;
      cam.position.set(p.x, p.y, p.z);
      cam.up.set(0, 1, 0);
      cam.lookAt(o.x, o.y + look, o.z);
      cam.updateMatrixWorld(true);
    }, angle);
    await page.waitForTimeout(120);
    await page.screenshot({ path: `${OUT}/${name}-${angle}.png` });
  }
}

const hold = async (page: Page, keys: string[], ms: number) => {
  for (const k of keys) await page.keyboard.down(k);
  await page.waitForTimeout(ms);
};
const release = async (page: Page, keys: string[]) => {
  for (const k of keys) await page.keyboard.up(k);
};

test('standing still on the flat', async ({ page }) => {
  await enter(page, FLAT);
  await page.waitForTimeout(1200);
  await freeze(page);
  await shoot(page, 'stand-flat');
});

test('standing still, goofy', async ({ page }) => {
  await enter(page, FLAT, { goofy: true });
  await page.waitForTimeout(1200);
  await freeze(page);
  await shoot(page, 'stand-goofy');
});

test('pushing along the flat (W)', async ({ page }) => {
  await enter(page, FLAT);
  await hold(page, ['KeyW'], 1600);
  await freeze(page, 'Math.sin(ski.stance.skatePhase) > 0.9');
  await shoot(page, 'push-flat', ALL);
  await unfreeze(page);
  await freeze(page, 'Math.sin(ski.stance.skatePhase) < -0.9');
  await shoot(page, 'push-flat-recover', FEW);
  await release(page, ['KeyW']);
});

test('pushing, goofy', async ({ page }) => {
  await enter(page, FLAT, { goofy: true });
  await hold(page, ['KeyW'], 1600);
  await freeze(page, 'Math.sin(ski.stance.skatePhase) > 0.9');
  await shoot(page, 'push-goofy', FEW);
  await release(page, ['KeyW']);
});

test('traversing the 21° slope', async ({ page }) => {
  await enter(page, SLOPE);
  await launch(page, 27 + 90, 6);
  await page.waitForTimeout(900);
  await freeze(page);
  await shoot(page, 'traverse');
});

test('straight runs, slow and fast', async ({ page }) => {
  await enter(page, SLOPE);
  await launch(page, 27, 4);
  await page.waitForTimeout(300);
  await freeze(page);
  await shoot(page, 'straight-slow', FEW);
  await unfreeze(page);
  await launch(page, 27, 16);
  await page.waitForTimeout(300);
  await freeze(page);
  await shoot(page, 'straight-fast', FEW);
});

for (const [name, key, speed] of [
  ['carve-heel-slow', 'KeyA', 8],
  ['carve-heel-fast', 'KeyA', 16],
  ['carve-toe-slow', 'KeyD', 8],
  ['carve-toe-fast', 'KeyD', 16],
] as const) {
  test(`carve: ${name}`, async ({ page }) => {
    await enter(page, SLOPE);
    await launch(page, 27, speed);
    await hold(page, [key], 700);
    await freeze(page);
    await shoot(page, name, name.endsWith('fast') ? ALL : FEW);
    await release(page, [key]);
  });
}

test('carve toeside, goofy', async ({ page }) => {
  await enter(page, SLOPE, { goofy: true });
  await launch(page, 27, 12);
  await hold(page, ['KeyA'], 700); // a goofy rider faces left of travel: A turns to the toes
  await freeze(page);
  await shoot(page, 'carve-goofy-toe', FEW);
  await release(page, ['KeyA']);
});

for (const [name, key] of [
  ['skid-heel', 'KeyA'],
  ['skid-toe', 'KeyD'],
] as const) {
  test(`skidding stop: ${name}`, async ({ page }) => {
    await enter(page, SLOPE);
    await launch(page, 27, 11);
    await hold(page, ['KeyS', key], 500);
    await release(page, [key]);
    await page.waitForTimeout(250);
    await freeze(page);
    await shoot(page, name, FEW);
    await release(page, ['KeyS']);
  });
}

test('hockey stop at speed', async ({ page }) => {
  await enter(page, SLOPE);
  await launch(page, 27, 17);
  await hold(page, ['KeyS', 'KeyA'], 650);
  await release(page, ['KeyA']);
  await page.waitForTimeout(150);
  await freeze(page);
  await shoot(page, 'hockey-stop');
  await release(page, ['KeyS']);
});

test('tuck', async ({ page }) => {
  await enter(page, SLOPE);
  await launch(page, 27, 12);
  await page.keyboard.press('ControlLeft');
  await page.waitForTimeout(600);
  await freeze(page);
  await shoot(page, 'tuck', FEW);
});

test('ollie, air and landing', async ({ page }) => {
  await enter(page, FLAT);
  await launch(page, 90, 6);
  await page.waitForTimeout(400);
  await page.keyboard.press('Space');
  await freeze(page, 'ski.airborne && ski.velocity.y < 0.5');
  await shoot(page, 'air', FEW);
  await unfreeze(page);
  await freeze(page, '!ski.airborne', 4000);
  await shoot(page, 'landing', FEW);
});

test('riding switch', async ({ page }) => {
  await enter(page, SLOPE);
  await launch(page, 27 + 180, 9, 27);
  await page.waitForTimeout(400);
  await freeze(page);
  await shoot(page, 'switch', FEW);
});

test('seated on a chairlift', async ({ page }) => {
  test.setTimeout(120_000);
  await enter(page, CHAIR);
  await page.keyboard.press('KeyE');
  await page.waitForFunction(
    () => (window.__sim as unknown as { ride: { phase: string } }).ride.phase === 'riding',
    null,
    { timeout: 30_000 },
  );
  // Fast-forward (W) out of the station so the hanging board is clear of the platform.
  await hold(page, ['KeyW'], 2500);
  await release(page, ['KeyW']);
  await page.waitForTimeout(500);
  await freeze(page);
  await shoot(page, 'chairlift', ['toe', 'heel', 'nose', 'tail', 'three-quarter']);
});

test('flying the drone (pilot pose)', async ({ page }) => {
  await enter(page, FLAT);
  await page.waitForTimeout(600);
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(1500);
  await freeze(page);
  await shoot(page, 'drone-pilot', FEW);
});

test('first person, looking down', async ({ page }) => {
  await enter(page, FLAT, { view: 'first-person' });
  await page.evaluate(() =>
    document.dispatchEvent(new MouseEvent('mousemove', { movementY: 260 } as MouseEventInit)),
  );
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/first-person-stand.png` });
  await hold(page, ['KeyW'], 1200);
  await page.screenshot({ path: `${OUT}/first-person-push.png` });
  await release(page, ['KeyW']);
});

test('touch build: standing and pushing', async ({ page }) => {
  await enter(page, FLAT, { touch: true });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/touch-stand.png` });
  await freeze(page);
  await shoot(page, 'touch-stand', ['three-quarter']);
});
