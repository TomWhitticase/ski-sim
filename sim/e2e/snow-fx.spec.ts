import { expect, type Page, test } from '@playwright/test';

const SLOPE = 'at=45.2830,6.5760,2600&heading=27&pitch=-10';

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

const count = (page: Page, name: string) =>
  page.evaluate((n) => {
    const scene = (window.__sim as unknown as { scene: import('three').Scene }).scene;
    return (scene.getObjectByName(n) as import('three').InstancedMesh).count;
  }, name);

test('skiing leaves tracks; a hockey stop throws far more snow than running straight', async ({
  page,
}) => {
  await start(page, SLOPE);
  await page.keyboard.press('KeyF');
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(4000);
  expect(await count(page, 'snow-trails')).toBeGreaterThan(40);
  const straight = await count(page, 'snow-spray');
  expect(straight).toBeLessThan(15);

  await page.keyboard.down('KeyS');
  await page.keyboard.down('KeyA');
  await page.waitForTimeout(500);
  await page.keyboard.up('KeyA');
  await page.waitForTimeout(150);
  const stopping = await count(page, 'snow-spray');
  await page.screenshot({ path: 'test-results/views/snow-hockey-stop.png' });
  await page.keyboard.up('KeyS');
  expect(stopping).toBeGreaterThan(60);
  expect(stopping).toBeGreaterThan(straight * 5);

  // Carve a few turns, then stop and look at the tracks from above.
  await page.waitForTimeout(800);
  for (const key of ['KeyA', 'KeyD', 'KeyA', 'KeyD']) {
    await page.keyboard.down(key);
    await page.waitForTimeout(700);
    await page.keyboard.up(key);
  }
  await page.keyboard.down('Shift');
  await page.waitForTimeout(2500);
  await page.keyboard.up('Shift');
  await page.keyboard.press('KeyV'); // back to first person
  await page.keyboard.press('KeyF'); // fly: hover where you stopped
  await page.keyboard.down('Space');
  await page.waitForTimeout(1600);
  await page.keyboard.up('Space');
  await page.evaluate(() =>
    document.dispatchEvent(
      new MouseEvent('mousemove', { movementX: 1430, movementY: 330 } as MouseEventInit),
    ),
  );
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'test-results/views/snow-tracks.png' });
});

test('third-person flying shows a see-through skier, skis included', async ({ page }) => {
  await start(page, 'at=45.2981,6.5803,2800&heading=0&pitch=0');
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(200);
  const visible = await page.evaluate(() => {
    const scene = (window.__sim as unknown as { scene: import('three').Scene }).scene;
    const ski = scene.getObjectByName('ski-left')!;
    const material = (ski.children[0] as import('three').Mesh).material as import('three').Material;
    return { skier: ski.parent!.visible, ski: ski.visible, opacity: material.opacity };
  });
  expect(visible.skier).toBe(true);
  expect(visible.ski).toBe(true);
  expect(visible.opacity).toBeLessThan(0.8);
  await page.screenshot({ path: 'test-results/views/fly-ghost.png' });

  // Back to ski mode: solid again.
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(200);
  const solid = await page.evaluate(() => {
    const scene = (window.__sim as unknown as { scene: import('three').Scene }).scene;
    const ski = scene.getObjectByName('ski-left')!;
    return ((ski.children[0] as import('three').Mesh).material as import('three').Material).opacity;
  });
  expect(solid).toBe(1);
});
