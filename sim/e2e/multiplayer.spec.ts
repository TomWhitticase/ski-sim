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
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`/?${NET}&${query}`);
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10, null, { timeout: 90_000 });
  await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
  return page;
}

async function setName(page: Page, name: string) {
  const input = page.locator('#opt-online [name="player-name"]');
  await input.fill(name);
  await input.press('Tab'); // change event
}

test('host and guest see each other skiing, on the host clock', async ({ context }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  await context.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'pointerLockElement', {
      get: () => document.querySelector('#scene'),
    });
    localStorage.setItem('ski-sim.mode', 'ski');
  });

  // Host: open the Multiplayer dialog (N), name yourself, host.
  const host = await open(context, HOST_AT, errors);
  await host.keyboard.press('KeyN');
  const modal = host.locator('#opt-online');
  await expect(modal).toBeVisible();
  await setName(host, 'Alice');
  await modal.locator('.mp-host').click();
  await expect(modal.locator('.mp-code')).toHaveText(/^[A-Z2-9]{6}$/);
  const code = (await modal.locator('.mp-code').textContent())!;
  expect(await modal.locator('.mp-link').inputValue()).toContain(
    `?resort=les-3-vallees&join=${code}`,
  );
  await expect(modal.locator('.mp-player')).toHaveText(['Alice · host (you)']);

  // Guest: the invite link joins on load.
  const guest = await open(context, `${GUEST_AT}&join=${code}`, errors);
  const guestModal = guest.locator('#opt-online');
  await expect(guestModal).toBeVisible();
  await expect(guestModal.locator('.mp-status')).toHaveText('Connected');
  await setName(guest, 'Bob');
  await expect(modal.locator('.mp-player')).toHaveText(['Alice · host (you)', /^Bob/]);
  await expect(guestModal.locator('.mp-player')).toHaveText([/^Alice · host/, 'Bob (you)']);
  await guest.keyboard.press('Escape');
  await host.keyboard.press('Escape');

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

  // Other modes: the guest sees the host's snowmobile, paraglider and fly-mode figure.
  await host.keyboard.press('KeyV');
  for (const [key, mode] of [
    ['KeyB', 'sled'],
    ['KeyP', 'glide'],
    ['KeyF', 'fly'],
  ] as const) {
    await host.keyboard.press(key);
    await expect.poll(() => sim(guest, (s) => s.multiplayer.debug.modes[0])).toBe(mode);
    await guest.waitForTimeout(300);
    await guest.screenshot({ path: `test-results/views/multiplayer-guest-${mode}.png` });
  }

  // Shared world: the guest follows the host's time of day and lift clock.
  await host.locator('#open-time').evaluate((b: HTMLElement) => b.click());
  await host.locator('#opt-time .setup-preset', { hasText: 'Night' }).click();
  await host.keyboard.press('Escape');
  await expect
    .poll(() => sim(guest, (s) => Math.round(s.clock.seconds / 60)))
    .toBeGreaterThanOrEqual(22 * 60);
  const liftGap = await Promise.all([
    sim(host, (s) => s.lifts.time),
    sim(guest, (s) => s.lifts.time),
  ]);
  expect(Math.abs(liftGap[0] - liftGap[1])).toBeLessThan(0.5);
  await guest.locator('#open-time').evaluate((b: HTMLElement) => b.click());
  await expect(guest.locator('#opt-time .time-locked')).toContainText('host sets the time');
  await expect(guest.locator('#opt-time input[name="time"]')).toBeDisabled();
  await guest.keyboard.press('Escape');

  // The host leaves: the game ends for the guest, with a message.
  await host.locator('#open-multiplayer').evaluate((b: HTMLElement) => b.click());
  await modal.locator('.mp-leave').click();
  await expect(guestModal).toBeVisible();
  await expect(guestModal.locator('.mp-status')).toHaveText('The host ended the game');
  await expect(tag).toBeHidden();
  expect(await sim(guest, (s) => s.multiplayer.debug.dots.length)).toBe(0);
  // Back on their own clock: the time menu works again.
  await guest.keyboard.press('Escape');
  await guest.locator('#open-time').evaluate((b: HTMLElement) => b.click());
  await expect(guest.locator('#opt-time input[name="time"]')).toBeEnabled();

  expect(errors).toEqual([]);
});
