import { expect, type Page, test } from '@playwright/test';

// Pointer lock can't be granted headless, so fake it like the other control specs. A fresh
// context has no saved mode, which starts in the drone — seed skiing so we're on the snow.
async function enterGame(page: Page, query: string) {
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'pointerLockElement', {
      get: () => document.querySelector('#scene'),
    });
    if (!localStorage.getItem('ski-sim.mode')) localStorage.setItem('ski-sim.mode', 'ski');
  });
  const resort = query.includes('resort=') ? '' : 'resort=les-3-vallees&';
  await page.goto(`/?${resort}${query}`);
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10, null, { timeout: 90_000 });
  await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
}

const mode = (page: Page) => page.locator('#hud [data-mode]').textContent();

/** Whether the model is riding a board right now (the live ski controller). */
const onBoard = (page: Page) =>
  page.evaluate(
    () =>
      (window.__sim as unknown as { ski?: { model: { isSnowboard: boolean } } }).ski?.model
        .isSnowboard ?? false,
  );

test('G: switch to the board — the setup tab, HUD and model follow, and it persists', async ({
  page,
}) => {
  await enterGame(page, 'at=45.28856,6.5752,1900&heading=90&pitch=-5');
  // Starts on skis.
  expect(await mode(page)).toBe('SKI');
  expect(await onBoard(page)).toBe(false);

  await page.keyboard.press('KeyG');
  const modal = page.locator('#opt-ski');
  await expect(modal).toBeVisible();
  await modal.locator('.discipline-switch .setup-option', { hasText: 'Snowboard' }).click();
  await expect(modal).toContainText('Snowboard setup');
  await page.keyboard.press('KeyG');
  await expect(modal).toBeHidden();

  expect(await mode(page)).toBe('SNOWBOARD');
  expect(await onBoard(page)).toBe(true);

  await page.reload();
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10, null, { timeout: 90_000 });
  expect(await page.evaluate(() => localStorage.getItem('ski-sim.discipline'))).toBe('snowboard');
});

test('Y flips ski ↔ snowboard in game and lights the quick toggle', async ({ page }) => {
  await enterGame(page, 'at=45.28856,6.5752,1900&heading=90&pitch=-5');
  const toggle = page.locator('#toggles [data-toggle="discipline"]');
  expect(await mode(page)).toBe('SKI');
  await expect(toggle).not.toHaveClass(/\bon\b/);

  await page.keyboard.press('KeyY');
  expect(await mode(page)).toBe('SNOWBOARD');
  await expect(toggle).toHaveClass(/\bon\b/);

  await page.keyboard.press('KeyY');
  expect(await mode(page)).toBe('SKI');
  await expect(toggle).not.toHaveClass(/\bon\b/);
});

test('chase view: the boarder stands sideways across the board (no poles)', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('ski-sim.mode', 'ski');
    localStorage.setItem('ski-sim.view', 'chase');
    localStorage.setItem('ski-sim.discipline', 'snowboard');
  });
  await enterGame(page, 'at=45.28856,6.5752,1900&heading=90&pitch=-5');
  expect(await mode(page)).toBe('SNOWBOARD');
  // Hold S + A to swing the board ~90° across for a side-on view of the stance.
  await page.keyboard.down('KeyS');
  await page.keyboard.down('KeyA');
  await page.waitForTimeout(450);
  await page.keyboard.up('KeyA');
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-results/views/snowboard-stance.png' });
  await page.keyboard.up('KeyS');
});

type BoardHandle = {
  pushing: boolean;
  speed: number;
  footstep: boolean;
  feet: import('three').Vector3;
  model: { footRig(side: 'left' | 'right'): { position: import('three').Vector3 } };
  skier: import('three').Object3D;
  update?: unknown;
};
const board = (page: Page) =>
  page.evaluate(() => {
    const ski = (window.__sim as unknown as { ski: BoardHandle }).ski;
    return {
      pushing: ski.pushing,
      speed: ski.speed,
      backFootX: ski.model.footRig('right').position.x,
    };
  });

async function enterBoard(page: Page, query: string) {
  await page.addInitScript(() => {
    localStorage.setItem('ski-sim.mode', 'ski');
    localStorage.setItem('ski-sim.view', 'chase');
    localStorage.setItem('ski-sim.discipline', 'snowboard');
    localStorage.setItem('ski-sim.board-setup', JSON.stringify({ stance: 'regular' }));
  });
  await enterGame(page, query);
}

/** Freeze the rider and look at it from `side` m to the board's right (toe edge), `ahead` m ahead. */
async function lookAtRider(page: Page, side: number, ahead: number, height = 1) {
  await page.evaluate(
    ([side, ahead, height]) => {
      const sim = window.__sim as unknown as {
        ski: BoardHandle;
        camera: import('three').PerspectiveCamera;
      };
      sim.ski.update = () => {};
      const root = sim.ski.skier;
      root.updateMatrixWorld(true);
      const e = root.matrixWorld.elements;
      const o = { x: e[12]!, y: e[13]!, z: e[14]! };
      sim.camera.position.set(
        o.x + e[0]! * side - e[8]! * ahead,
        o.y + height,
        o.z + e[2]! * side - e[10]! * ahead,
      );
      sim.camera.lookAt(o.x, o.y + 0.8, o.z);
    },
    [side, ahead, height] as const,
  );
  await page.waitForTimeout(200);
}

test('W on the flat: the back foot comes out and pushes, then steps back in', async ({ page }) => {
  await enterBoard(page, 'at=45.28856,6.5752,1900&heading=90&pitch=-5'); // the frozen lake
  expect(await board(page)).toMatchObject({ pushing: false });
  // Count footsteps (one per push) in-page: a frame-long flag is easy to miss from here.
  await page.evaluate(() => {
    const w = window as unknown as { steps: number };
    w.steps = 0;
    const tick = () => {
      if ((window.__sim as unknown as { ski: BoardHandle }).ski.footstep) w.steps++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(4000);
  const pushing = await board(page);
  expect(pushing.pushing).toBe(true);
  // A push gets you going, but no faster than a jog (skis skate to 6 m/s).
  expect(pushing.speed).toBeGreaterThan(1.5);
  expect(pushing.speed).toBeLessThan(4);
  // Regular: the back (right) boot is out beside the toe edge (+x).
  expect(pushing.backFootX).toBeGreaterThan(0.15);
  expect(await page.evaluate(() => (window as unknown as { steps: number }).steps)).toBeGreaterThan(
    1,
  );
  await lookAtRider(page, 2.6, 1.8, 1.2);
  await page.screenshot({ path: 'test-results/views/snowboard-push.png' });
  await page.evaluate(() => {
    delete (window.__sim as unknown as { ski: BoardHandle }).ski.update;
  });
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(1200);
  const riding = await board(page);
  expect(riding.pushing).toBe(false);
  expect(Math.abs(riding.backFootX)).toBeLessThan(0.05); // back in its binding
});

test('W on a slope steep enough to glide: no push, both feet stay strapped in', async ({
  page,
}) => {
  // The 21° slope above the village, facing down its fall line.
  await enterBoard(page, 'at=45.2830,6.5760,2600&heading=27&pitch=-10');
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1500);
  const b = await board(page);
  await page.keyboard.up('KeyW');
  expect(b.pushing).toBe(false);
  expect(Math.abs(b.backFootX)).toBeLessThan(0.05);
});

for (const [name, key] of [
  ['heelside', 'KeyA'],
  ['toeside', 'KeyD'],
] as const) {
  test(`${name} carve: chase view of the pose`, async ({ page }) => {
    await enterBoard(page, 'at=45.2830,6.5760,2600&heading=27&pitch=-10');
    await page.waitForTimeout(2500); // pick up speed down the fall line
    await page.keyboard.down(key);
    await page.waitForTimeout(700);
    await lookAtRider(page, 0, 3.6, 1);
    await page.screenshot({ path: `test-results/views/snowboard-carve-${name}.png` });
    await page.keyboard.up(key);
  });
}
