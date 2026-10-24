import { type BrowserContext, expect, type Page, test } from '@playwright/test';

// Game rules (Options → Rules): switched off, an action is refused with a notice, and in
// a party the host's rules hold for everyone.

// The frozen lake (flat ground); the guest stands ~23 m west of the host.
const HOST_AT = 'at=45.28856,6.5752,2417.2&heading=90&pitch=-5';
const GUEST_AT = 'at=45.28856,6.5749,2417.2&heading=90&pitch=-3';

type Sim = {
  multiplayer: { debug: { role: string | null; connected: boolean; modes: string[] } };
  ski: { feet: { x: number; y: number; z: number } };
};
const sim = <T>(page: Page, fn: (s: Sim) => T) =>
  page.evaluate(`(${fn.toString()})(window.__sim)`) as Promise<T>;

async function open(context: BrowserContext, query: string, errors: string[]) {
  const page = await context.newPage();
  await page.addInitScript(() => {
    // A fake pointer lock that releases like the real one (menus need the mouse back).
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
  await page.goto(`/?resort=les-3-vallees&net=loopback&${query}`);
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10, null, { timeout: 90_000 });
  await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
  return page;
}

/** Options → Rules. */
async function openRules(page: Page) {
  await page.keyboard.press('KeyO');
  await page.locator('#options [data-tab="opt-rules"]').click();
  await expect(page.locator('#opt-rules')).toBeVisible();
}

/** Back in the world from the Options hub (the mouse captured again). */
async function closeOptions(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.locator('#options')).toBeHidden();
  await page.evaluate(() => document.querySelector<HTMLElement>('#scene')!.requestPointerLock());
}

const feet = (page: Page) => sim(page, (s) => ({ x: s.ski.feet.x, z: s.ski.feet.z }));

test('realistic rules: no teleporting from the map, J or a start point', async ({ context }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  const page = await open(context, HOST_AT, errors);

  await openRules(page);
  const rules = page.locator('#opt-rules');
  await rules.locator('[data-preset="realistic"]').click();
  for (const sw of await rules.locator('.switch').all()) {
    await expect(sw).toHaveAttribute('aria-checked', 'false');
  }
  await expect(rules.locator('[data-preset="realistic"]')).toHaveClass(/selected/);
  await page.screenshot({ path: 'test-results/views/rules-tab.png' });
  await closeOptions(page);
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem('ski-sim.rules')))!)).toEqual({
    teleport: false,
    snowmobile: false,
    paraglider: false,
    liftSkip: false,
  });

  // The map: left click still drops a marker; right click says no, and you stay put.
  const start = await feet(page);
  await page.keyboard.press('KeyM');
  await expect(page.locator('.map-hint.desktop-only .teleport-hint')).toBeHidden();
  const canvas = page.locator('#world-map canvas');
  const box = (await canvas.boundingBox())!;
  const at = { x: box.x + box.width / 2 - 200, y: box.y + box.height / 2 };
  await page.mouse.click(at.x, at.y);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await expect(page.locator('#world-map')).toBeVisible();
  await expect(page.locator('#world-map .map-cursor')).toContainText('Teleporting is off');
  await page.screenshot({ path: 'test-results/views/rules-map-refused.png' });
  await page.keyboard.press('KeyM');
  await expect(page.locator('#world-map')).toBeHidden();

  // A marker is set, but its corner panel offers no J, and J only says why.
  await expect(page.locator('#marker-hint')).toBeVisible();
  await expect(page.locator('#marker-hint .marker-key')).toBeHidden();
  await page.keyboard.press('KeyJ');
  await expect(page.locator('#notices')).toContainText('Teleporting is off · Options → Rules');
  // B and P are refused the same way.
  await page.keyboard.press('KeyB');
  await expect(page.locator('#notices')).toContainText('The snowmobile is off');
  await page.keyboard.press('KeyP');
  await expect(page.locator('#notices')).toContainText('The paraglider is off');
  await page.waitForTimeout(1500); // a map teleport would have landed by now
  const now = await feet(page);
  expect(Math.hypot(now.x - start.x, now.z - start.z)).toBeLessThan(5);
  expect(await page.evaluate(() => localStorage.getItem('ski-sim.mode'))).toBe('ski');
  await page.screenshot({ path: 'test-results/views/rules-refused.png' });

  // Start points in the loaded area are teleports too: Change start point is off.
  await page.evaluate(() => document.exitPointerLock());
  await expect(page.locator('#pause-start')).toBeDisabled();

  // Everything on again: J works.
  await openRules(page);
  await rules.locator('[data-preset="everything"]').click();
  await closeOptions(page);
  await expect(page.locator('#marker-hint .marker-key')).toBeVisible();
  await page.keyboard.press('KeyJ');
  await expect
    .poll(async () => {
      const p = await feet(page);
      return Math.hypot(p.x - start.x, p.z - start.z);
    })
    .toBeGreaterThan(1000);

  expect(errors).toEqual([]);
});

test("in a party the host's rules hold for every guest, and survive a hand-over", async ({
  context,
}) => {
  test.setTimeout(240_000);
  const errors: string[] = [];

  const host = await open(context, HOST_AT, errors);
  await host.keyboard.press('KeyN');
  const modal = host.locator('#mp-panel');
  await host.locator('#mp-panel [name="player-name"]').fill('Alice');
  await host.locator('#mp-panel [name="player-name"]').press('Tab');
  await modal.locator('.mp-host').click();
  await expect(modal.locator('.mp-code')).toHaveText(/^[A-Z2-9]{6}$/);
  const code = (await modal.locator('.mp-code').textContent())!;

  // The guest loads with everything on (the pages share localStorage, so the host only
  // changes its rules once the guest has read its own).
  const guest = await open(context, `${GUEST_AT}&join=${code}`, errors);
  await expect.poll(() => sim(guest, (s) => s.multiplayer.debug.connected)).toBe(true);
  for (const page of [guest, host]) {
    if (await page.locator('#mp-panel').isVisible()) {
      await page.locator('#menu-back').click();
      await page.locator('#resume').click();
    }
  }

  // The host switches the snowmobile off.
  await openRules(host);
  await host.locator('#opt-rules [data-rule="snowmobile"]').click();
  await expect(host.locator('#opt-rules [data-rule="snowmobile"]')).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await closeOptions(host);

  // The guest is told, B does nothing, and the host still sees them on skis.
  await expect(guest.locator('#notices')).toContainText('The host changed the rules');
  await guest.keyboard.press('KeyB');
  await expect(guest.locator('#notices')).toContainText('The snowmobile is off in this game');
  await guest.waitForTimeout(800);
  expect(await sim(host, (s) => s.multiplayer.debug.modes[0])).toBe('ski');
  // Their Rules tab shows the host's rules, locked.
  await openRules(guest);
  const guestRules = guest.locator('#opt-rules');
  await expect(guestRules.locator('.time-locked')).toContainText('host sets the rules');
  await expect(guestRules.locator('[data-rule="snowmobile"]')).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await expect(guestRules.locator('[data-rule="snowmobile"]')).toBeDisabled();
  await expect(guestRules.locator('[data-preset="everything"]')).toBeDisabled();
  await guest.screenshot({ path: 'test-results/views/rules-guest-locked.png' });
  await closeOptions(guest);

  // The host leaves: the guest takes the party over and keeps its rules (now theirs to
  // change).
  await host.keyboard.press('KeyN');
  await modal.locator('.mp-leave').click();
  await expect
    .poll(() => sim(guest, (s) => s.multiplayer.debug.role), { timeout: 20_000 })
    .toBe('host');
  await guest.keyboard.press('KeyB');
  await guest.waitForTimeout(500);
  expect(await guest.evaluate(() => localStorage.getItem('ski-sim.mode'))).not.toBe('sled');
  await openRules(guest);
  await expect(guestRules.locator('.time-locked')).toBeHidden();
  await expect(guestRules.locator('[data-rule="snowmobile"]')).toBeEnabled();
  await expect(guestRules.locator('[data-rule="snowmobile"]')).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await closeOptions(guest);

  // Leaving the party: their own rules (everything on) again, and B gets on a sled.
  await guest.keyboard.press('KeyN');
  await guest.locator('#mp-panel .mp-leave').click();
  await guest.locator('#menu-back').click();
  await guest.locator('#resume').click();
  await guest.keyboard.press('KeyB');
  await expect.poll(() => guest.evaluate(() => localStorage.getItem('ski-sim.mode'))).toBe('sled');

  expect(errors).toEqual([]);
});
