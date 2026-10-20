import { expect, test } from '@playwright/test';

// A first visit: none of the test defaults the config seeds.
test.use({ storageState: { cookies: [], origins: [] } });

test('main menu: nothing loads until you pick a ski area and load it, then ski from where you chose', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'pointerLockElement', {
      get: () => document.querySelector('#scene'),
    });
  });
  const heavy: string[] = [];
  page.on(
    'request',
    (r) =>
      /terrain-(near|far)\.bin|features\.json|landcover-.*\.png/.test(r.url()) &&
      heavy.push(r.url()),
  );
  await page.goto('/');
  const menu = page.locator('#overlay');
  await expect(menu.locator('h1')).toHaveText('ski-sim');
  // The last area played (here the default) is highlighted, with its start points.
  await expect(menu.locator('#menu-resorts .menu-item.selected')).toContainText('Les 3 Vallées');
  const starts = menu.locator('#menu-starts .menu-item-name');
  await expect(starts).toContainText(['Val Thorens']);
  const names = await starts.allTextContents();
  expect(names).toEqual(expect.arrayContaining(['Courchevel', 'Les Ménuires', 'Méribel-Mottaret']));
  const start = menu.locator('#start');
  await expect(start).toHaveText('Load Les 3 Vallées');
  await expect(menu.locator('#open-multiplayer')).toBeDisabled();
  await page.waitForTimeout(1000);
  expect(heavy).toEqual([]); // no map data yet
  await page.screenshot({ path: 'test-results/views/main-menu.png' });

  await menu.locator('#menu-starts .menu-item', { hasText: 'Courchevel' }).first().click();
  await start.click();
  await expect(start).toBeDisabled();
  await expect(start).toHaveText('Loading Les 3 Vallées…');
  await expect(menu.locator('#load-progress')).toBeVisible();
  await expect(menu.locator('#status')).toContainText(/Downloading|Building|Growing|Preparing/);
  await expect(start).toHaveText('Start skiing', { timeout: 90_000 });
  await expect(menu.locator('#load-progress')).toBeHidden();
  await expect(menu.locator('#open-multiplayer')).toBeEnabled();
  // The choice made before loading still stands.
  await expect(menu.locator('#menu-starts .menu-item.selected')).toContainText('Courchevel');

  await start.click();
  await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
  await page.waitForTimeout(500);
  await expect(page.locator('#hud [data-mode]')).toHaveText('SKI');
  // Courchevel 1850 is around 45.41 N, 6.63 E, standing beside its main lift.
  const lat = parseFloat((await page.locator('#hud [data-field="lat"]').textContent()) ?? '');
  const lon = parseFloat((await page.locator('#hud [data-field="lon"]').textContent()) ?? '');
  expect(lat).toBeGreaterThan(45.38);
  expect(lon).toBeGreaterThan(6.6);
  await expect(page.locator('#prompt')).toContainText('ride'); // a lift right in front of you

  // Defaults: third person (V switches, shown under the minimap) and no markers.
  await expect(page.locator('body')).toHaveClass(/chase/);
  const toggle = (name: string) => page.locator(`#toggles [data-toggle="${name}"] b`);
  await expect(page.locator('#toggles [data-toggle="view"]')).toContainText('V First person');
  for (const name of ['view', 'lift', 'peak', 'pistes', 'restaurant'])
    await expect(toggle(name)).toHaveText('OFF');
  await expect(page.locator('#labels .label:not([hidden])')).toHaveCount(0);
  await page.keyboard.press('KeyV');
  await expect(toggle('view')).toHaveText('ON');
  await expect(page.locator('body')).not.toHaveClass(/chase/);
});

test('pause menu: picking another ski area asks before leaving, then loads it at the chosen start', async ({
  page,
}) => {
  await page.goto('/?resort=les-3-vallees');
  const menu = page.locator('#overlay');
  const start = menu.locator('#start');
  await expect(start).toHaveText('Start skiing', { timeout: 90_000 });
  await menu.locator('#menu-resorts .menu-item', { hasText: 'Arlberg' }).click();
  await expect(start).toHaveText('Switch to Ski Arlberg');
  await expect(menu.locator('#status')).toHaveText('Switching leaves Les 3 Vallées');
  const lech = menu.locator('#menu-starts .menu-item', { hasText: 'Lech' }).first();
  await lech.click();
  await start.click();
  await page.waitForURL(/resort=arlberg/);
  expect(new URL(page.url()).searchParams.get('start')).toMatch(/Lech/);
  await expect(start).toHaveText('Start skiing', { timeout: 90_000 });
  await expect(menu.locator('#menu-starts .menu-item.selected')).toContainText('Lech');
});
