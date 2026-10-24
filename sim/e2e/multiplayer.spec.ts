import { type BrowserContext, expect, type Page, test } from '@playwright/test';

// Two players on the frozen lake (ground ~2415.5 m): the host skis east, and the guest
// stands ~23 m west of them, looking east at them.
const HOST_AT = 'at=45.28856,6.5752,2417.2&heading=90&pitch=-5';
const GUEST_AT = 'at=45.28856,6.5749,2417.2&heading=90&pitch=-3';
// Both pages share one browser context, so the loopback (BroadcastChannel) transport
// links them without any network.
const NET = 'resort=les-3-vallees&net=loopback';

interface Debug {
  role: 'host' | 'guest' | null;
  code: string | null;
  connected: boolean;
  players: { player: number; name: string; you: boolean }[];
  dots: { east: number; north: number }[];
  modes: string[];
}
type Sim = {
  multiplayer: { debug: Debug };
  ski: { feet: { x: number; y: number; z: number } };
  lifts: { time: number };
  clock: { seconds: number; rate: number };
};
const sim = <T>(page: Page, fn: (s: Sim) => T) =>
  page.evaluate(`(${fn.toString()})(window.__sim)`) as Promise<T>;

async function open(context: BrowserContext, query: string, errors: string[]) {
  const page = await context.newPage();
  await page.addInitScript(() => {
    // A fake pointer lock that releases like the real one (N opens the Multiplayer
    // screen, which needs the mouse back).
    const w = window as unknown as { unlocked?: boolean };
    Object.defineProperty(Document.prototype, 'pointerLockElement', {
      get: () => (w.unlocked ? null : document.querySelector('#scene')),
    });
    Document.prototype.exitPointerLock = function () {
      w.unlocked = true;
      document.dispatchEvent(new Event('pointerlockchange'));
    };
    Element.prototype.requestPointerLock = function () {
      w.unlocked = false;
      document.dispatchEvent(new Event('pointerlockchange'));
      return Promise.resolve();
    };
    localStorage.setItem('ski-sim.mode', 'ski');
  });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`/?${NET}&${query}`);
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10, null, { timeout: 90_000 });
  await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
  return page;
}

async function setName(page: Page, name: string) {
  const input = page.locator('#mp-panel [name="player-name"]');
  await input.fill(name);
  await input.press('Tab'); // change event
}

test('host and guest see each other skiing, on the host clock', async ({ context }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];

  // Host: open the Multiplayer screen (N), name yourself, host.
  const host = await open(context, HOST_AT, errors);
  await host.keyboard.press('KeyN');
  const modal = host.locator('#mp-panel');
  await expect(modal).toBeVisible();
  await setName(host, 'Alice');
  await modal.locator('.mp-host').click();
  await expect(modal.locator('.mp-code')).toHaveText(/^[A-Z2-9]{6}$/);
  const code = (await modal.locator('.mp-code').textContent())!;
  expect(await modal.locator('.mp-link').inputValue()).toContain(
    `?resort=les-3-vallees&join=${code}`,
  );
  await expect(modal.locator('.mp-player')).toHaveText(['Alice · host (you)']);

  // Guest: the invite link joins on load (N shows how it's going).
  const guest = await open(context, `${GUEST_AT}&join=${code}`, errors);
  await guest.keyboard.press('KeyN');
  const guestModal = guest.locator('#mp-panel');
  await expect(guestModal).toBeVisible();
  await expect(guestModal.locator('.mp-status')).toHaveText('Connected');
  await setName(guest, 'Bob');
  await expect(modal.locator('.mp-player')).toHaveText(['Alice · host (you)', /^Bob/]);
  await expect(guestModal.locator('.mp-player')).toHaveText([/^Alice · host/, 'Bob (you)']);
  // Back to the pause menu, then Resume (the mouse is captured again).
  for (const page of [guest, host]) {
    await page.locator('#menu-back').click();
    await page.locator('#resume').click();
  }

  // The guest sees the host's skier, with a name tag and a minimap dot.
  const seen = () => sim(guest, (s) => s.multiplayer.debug.dots[0] ?? null);
  await expect.poll(seen).not.toBeNull();
  const tag = guest.locator('.label-player');
  await expect(tag).toBeVisible();
  await expect(tag).toHaveText('Alice');
  const before = (await seen())!;
  const hostFeet = await sim(host, (s) => s.ski.feet);
  expect(Math.hypot(before.east - hostFeet.x, before.north + hostFeet.z)).toBeLessThan(1);

  // The host skates off east; the guest's copy follows ~100 ms behind.
  await host.keyboard.down('KeyW');
  await host.waitForTimeout(2500);
  await host.keyboard.up('KeyW');
  await guest.screenshot({ path: 'test-results/views/multiplayer-guest-view.png' });
  await host.waitForTimeout(1500);
  const after = (await seen())!;
  const moved = Math.hypot(after.east - before.east, after.north - before.north);
  expect(moved).toBeGreaterThan(3);
  const hostNow = await sim(host, (s) => s.ski.feet);
  expect(Math.hypot(after.east - hostNow.x, after.north + hostNow.z)).toBeLessThan(1.5);

  // The host sees the guest too.
  await expect.poll(() => sim(host, (s) => s.multiplayer.debug.dots.length)).toBe(1);
  await host.keyboard.press('KeyV'); // chase view: Alice with Bob behind
  await host.mouse.move(800, 450);
  await host.evaluate(() =>
    document.dispatchEvent(new MouseEvent('mousemove', { movementX: 1300 } as MouseEventInit)),
  );
  await host.waitForTimeout(800);
  await host.screenshot({ path: 'test-results/views/multiplayer-host-view.png' });

  // Other modes: the guest sees the host's snowmobile and paraglider; flying the drone
  // from the wing, the paraglider waits where it was (and the drone flies).
  await host.keyboard.press('KeyV');
  for (const [key, mode, shot] of [
    ['KeyB', 'sled', 'sled'],
    ['KeyP', 'glide', 'glide'],
    ['KeyF', 'glide', 'fly'],
  ] as const) {
    await host.keyboard.press(key);
    await expect.poll(() => sim(guest, (s) => s.multiplayer.debug.modes[0])).toBe(mode);
    await guest.waitForTimeout(300);
    await guest.screenshot({ path: `test-results/views/multiplayer-guest-${shot}.png` });
  }

  await expect
    .poll(() =>
      guest.evaluate(
        () =>
          (window.__sim as unknown as { scene: import('three').Scene }).scene.getObjectByName(
            'drone',
          )?.visible ?? false,
      ),
    )
    .toBe(true);

  // The guest studies the map (the frame loop skips the 3D work) for longer than the
  // peer timeout: they stay in the game, and the host keeps seeing them.
  await guest.keyboard.press('KeyM');
  await guest.waitForTimeout(6500);
  expect(await sim(host, (s) => s.multiplayer.debug.players.length)).toBe(2);
  await guest.keyboard.press('KeyM');
  expect(await sim(guest, (s) => s.multiplayer.debug.connected)).toBe(true);

  // Shared world: the guest follows the host's time of day and lift clock.
  await host.keyboard.press('KeyT');
  await host.locator('#opt-time .setup-preset', { hasText: 'Night' }).click();
  await host.keyboard.press('Escape');
  await expect
    .poll(() => sim(guest, (s) => Math.round(s.clock.seconds / 60)))
    .toBeGreaterThanOrEqual(22 * 60);
  // The guest's lift clock sits between two reads of the host's taken either side of it
  // (reads of two pages are a moment apart, more on a busy machine). The guest eases
  // onto the host's clock rather than jumping, so it can trail by a few tenths.
  const hostBefore = await sim(host, (s) => s.lifts.time);
  const guestLift = await sim(guest, (s) => s.lifts.time);
  const hostAfter = await sim(host, (s) => s.lifts.time);
  expect(guestLift).toBeGreaterThan(hostBefore - 0.75);
  expect(guestLift).toBeLessThan(hostAfter + 0.75);
  await guest.keyboard.press('KeyT');
  await expect(guest.locator('#opt-time .time-locked')).toContainText('host sets the time');
  await expect(guest.locator('#opt-time input[name="time"]')).toBeDisabled();
  await guest.keyboard.press('Escape');

  // The host leaves: the party carries on, the guest hosting it now.
  await host.keyboard.press('KeyN');
  await modal.locator('.mp-leave').click();
  await expect
    .poll(() => sim(guest, (s) => s.multiplayer.debug.role), { timeout: 20_000 })
    .toBe('host');
  await expect(tag).toBeHidden();
  expect(await sim(guest, (s) => s.multiplayer.debug.dots.length)).toBe(0);
  // Back on their own clock: the time menu works again.
  await guest.keyboard.press('Escape');
  await guest.keyboard.press('KeyT');
  await expect(guest.locator('#opt-time input[name="time"]')).toBeEnabled();

  expect(errors).toEqual([]);
});

test('a player flying the drone: others see it, tilting as it flies, and their skier holding the controller', async ({
  context,
}) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  const host = await open(context, HOST_AT, errors);
  await host.keyboard.press('KeyN');
  const modal = host.locator('#mp-panel');
  await setName(host, 'Alice');
  await modal.locator('.mp-host').click();
  await expect(modal.locator('.mp-code')).toHaveText(/^[A-Z2-9]{6}$/);
  const code = (await modal.locator('.mp-code').textContent())!;
  const guest = await open(context, `${GUEST_AT}&join=${code}`, errors);
  await guest.keyboard.press('KeyN');
  await setName(guest, 'Bob');
  await expect(guest.locator('#mp-panel .mp-status')).toHaveText('Connected');
  for (const page of [guest, host]) {
    await page.locator('#menu-back').click();
    await page.locator('#resume').click();
  }
  await expect.poll(() => sim(guest, (s) => s.multiplayer.debug.dots.length)).toBe(1);

  // Alice flies her drone: it hovers ~6 m in front of Bob, a little left, facing him.
  await host.keyboard.press('KeyF');
  const bob = await sim(guest, (s) => s.ski.feet);
  const place = (east: number, north: number, up: number, heading: number) =>
    host.evaluate(
      ({ feet, east, north, up, heading }) => {
        const s = window.__sim as unknown as {
          fly: { place: (p: object) => void; speed: number };
        };
        s.fly.speed = 8;
        s.fly.place({
          east: feet.x + east,
          north: -feet.z + north,
          altitude: feet.y + up,
          heading,
          pitch: 0,
        });
      },
      { feet: bob, east, north, up, heading },
    );
  await place(6, 1.5, 1.2, 255);
  type Scene = import('three').Scene;
  const drone = () =>
    guest.evaluate(() => {
      const scene = (window.__sim as unknown as { scene: Scene }).scene;
      const d = scene.getObjectByName('drone');
      return d?.visible ? { pitch: d.children[0]!.rotation.x } : null;
    });
  await expect.poll(drone).not.toBeNull();
  // Her skier stands holding the controller (the guest's copy of it).
  const holding = () =>
    guest.evaluate(() => {
      const scene = (window.__sim as unknown as { scene: Scene }).scene;
      const player = scene.children.find((o) => o.name.startsWith('player-'))!;
      let shown = false;
      player.traverse((o) => {
        if (o.name === 'drone-controller' && o.visible && o.parent?.parent?.parent?.visible)
          shown = true;
      });
      return shown;
    });
  await expect.poll(holding).toBe(true);
  // The party card says what she's doing, and Bob can hear it.
  await expect(guest.locator('#party')).toContainText('flying a drone');
  const heard = () =>
    guest.evaluate(() => {
      const s = window.__sim as unknown as {
        camera: import('three').Camera;
        multiplayer: { nearestDrone: (p: unknown) => { distance: number } | null };
      };
      return s.multiplayer.nearestDrone(s.camera.position)?.distance ?? Infinity;
    });
  await expect.poll(heard).toBeLessThan(10);
  await guest.waitForTimeout(500);
  await guest.screenshot({ path: 'test-results/views/multiplayer-guest-drone.png' });

  // Close up: the props spin, the lights glow.
  await place(2, 0.3, 1.5, 230);
  await guest.waitForTimeout(600);
  await guest.screenshot({ path: 'test-results/views/multiplayer-guest-drone-close.png' });

  // Flying north across Bob's view, nose down; level again when she stops.
  await place(5, -4, 3.4, 0);
  await guest.waitForTimeout(400);
  await host.keyboard.down('KeyW');
  await expect.poll(async () => (await drone())!.pitch).toBeLessThan(-0.12);
  await guest.screenshot({ path: 'test-results/views/multiplayer-guest-drone-flying.png' });
  await host.keyboard.up('KeyW');
  await expect.poll(async () => Math.abs((await drone())!.pitch)).toBeLessThan(0.03);

  // Back in her skier: the drone's gone and her hands are back on her poles.
  await host.keyboard.press('KeyF');
  await expect.poll(drone).toBeNull();
  await expect.poll(holding).toBe(false);
  expect(errors).toEqual([]);
});

test('a double-clicked Join joins once', async ({ context }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  const host = await open(context, HOST_AT, errors);
  await host.keyboard.press('KeyN');
  const modal = host.locator('#mp-panel');
  await setName(host, 'Alice');
  await modal.locator('.mp-host').click();
  await expect(modal.locator('.mp-code')).toHaveText(/^[A-Z2-9]{6}$/);
  const code = (await modal.locator('.mp-code').textContent())!;

  const guest = await open(context, GUEST_AT, errors);
  await guest.keyboard.press('KeyN');
  const guestModal = guest.locator('#mp-panel');
  await guestModal.locator('.mp-code-input').fill(code);
  // Both clicks land before the first connection is open.
  await guestModal.locator('.mp-join').evaluate((b: HTMLElement) => {
    b.click();
    b.click();
  });
  await expect(guestModal.locator('.mp-status')).toHaveText('Connected');
  await expect(modal.locator('.mp-player')).toHaveCount(2);
  // Past the peer timeout, still in the game exactly once.
  await guest.waitForTimeout(6500);
  expect(await sim(host, (s) => s.multiplayer.debug.players.length)).toBe(2);
  expect(await sim(guest, (s) => s.multiplayer.debug.connected)).toBe(true);
  expect(errors).toEqual([]);
});

test('an invite link asks for your name before joining, and Host needs one too', async ({
  context,
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  const page = await open(context, `${GUEST_AT}&join=ABCDEF`, errors);
  const modal = page.locator('#mp-panel');
  // No name yet: the Multiplayer screen is up with the code in, asking for one.
  await expect(modal).toBeVisible();
  await expect(modal.locator('.mp-code-input')).toHaveValue('ABCDEF');
  await expect(modal.locator('.mp-status')).toHaveText('Enter your name to play together');
  await expect(modal.locator('[name="player-name"]')).toHaveClass(/invalid/);
  // The default name doesn't count, and Host is refused too.
  await setName(page, 'Skier');
  await modal.locator('.mp-host').click();
  await expect(modal.locator('.mp-status')).toHaveText('Choose a name of your own');
  expect(await sim(page, (s) => s.multiplayer.debug.role)).toBeNull();
  // With a name, Join goes ahead.
  await setName(page, 'Cara');
  await modal.locator('.mp-join').click();
  await expect(modal.locator('.mp-status')).toHaveText(/Looking for game ABCDEF/);
  expect(errors).toEqual([]);
});

test('the party carries on: the host leaves and a guest takes over, under the same code', async ({
  context,
}) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  const host = await open(context, HOST_AT, errors);
  await host.keyboard.press('KeyN');
  const modal = host.locator('#mp-panel');
  await setName(host, 'Alice');
  await modal.locator('.mp-host').click();
  await expect(modal.locator('.mp-code')).toHaveText(/^[A-Z2-9]{6}$/);
  const code = (await modal.locator('.mp-code').textContent())!;

  const guest = await open(context, `${GUEST_AT}&join=${code}`, errors);
  await guest.keyboard.press('KeyN');
  await setName(guest, 'Bob');
  await expect(guest.locator('#mp-panel .mp-status')).toHaveText('Connected');
  // The party card lists Alice, and her joining was announced to... the guest sees her.
  await expect(guest.locator('#party .party-name')).toHaveText(['Alice · host']);
  await expect(host.locator('#notices')).toContainText(/joined/);

  // Alice leaves: Bob carries the party on as its host, same code.
  await modal.locator('.mp-leave').click();
  await expect
    .poll(() => sim(guest, (s) => s.multiplayer.debug.role), { timeout: 20_000 })
    .toBe('host');
  expect(await sim(guest, (s) => s.multiplayer.debug.code)).toBe(code);
  await expect(guest.locator('#notices')).toContainText('hosting the party now');

  // Alice comes back with the same code and is Bob's guest now.
  await host.locator('#mp-panel .mp-code-input').fill(code);
  await host.locator('#mp-panel .mp-join').click();
  await expect
    .poll(() => sim(host, (s) => s.multiplayer.debug.connected), { timeout: 30_000 })
    .toBe(true);
  await expect(guest.locator('#party .party-name')).toHaveText(['Alice']);
  expect(errors).toEqual([]);
});

test('a host moving resort takes the party along', async ({ context }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  const host = await open(context, HOST_AT, errors);
  await host.keyboard.press('KeyN');
  const modal = host.locator('#mp-panel');
  await setName(host, 'Alice');
  await modal.locator('.mp-host').click();
  await expect(modal.locator('.mp-code')).toHaveText(/^[A-Z2-9]{6}$/);
  const code = (await modal.locator('.mp-code').textContent())!;
  const guest = await open(context, `${GUEST_AT}&join=${code}`, errors);
  await guest.keyboard.press('KeyN');
  await setName(guest, 'Bob');
  await expect(guest.locator('#mp-panel .mp-status')).toHaveText('Connected');

  // Alice takes the party to another resort (what picking one in the menu does).
  await host.evaluate(() => {
    const mp = (
      window.__sim as unknown as {
        multiplayer: { moveParty: (r: string, s: string | null) => void };
      }
    ).multiplayer;
    mp.moveParty('arlberg', null);
  });
  // Bob's told, with a countdown, and follows on his own.
  await expect(guest.locator('#notices')).toContainText('taking the party to arlberg');
  await guest.waitForURL(/resort=arlberg.*join=/, { timeout: 30_000 });
  expect(errors.filter((e) => !/WebSocket|relay/i.test(e))).toEqual([]);
});
