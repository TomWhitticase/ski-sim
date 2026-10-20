import { expect, test } from '@playwright/test';

// A first visit: none of the test defaults the config seeds.
test.use({ storageState: { cookies: [], origins: [] } });

test('first visit: title → resorts → start point → loading → skiing; nothing loads until chosen', async ({
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

  // A real title screen: no Continue on a first visit, Play leads.
  await expect(menu).toHaveAttribute('data-screen', 'title');
  await expect(menu.locator('.title-card .brand')).toHaveText('ski-sim');
  await expect(menu.locator('#continue-card')).toBeHidden();
  await expect(menu.locator('#title-play')).toHaveText('Play');
  await page.screenshot({ path: 'test-results/views/menu-title.png' });

  // Resorts: every area as a card, searchable; the last played (default) highlighted.
  await menu.locator('#title-play').click();
  await expect(menu).toHaveAttribute('data-screen', 'resorts');
  await expect(menu.locator('#menu-back')).toContainText('Main menu');
  await expect(menu.locator('.resort-card.selected')).toContainText('Les 3 Vallées');
  await menu.locator('#menu-search').fill('3 vall');
  await expect(menu.locator('.resort-card:visible')).toHaveCount(1);
  await menu.locator('#menu-search').fill('');
  await page.screenshot({ path: 'test-results/views/menu-resorts.png' });

  // Resort: start points in a list and as pins on a map.
  await menu.locator('#choose-start').click();
  await expect(menu).toHaveAttribute('data-screen', 'resort');
  const starts = menu.locator('#menu-starts .menu-item-name');
  const names = await starts.allTextContents();
  expect(names).toEqual(
    expect.arrayContaining(['Val Thorens', 'Courchevel', 'Les Ménuires', 'Méribel-Mottaret']),
  );
  await expect(menu.locator('.start-pin')).toHaveCount(names.length);
  await menu.locator('#menu-starts .menu-item', { hasText: 'Courchevel' }).first().click();
  await expect(menu.locator('#ski-from')).toHaveText('Ski from Courchevel');
  await page.screenshot({ path: 'test-results/views/menu-start-points.png' });

  // Esc goes back one screen at a time.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveAttribute('data-screen', 'resorts');
  await menu.locator('#choose-start').click();
  await page.waitForTimeout(500);
  expect(heavy).toEqual([]); // no map data yet

  // Loading, then one button to start.
  await menu.locator('#ski-from').click();
  await expect(menu).toHaveAttribute('data-screen', 'loading');
  await expect(menu.locator('#loading-where')).toHaveText('Les 3 Vallées · Courchevel');
  await expect(menu.locator('#status')).toContainText(/Downloading|Building|Growing|Preparing/);
  const start = menu.locator('#start');
  await expect(start).toHaveText('Start skiing', { timeout: 90_000 });
  await expect(start).toBeVisible();
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
  const toggle = (name: string) => page.locator(`#opt-display [data-toggle="${name}"]`);
  const viewRow = page.locator('#opt-display .option-row', {
    has: page.locator('[data-toggle="view"]'),
  });
  await expect(viewRow).toContainText('First person');
  await expect(viewRow.locator('kbd')).toHaveText('V');
  for (const name of ['view', 'lift', 'peak', 'pistes', 'restaurant'])
    await expect(toggle(name)).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#labels .label:not([hidden])')).toHaveCount(0);
  await page.keyboard.press('KeyV');
  await expect(toggle('view')).toHaveAttribute('aria-checked', 'true');
  // The quick toggles stay on screen, small; the one just pressed is lit.
  await expect(page.locator('#toggles [data-toggle="view"]')).toHaveClass(/on/);
  await expect(page.locator('#toggles [data-toggle="lift"]')).not.toHaveClass(/on/);
  // H hides everything, and shows it again.
  await page.keyboard.press('KeyH');
  await expect(page.locator('body')).toHaveClass(/hud-off/);
  await expect(page.locator('#minimap')).not.toBeVisible();
  await page.keyboard.press('KeyH');
  await expect(page.locator('#minimap')).toBeVisible();
  await expect(page.locator('body')).not.toHaveClass(/chase/);
});

test('returning: Continue leads the title and goes straight to loading', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('ski-sim.resort', 'les-3-vallees');
    localStorage.setItem(
      'ski-sim.pose.les-3-vallees',
      JSON.stringify({ v: 1, east: -925, north: -3573, altitude: 2400, heading: 90, pitch: 0 }),
    );
  });
  await page.goto('/');
  const menu = page.locator('#overlay');
  await expect(menu.locator('#continue-card')).toBeVisible();
  await expect(menu.locator('#continue-card b')).toHaveText('Les 3 Vallées');
  await expect(menu.locator('#title-play')).toHaveText('Choose a resort');
  await page.screenshot({ path: 'test-results/views/menu-title-returning.png' });
  await menu.locator('#title-continue').click();
  await expect(menu).toHaveAttribute('data-screen', 'loading');
  await expect(menu.locator('#loading-where')).toHaveText('Les 3 Vallées · Where you left off');
});

test('pause menu: change start point without reloading, and change resort after confirming', async ({
  page,
}) => {
  await page.goto('/?resort=les-3-vallees');
  const menu = page.locator('#overlay');
  const start = menu.locator('#start');
  await expect(start).toHaveText('Start skiing', { timeout: 90_000 });
  await start.click();
  await expect(menu).toHaveAttribute('data-screen', 'pause');
  await page.screenshot({ path: 'test-results/views/menu-pause.png' });

  // Change start point: the same resort's map; the button moves you, no reload.
  await menu.locator('#pause-start').click();
  await expect(menu).toHaveAttribute('data-screen', 'resort');
  await expect(menu.locator('#menu-back')).toContainText('Paused');
  await menu.locator('#menu-starts .menu-item', { hasText: 'Val Thorens' }).click();
  await expect(menu.locator('#ski-from')).toHaveText('Go to Val Thorens');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveAttribute('data-screen', 'pause');

  // Change resort: pick another, confirm leaving, and it loads at the chosen start.
  await menu.locator('#pause-resort').click();
  await menu.locator('.resort-card', { hasText: 'Arlberg' }).click();
  await menu.locator('#choose-start').click();
  await menu
    .locator('#menu-starts .menu-item')
    .filter({ has: page.locator('.menu-item-name', { hasText: /^Lech$/ }) })
    .click();
  await menu.locator('#ski-from').click();
  const confirm = page.locator('#confirm');
  await expect(confirm).toBeVisible();
  await expect(confirm.locator('h2')).toHaveText('Leave Les 3 Vallées?');
  await confirm.locator('button[value="leave"]').click();
  await page.waitForURL(/resort=arlberg/);
  expect(new URL(page.url()).searchParams.get('start')).toMatch(/Lech/);
  await expect(menu.locator('#loading-where')).toContainText('Lech');
  await expect(start).toHaveText('Start skiing', { timeout: 90_000 });
});
