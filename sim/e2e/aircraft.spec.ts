import { expect, type Page, test } from '@playwright/test';

// Courchevel altiport (LFLJ): from the runway's level top, looking down it (heading 44°).
const COURCHEVEL_TOP = 'at=45.39560,6.63235,2011&heading=44&pitch=-8';

interface Spot {
  type: string;
  east: number;
  north: number;
  ground: number;
  heading: number;
  name: string;
}

interface AircraftHandle {
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  heading: number;
  airspeed: number;
  onGround: boolean;
  crashing: boolean;
  crashed: string | null;
  status: string;
  lever: number;
  flapSetting: number;
}

type Sim = {
  fleet: { spots: Spot[] };
  ski: { place(pose: object): void };
  groundHeight(x: number, z: number): number;
  plane: AircraftHandle;
  heli: AircraftHandle;
};

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

/** Stand on skis `back` m behind and `side` m left of a parked aircraft, facing it. */
async function standBy(page: Page, type: string, near: string, side: number, back: number) {
  return page.evaluate(
    ({ type, near, side, back }) => {
      const sim = window.__sim as unknown as Sim;
      const spot = sim.fleet.spots.find((s) => s.type === type && s.name.includes(near))!;
      const h = (spot.heading * Math.PI) / 180;
      // Forward (east, north) and left of the aircraft's heading.
      const f = [Math.sin(h), Math.cos(h)];
      const l = [-Math.cos(h), Math.sin(h)];
      const east = spot.east - f[0]! * back + l[0]! * side;
      const north = spot.north - f[1]! * back + l[1]! * side;
      const ground = sim.groundHeight(east, -north);
      const heading = (Math.atan2(spot.east - east, spot.north - north) * 180) / Math.PI;
      sim.ski.place({ east, north, altitude: ground + 1.7, heading, pitch: 2 });
      return spot;
    },
    { type, near, side, back },
  );
}

/** Fly the drone (out of body) to look at a point from `distance` m on a bearing, `up` m above it. */
async function droneLook(
  page: Page,
  east: number,
  north: number,
  ground: number,
  bearing: number,
  distance: number,
  up: number,
) {
  await page.keyboard.press('KeyF');
  await page.evaluate(
    ({ east, north, ground, bearing, distance, up }) => {
      const sim = window.__sim as unknown as { fly: { place(p: object): void } };
      const b = (bearing * Math.PI) / 180;
      const e = east - Math.sin(b) * distance;
      const n = north - Math.cos(b) * distance;
      const pitch = (-Math.atan2(up - 1.2, distance) * 180) / Math.PI;
      sim.fly.place({ east: e, north: n, altitude: ground + up, heading: bearing, pitch });
    },
    { east, north, ground, bearing, distance, up },
  );
}

const handle = (page: Page, which: 'plane' | 'heli') =>
  page.evaluate((w) => {
    const a = (window.__sim as unknown as Sim)[w];
    return {
      x: a.position.x,
      y: a.position.y,
      z: a.position.z,
      vy: a.velocity.y,
      speed: Math.hypot(a.velocity.x, a.velocity.y, a.velocity.z),
      heading: a.heading,
      airspeed: a.airspeed,
      onGround: a.onGround,
      crashed: a.crashed,
      status: a.status,
    };
  }, which);

test('a Porter waits at the top of Courchevel altiport: walk up and climb in', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await start(page, COURCHEVEL_TOP);
  await page.keyboard.press('KeyF'); // down onto your skis
  await page.keyboard.press('KeyV'); // third person: the skier beside it, for scale
  // Beside the cabin door, seen side on from the drone: the skier for scale.
  const spot = await standBy(page, 'pc6', 'Courchevel', 2.6, 0.6);
  await page.waitForTimeout(800);
  await droneLook(page, spot.east, spot.north, spot.ground, spot.heading + 90, 19, 3);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/views/aircraft-plane-scale.png' });
  await page.keyboard.press('KeyF'); // back into the skier
  await standBy(page, 'pc6', 'Courchevel', 9, 1);
  await page.waitForTimeout(800);
  await expect(page.locator('#prompt')).toContainText('Pilatus PC-6 Porter');
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(400);
  expect(await mode(page)).toBe('PLANE');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'test-results/views/aircraft-plane-chase.png' });
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'test-results/views/aircraft-plane-cockpit.png' });
  expect(errors).toEqual([]);
});

test('an H125 waits on the Courchevel heliport', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await start(page, COURCHEVEL_TOP);
  await page.keyboard.press('KeyF');
  await page.keyboard.press('KeyV');
  const spot = await standBy(page, 'h125', 'Courchevel', 2.4, 1.2);
  await page.waitForTimeout(800);
  await droneLook(page, spot.east, spot.north, spot.ground, spot.heading + 90, 17, 2.5);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/views/aircraft-heli-scale.png' });
  await page.keyboard.press('KeyF');
  await standBy(page, 'h125', 'Courchevel', 7, 0);
  await page.waitForTimeout(800);
  await page.keyboard.press('KeyY');
  await page.waitForTimeout(400);
  expect(await mode(page)).toBe('HELICOPTER');
  await page.waitForTimeout(4500);
  await page.screenshot({ path: 'test-results/views/aircraft-heli-chase.png' });
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'test-results/views/aircraft-heli-cockpit.png' });
  await page.keyboard.press('KeyV');
  expect((await handle(page, 'heli')).onGround).toBe(true);
  expect(errors).toEqual([]);
});

// Courchevel altiport's runway 22/04 (features.json): the low 22 threshold, the high 04
// one, and their heights. You land uphill on 22 (224°) and take off downhill on 04.
const T22 = { e: 3899.52, n: 7973.08, h: 1941.84 };
const T04 = { e: 3526.6, n: 7586.69, h: 2007.79 };
const RUNWAY = Math.hypot(T04.e - T22.e, T04.n - T22.n);

test('the Porter takes off downhill from Courchevel and climbs away', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await start(page, COURCHEVEL_TOP);
  await page.keyboard.press('KeyF');
  await page.keyboard.press('KeyV'); // chase view
  await standBy(page, 'pc6', 'Courchevel', 6, 0);
  await page.keyboard.press('KeyU');
  expect(await mode(page)).toBe('PLANE');
  const at = await handle(page, 'plane');
  await page.keyboard.down('KeyW');
  // Rotate at ~90 km/h: pull back (the stick, here the arrow key).
  await expect
    .poll(async () => (await handle(page, 'plane')).airspeed, { timeout: 20_000 })
    .toBeGreaterThan(24);
  await page.keyboard.down('ArrowDown');
  await expect
    .poll(async () => (await handle(page, 'plane')).onGround, { timeout: 15_000 })
    .toBe(false);
  const off = await handle(page, 'plane');
  const roll = Math.hypot(off.x - at.x, off.z - at.z);
  // Downhill at 2,000 m with full tanks and a pilot: well within the 537 m runway.
  expect(roll).toBeLessThan(RUNWAY - 60);
  await page.screenshot({ path: 'test-results/views/aircraft-plane-takeoff.png' });
  await page.waitForTimeout(3000);
  await page.keyboard.up('ArrowDown');
  await page.waitForTimeout(6000);
  const away = await handle(page, 'plane');
  expect(away.crashed).toBeNull();
  expect(away.onGround).toBe(false);
  expect(away.y).toBeGreaterThan(off.y + 20);
  expect(await page.locator('#flight').isVisible()).toBe(true);
  await page.keyboard.up('KeyW');
  await page.screenshot({ path: 'test-results/views/aircraft-plane-climb.png' });
  expect(errors).toEqual([]);
});

test('the Porter lands uphill on Courchevel 22 and stops on the runway', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await start(page, COURCHEVEL_TOP);
  await page.keyboard.press('KeyF');
  await page.keyboard.press('KeyV');
  await standBy(page, 'pc6', 'Courchevel', 6, 0);
  await page.keyboard.press('KeyU');
  // On a 4.5° approach 700 m out, flaps down, then an autopilot flies the stick and the
  // power lever like a pilot would: down the glide path, a flare onto the slope, reverse.
  await page.evaluate(
    ({ T22, T04 }) => {
      type V = { x: number; y: number; z: number };
      const sim = window.__sim as unknown as {
        plane: {
          position: V;
          velocity: V;
          heading: number;
          airspeed: number;
          onGround: boolean;
          crashing: boolean;
          lever: number;
          flapSetting: number;
          impact: number;
          root: { quaternion: { x: number; y: number; z: number; w: number } };
          mount(at: V, v: V, yaw: number, running: boolean): void;
          setStick(s: { x: number; y: number } | null): void;
        };
        groundHeight(x: number, z: number): number;
      };
      const c = sim.plane;
      const Vec = c.position.constructor as new (x: number, y: number, z: number) => V;
      const len = Math.hypot(T04.e - T22.e, T04.n - T22.n);
      const ux = (T04.e - T22.e) / len;
      const un = (T04.n - T22.n) / len;
      const slope = (T04.h - T22.h) / len;
      const glide = Math.tan((4.5 * Math.PI) / 180);
      const course = (Math.atan2(ux, un) * 180) / Math.PI;
      const out = 700;
      const aim = 70; // touchdown aim, past the threshold
      const aimHeight = T22.h + slope * aim;
      const start = { e: T22.e - ux * out, n: T22.n - un * out };
      c.mount(
        new Vec(start.e, aimHeight + glide * (out + aim), -start.n),
        new Vec(ux * 31, -31 * glide, -un * 31),
        Math.atan2(-ux, un),
        true,
      );
      c.flapSetting = 2;
      const log: {
        along: number;
        cross: number;
        agl: number;
        vs: number;
        air: number;
        ground: boolean;
      }[] = [];
      const w = window as unknown as {
        __landing: typeof log;
        __touch?: { along: number; cross: number; sink: number };
      };
      w.__landing = log;
      let integral = 0;
      let last = performance.now();
      let braking = false;
      const step = () => {
        const now = performance.now();
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        const p = c.position;
        const v = c.velocity;
        const e = p.x;
        const n = -p.z;
        const along = (e - T22.e) * ux + (n - T22.n) * un;
        const cross = (e - T22.e) * un - (n - T22.n) * ux;
        const ground = sim.groundHeight(p.x, p.z);
        const agl = p.y - ground;
        const gs = Math.hypot(v.x, v.z);
        const q = c.root.quaternion;
        const bank =
          (Math.atan2(-2 * (q.x * q.y + q.w * q.z), 1 - 2 * (q.x * q.x + q.z * q.z)) * 180) /
          Math.PI;
        let hErr = c.heading - (course - Math.max(-15, Math.min(15, cross * 0.8)));
        hErr = ((hErr + 540) % 360) - 180;
        const rollStick = Math.max(-1, Math.min(1, 0.06 * (-hErr * 1.2 - bank)));
        if (!c.onGround) {
          const flare = agl < 12 && along > -15;
          const target = aimHeight + glide * (aim - along);
          const want = flare
            ? slope * gs - 0.6
            : -gs * glide + Math.max(-2, Math.min(2, 0.25 * (target - p.y)));
          integral = Math.max(-0.5, Math.min(0.5, integral + 0.05 * (want - v.y) * dt));
          c.setStick({
            x: rollStick,
            // The stick curves the flight path: a gentle gain (it was an angle of attack).
            y: Math.max(-1, Math.min(1, 0.25 * (want - v.y) + integral)),
          });
          c.lever = flare ? 0 : Math.max(0, Math.min(1, 0.3 + 0.12 * (30 - c.airspeed)));
        } else {
          w.__touch ??= { along, cross, sink: c.impact };
          c.setStick({ x: Math.max(-1, Math.min(1, -0.05 * hErr)), y: 0.3 });
          c.lever = gs > 6 ? -1 : 0; // reverse, then idle
          if (!braking) {
            braking = true;
            document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
          }
        }
        log.push({ along, cross, agl, vs: v.y, air: c.airspeed, ground: c.onGround });
        if (!c.crashing && !(c.onGround && gs < 0.3)) requestAnimationFrame(step);
        else c.setStick(null);
      };
      requestAnimationFrame(step);
    },
    { T22, T04 },
  );
  await page.waitForTimeout(9000);
  await page.screenshot({ path: 'test-results/views/aircraft-plane-approach.png' });
  await expect
    .poll(
      async () => {
        const h = await handle(page, 'plane');
        return h.crashed ?? (h.onGround && h.speed < 0.3 ? 'stopped' : 'flying');
      },
      { timeout: 90_000 },
    )
    .toBe('stopped');
  const touch = await page.evaluate(
    () =>
      (window as unknown as { __touch: { along: number; cross: number; sink: number } }).__touch,
  );
  const end = await page.evaluate(() => {
    const log = (window as unknown as { __landing: { along: number; cross: number }[] }).__landing;
    return log[log.length - 1]!;
  });
  // On the runway (40 m wide), past the threshold, stopped before its top.
  expect(touch.along).toBeGreaterThan(0);
  expect(Math.abs(touch.cross)).toBeLessThan(15);
  expect(touch.sink).toBeLessThan(3.5); // firm onto the slope, well inside the gear's 4.5 m/s
  expect(end.along).toBeLessThan(RUNWAY);
  expect(end.along - touch.along).toBeLessThan(250);
  await page.screenshot({ path: 'test-results/views/aircraft-plane-landed.png' });
  expect(errors).toEqual([]);
});

test('the H125 lifts off, hovers and lands on the next pad', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await start(page, COURCHEVEL_TOP);
  await page.keyboard.press('KeyF');
  await page.keyboard.press('KeyV');
  await standBy(page, 'h125', 'Courchevel', 7, 0);
  await page.keyboard.press('KeyY');
  expect(await mode(page)).toBe('HELICOPTER');
  await page.waitForTimeout(4000); // rotor up to speed
  const parked = await handle(page, 'heli');
  expect(parked.onGround).toBe(true);
  // W: up; let go and it holds the height.
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2500);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(2500);
  const hover = await handle(page, 'heli');
  expect(hover.onGround).toBe(false);
  expect(hover.y - parked.y).toBeGreaterThan(8);
  await page.waitForTimeout(2000);
  const still = await handle(page, 'heli');
  expect(Math.abs(still.vy)).toBeLessThan(0.5);
  expect(Math.abs(still.y - hover.y)).toBeLessThan(1.5);
  await page.screenshot({ path: 'test-results/views/aircraft-heli-hover.png' });
  // The next pad along the heliport's row (features.json), 26 m away: an autopilot on
  // the cyclic flies over it, then S lets it down onto the pad.
  const PAD = { e: 3742.15, n: 7637.7, top: 1992.69 };
  await page.evaluate((PAD) => {
    type V = { x: number; y: number; z: number };
    const c = (
      window.__sim as unknown as {
        heli: {
          position: V;
          velocity: V;
          yaw: number;
          onGround: boolean;
          crashing: boolean;
          setStick(s: { x: number; y: number } | null): void;
        };
      }
    ).heli;
    const step = () => {
      const p = c.position;
      const v = c.velocity;
      const de = PAD.e - p.x;
      const dn = PAD.n + p.z;
      const dist = Math.hypot(de, dn);
      // Wanted ground velocity toward the pad, slowing as it gets there.
      const speed = Math.min(6, 0.5 * dist);
      const we = dist > 0.01 ? (de / dist) * speed : 0;
      const wn = dist > 0.01 ? (dn / dist) * speed : 0;
      const ae = 0.3 * (we - v.x);
      const an = 0.3 * (wn + v.z);
      // Into the heli's frame: forward (-sin yaw, -cos yaw) in (east, -north)...
      const fe = -Math.sin(c.yaw);
      const fn = Math.cos(c.yaw);
      const forward = ae * fe + an * fn;
      const right = ae * fn - an * fe;
      c.setStick({ x: Math.max(-1, Math.min(1, right)), y: Math.max(-1, Math.min(1, -forward)) });
      const w = window as unknown as { __padDist: number };
      w.__padDist = dist;
      if (!c.onGround && !c.crashing) requestAnimationFrame(step);
      else c.setStick(null);
    };
    requestAnimationFrame(step);
  }, PAD);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __padDist: number }).__padDist), {
      timeout: 30_000,
    })
    .toBeLessThan(1.5);
  await page.waitForTimeout(1500);
  await page.keyboard.down('KeyS');
  await expect
    .poll(async () => (await handle(page, 'heli')).onGround, { timeout: 30_000 })
    .toBe(true);
  await page.keyboard.up('KeyS');
  const landed = await handle(page, 'heli');
  expect(landed.crashed).toBeNull();
  // On the 7 m pad.
  expect(Math.hypot(landed.x - PAD.e, -landed.z - PAD.n)).toBeLessThan(3);
  expect(Math.abs(landed.y - PAD.top)).toBeLessThan(0.5);
  await page.screenshot({ path: 'test-results/views/aircraft-heli-landed.png' });
  // Stopped on the ground: Y gets out onto your skis, and it stays there.
  await page.keyboard.press('KeyY');
  expect(await mode(page)).toBe('SKI');
  expect((await handle(page, 'heli')).status).toBe('parked');
  expect(errors).toEqual([]);
});

test('summoning: a heli comes to flat ground with teleporting on, none without it', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  // Aircraft allowed, teleporting off: only the airfields have them. (Set once: the
  // reload below keeps what the test changes.)
  await page.addInitScript(() => {
    if (sessionStorage.getItem('rules-set')) return;
    sessionStorage.setItem('rules-set', '1');
    localStorage.setItem(
      'ski-sim.rules',
      JSON.stringify({
        teleport: false,
        snowmobile: true,
        paraglider: true,
        liftSkip: true,
        aircraft: true,
      }),
    );
  });
  // The frozen lake above Val Thorens: flat, open, no airfield.
  await start(page, 'at=45.28856,6.5752,2418&heading=90&pitch=-5');
  await page.keyboard.press('KeyF');
  await page.keyboard.press('KeyY');
  await expect(page.locator('#notices')).toContainText('No Airbus H125 here');
  expect(await mode(page)).toBe('SKI');
  // Teleporting on: it comes to you, and you're in it.
  await page.evaluate(() => {
    localStorage.setItem(
      'ski-sim.rules',
      JSON.stringify({
        teleport: true,
        snowmobile: true,
        paraglider: true,
        liftSkip: true,
        aircraft: true,
      }),
    );
  });
  await page.reload();
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10, null, { timeout: 90_000 });
  await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
  await page.keyboard.press('KeyY');
  expect(await mode(page)).toBe('HELICOPTER');
  const h = await handle(page, 'heli');
  expect(h.onGround).toBe(true);
  expect(errors).toEqual([]);
});

test('flying into the mountain: a crash, then back upright on the ground nearby', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await start(page, 'at=45.28856,6.5752,2418&heading=90&pitch=-5');
  await page.keyboard.press('KeyF');
  await page.keyboard.press('KeyU'); // a Porter on the lake (or at the nearest runway)
  expect(await mode(page)).toBe('PLANE');
  // Put it 25 m over the lake diving at 15 m/s.
  await page.evaluate(() => {
    type V = { x: number; y: number; z: number };
    const sim = window.__sim as unknown as {
      plane: {
        position: V;
        mount(at: V, v: V, yaw: number, running: boolean): void;
        setStick(s: { x: number; y: number } | null): void;
      };
      groundHeight(x: number, z: number): number;
    };
    const p = sim.plane.position;
    const Vec = p.constructor as new (x: number, y: number, z: number) => V;
    sim.plane.mount(
      new Vec(p.x, sim.groundHeight(p.x, p.z) + 25, p.z),
      new Vec(40, -15, 0),
      -Math.PI / 2,
      true,
    );
    sim.plane.setStick({ x: 0, y: -1 }); // stick hard forward, into the snow
  });
  await expect(page.locator('#notices')).toContainText('Crashed ·', { timeout: 30_000 });
  await page.evaluate(() =>
    (window.__sim as unknown as { plane: { setStick(s: null): void } }).plane.setStick(null),
  );
  await page.screenshot({ path: 'test-results/views/aircraft-plane-crash.png' });
  // A couple of seconds later it's back on its wheels, at rest, still yours to fly.
  await expect
    .poll(
      async () => {
        const h = await handle(page, 'plane');
        return !h.crashed && h.onGround && h.speed < 0.5;
      },
      { timeout: 30_000 }, // the crash lasts 2.5 s of sim time: slow frames stretch it
    )
    .toBe(true);
  expect(await mode(page)).toBe('PLANE');
  expect(errors).toEqual([]);
});

// Cockpit views: forward, left, right and down from the pilot's seat, on the ground and
// in flight. Straight ahead is mostly sky and ground (the panel below), never fuselage.
const LOOKS = [
  { name: 'forward', yaw: 0, pitch: 0 },
  { name: 'left', yaw: 1.4, pitch: 0 },
  { name: 'right', yaw: -1.4, pitch: 0 },
  { name: 'down', yaw: 0, pitch: -0.7 },
] as const;

for (const kind of ['plane', 'heli'] as const) {
  test(`the ${kind === 'plane' ? 'Porter' : 'H125'} cockpit: gauges, controls and the view out, on the ground and flying`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await start(page, COURCHEVEL_TOP); // first person (playwright.config.ts)
    await page.keyboard.press('KeyF');
    await standBy(page, kind === 'plane' ? 'pc6' : 'h125', 'Courchevel', 6, 0);
    await page.keyboard.press(kind === 'plane' ? 'KeyU' : 'KeyY');
    await page.waitForTimeout(3000); // engine running
    const look = async (where: string) => {
      const blocked: Record<string, number> = {};
      for (const l of LOOKS) {
        await page.evaluate(
          ({ kind, l }) => {
            const c = (
              window.__sim as unknown as Record<string, { lookAround(v: object | null): void }>
            )[kind]!;
            c.lookAround({ yaw: l.yaw, pitch: l.pitch });
          },
          { kind, l },
        );
        await page.waitForTimeout(500);
        blocked[l.name] = await page.evaluate(
          (kind) =>
            (window.__sim as unknown as Record<string, { viewBlocked(): number }>)[
              kind
            ]!.viewBlocked(),
          kind,
        );
        await page.screenshot({
          path: `test-results/views/cockpit-${kind}-${where}-${l.name}.png`,
        });
      }
      console.log(kind, where, JSON.stringify(blocked));
      // Out of the windscreen: mostly the world, not the aircraft.
      expect(blocked.forward).toBeLessThan(0.45);
      // Out of the side windows, past the frames and doors.
      expect(blocked.left).toBeLessThan(0.7);
      expect(blocked.right).toBeLessThan(0.7);
      await page.evaluate(
        (kind) =>
          (window.__sim as unknown as Record<string, { lookAround(v: object | null): void }>)[
            kind
          ]!.lookAround(null),
        kind,
      );
    };
    // The cockpit-only parts are there and drawn.
    expect(
      await page.evaluate((kind) => {
        const c = (window.__sim as unknown as Record<string, { root: import('three').Object3D }>)[
          kind
        ]!;
        return c.root.getObjectByName('cockpit-gauges')?.parent?.visible ?? false;
      }, kind),
    ).toBe(true);
    await look('ground');
    // Into the air: the Porter cruising at 250 m, the H125 hovering at 60 m.
    await page.evaluate((kind) => {
      type V = { x: number; y: number; z: number };
      const sim = window.__sim as unknown as Record<string, unknown> & {
        groundHeight(x: number, z: number): number;
      };
      const c = sim[kind] as {
        position: V;
        yaw: number;
        mount(at: V, v: V, yaw: number, running: boolean): void;
      };
      const p = c.position;
      const Vec = p.constructor as new (x: number, y: number, z: number) => V;
      const up = kind === 'plane' ? 250 : 60;
      const speed = kind === 'plane' ? 50 : 0;
      const yaw = c.yaw;
      c.mount(
        new Vec(p.x, sim.groundHeight(p.x, p.z) + up, p.z),
        new Vec(-Math.sin(yaw) * speed, 0, -Math.cos(yaw) * speed),
        yaw,
        true,
      );
    }, kind);
    await page.waitForTimeout(1500);
    // The gauges read the flight: the airspeed needle's drawn from the live state.
    await look('flying');
    expect(errors).toEqual([]);
  });
}

test('bail out of the Porter at 3,500 m: freefall, open the canopy, land and ski off', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await start(page, COURCHEVEL_TOP);
  await page.keyboard.press('KeyF');
  await page.keyboard.press('KeyV'); // chase view
  await standBy(page, 'pc6', 'Courchevel', 6, 0);
  await page.keyboard.press('KeyU');
  // Take off downhill as in the take-off test.
  await page.keyboard.down('KeyW');
  await expect
    .poll(async () => (await handle(page, 'plane')).airspeed, { timeout: 20_000 })
    .toBeGreaterThan(24);
  await page.keyboard.down('ArrowDown');
  await expect
    .poll(async () => (await handle(page, 'plane')).onGround, { timeout: 15_000 })
    .toBe(false);
  await page.keyboard.up('ArrowDown');
  // A real climb to 3,500 m takes five minutes: put it there, cruising.
  await page.evaluate(() => {
    type V = { x: number; y: number; z: number };
    const c = (
      window.__sim as unknown as {
        plane: {
          position: V;
          yaw: number;
          mount(at: V, v: V, yaw: number, running: boolean): void;
        };
      }
    ).plane;
    const p = c.position;
    const Vec = p.constructor as new (x: number, y: number, z: number) => V;
    c.mount(
      new Vec(p.x, 3500, p.z),
      new Vec(-Math.sin(c.yaw) * 45, 0, -Math.cos(c.yaw) * 45),
      c.yaw,
      true,
    );
  });
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(800);
  // U in the air: out of the door.
  await page.keyboard.press('KeyU');
  await expect.poll(() => mode(page)).toBe('FREEFALL');
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'test-results/views/skydive-exit.png' });
  // The empty Porter flies on a few seconds and is gone.
  await expect
    .poll(async () => (await handle(page, 'plane')).status, { timeout: 10_000 })
    .toBe('away');
  const sky = () =>
    page.evaluate(() => {
      const d = (
        window.__sim as unknown as {
          skydiver: {
            agl: number;
            airspeed: number;
            canopyOut: boolean;
            open: number;
            velocity: { y: number };
          };
        }
      ).skydiver;
      return {
        agl: d.agl,
        speed: d.airspeed * 3.6,
        canopy: d.canopyOut,
        open: d.open,
        vy: d.velocity.y,
      };
    });
  await page.waitForTimeout(9000);
  const falling = await sky();
  // Belly to earth near terminal (faster than 195 km/h in the thin air up here).
  expect(falling.speed).toBeGreaterThan(170);
  expect(falling.speed).toBeLessThan(250);
  await expect(page.locator('#flight [data-flight="agl"]')).toBeVisible();
  await page.screenshot({ path: 'test-results/views/skydive-freefall.png' });
  // Pull (Space) around 700 m above the ground.
  await page.waitForFunction(
    () => (window.__sim as unknown as { skydiver: { agl: number } }).skydiver.agl < 700,
    null,
    { timeout: 60_000, polling: 'raf' },
  );
  await page.keyboard.press('Space');
  await expect.poll(() => mode(page)).toBe('CANOPY');
  await page.waitForTimeout(5000);
  const flying = await sky();
  expect(flying.open).toBe(1);
  expect(-flying.vy).toBeLessThan(7);
  await page.screenshot({ path: 'test-results/views/skydive-canopy.png' });
  // Flare (S) just above the snow, and on you ski.
  await page.waitForFunction(
    () => (window.__sim as unknown as { skydiver: { agl: number } }).skydiver.agl < 10,
    null,
    { timeout: 200_000, polling: 'raf' },
  );
  await page.keyboard.down('KeyS');
  await expect.poll(() => mode(page), { timeout: 20_000 }).toBe('SKI');
  await page.keyboard.up('KeyS');
  await expect(page.locator('#notices')).not.toContainText('Crashed');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/views/skydive-landed.png' });
  expect(errors).toEqual([]);
});

test('flying with the arrow keys alone: take off, climb and turn; the mouse only looks', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.addInitScript(() =>
    localStorage.setItem('ski-sim.camera', JSON.stringify({ flyWith: 'arrows' })),
  );
  await start(page, COURCHEVEL_TOP);
  // The setting, under Options → Controls.
  await page.keyboard.press('KeyO');
  await page.locator('[data-tab="opt-controls"]').click();
  await expect(page.locator('[data-fly-with="arrows"]')).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: 'test-results/views/controls-fly-with.png' });
  await page.keyboard.press('Escape');
  await expect(page.locator('#options')).toBeHidden();
  await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
  await page.keyboard.press('KeyF');
  await page.keyboard.press('KeyV');
  await standBy(page, 'pc6', 'Courchevel', 6, 0);
  await page.keyboard.press('KeyU');
  await page.keyboard.down('KeyW');
  await expect
    .poll(async () => (await handle(page, 'plane')).airspeed, { timeout: 20_000 })
    .toBeGreaterThan(24);
  // A big mouse pull doesn't touch the stick: still on the runway a second later.
  await page.evaluate(() =>
    document.dispatchEvent(new MouseEvent('mousemove', { movementY: 900 } as MouseEventInit)),
  );
  await page.waitForTimeout(300);
  expect((await handle(page, 'plane')).onGround).toBe(true);
  // ArrowDown (back on the stick) lifts it off; hold it into the climb.
  await page.keyboard.down('ArrowDown');
  await expect
    .poll(async () => (await handle(page, 'plane')).onGround, { timeout: 15_000 })
    .toBe(false);
  await page.waitForTimeout(2500);
  await page.keyboard.up('ArrowDown');
  const climbing = await handle(page, 'plane');
  // ArrowLeft: roll left into a turn (heading, clockwise from north, goes down); a little
  // back pressure through it.
  // A short hold: the keyboard stick ramps in, so this banks ~30°, not all the way over.
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(650);
  await page.keyboard.up('ArrowLeft');
  await page.waitForTimeout(2500);
  const turned = await handle(page, 'plane');
  await page.keyboard.up('KeyW');
  expect(turned.crashed).toBeNull();
  expect(turned.y).toBeGreaterThan(climbing.y);
  expect(((climbing.heading - turned.heading + 540) % 360) - 180).toBeGreaterThan(10);
  await page.screenshot({ path: 'test-results/views/aircraft-arrows-turn.png' });
});

test('U during the take-off roll: out onto your skis at its speed; it brakes and stays parked', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await start(page, COURCHEVEL_TOP);
  await page.keyboard.press('KeyF');
  await page.keyboard.press('KeyV');
  await standBy(page, 'pc6', 'Courchevel', 6, 0);
  await page.keyboard.press('KeyU');
  await page.keyboard.down('KeyW');
  await expect
    .poll(async () => (await handle(page, 'plane')).speed, { timeout: 30_000 })
    .toBeGreaterThan(12);
  await page.keyboard.up('KeyW');
  const rolling = await handle(page, 'plane');
  expect(rolling.onGround).toBe(true);
  await page.keyboard.press('KeyU');
  await expect.poll(() => mode(page)).toBe('SKI');
  // Skiing on at about the plane's speed.
  const skier = await page.evaluate(() => {
    const s = (window.__sim as unknown as { ski: { speed: number } }).ski;
    return s.speed;
  });
  expect(skier).toBeGreaterThan(0.6 * rolling.speed);
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/views/aircraft-roll-exit.png' });
  // The empty plane brakes to a stop on the runway, parked, no crash.
  await expect
    .poll(async () => (await handle(page, 'plane')).speed, { timeout: 30_000 })
    .toBeLessThan(0.1);
  const parked = await handle(page, 'plane');
  expect(parked.status).toBe('parked');
  expect(parked.crashed).toBeNull();
  expect(parked.onGround).toBe(true);
  expect(Math.hypot(parked.x - rolling.x, parked.z - rolling.z)).toBeGreaterThan(5);
  await expect(page.locator('#notices')).not.toContainText('Crashed');
  expect(errors).toEqual([]);
});
