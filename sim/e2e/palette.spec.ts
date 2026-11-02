import { expect, type Page, test } from '@playwright/test';

// The command palette (Ctrl/⌘ + K), the context hints (once each, the first time they're
// relevant) and the view presets, on a desktop.

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `test-results/quick-settings/${name}.png` });
// Above Val Thorens, looking up at Mont de la Chambre and the Péclet.
const VIEW = 'at=45.2981,6.5803,2700&heading=10&pitch=-12';

/**
 * In game with a fake pointer lock that releases and recaptures like the real one.
 * `setup` runs before the page's own scripts on the first load only (not on reloads).
 */
async function enter(page: Page, setup?: () => void, query = VIEW) {
  await page.addInitScript(() => {
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
  if (setup) {
    await page.addInitScript(`if (!sessionStorage.getItem('setup')) {
      sessionStorage.setItem('setup', '1'); (${setup.toString()})(); }`);
  }
  await page.goto(`/?resort=les-3-vallees&${query}`);
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10, null, { timeout: 90_000 });
  await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
  await expect(page.locator('body')).toHaveClass(/flying/);
}

const palette = (page: Page) => page.locator('#palette');
const item = (page: Page, id: string) => page.locator(`#palette .palette-item[data-id="${id}"]`);

test('Ctrl+K searches every setting and action, shows keys and state, and runs one', async ({
  page,
}) => {
  await enter(page);
  await page.keyboard.press('Control+KeyK');
  await expect(palette(page)).toBeVisible();
  await expect(page.locator('#palette input')).toBeFocused();
  // Everything's listed, the first chosen.
  expect(await page.locator('#palette .palette-item').count()).toBeGreaterThan(25);
  await page.keyboard.type('name');
  await expect(page.locator('#palette .palette-item').first()).toHaveAttribute('data-id', 'lift');
  await expect(item(page, 'peak').locator('kbd')).toHaveText('2');
  await expect(item(page, 'airfield').locator('kbd')).toHaveText('5');
  await expect(item(page, 'peak').locator('.palette-state')).toHaveText('On');
  await shot(page, 'palette-search');
  // Typing doesn't reach the game: K didn't mute, 2 doesn't hide peak names.
  await page.keyboard.type(' 2');
  await expect(page.locator('#opt-display [data-toggle="sound"]')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(item(page, 'peak').locator('.palette-state')).toHaveText('On');
  await page.locator('#palette input').fill('');
  // By synonym: "mute" finds Sound; ↓ ↑ pick, Enter runs and closes.
  await page.keyboard.type('summit');
  await expect(page.locator('#palette .palette-item').first()).toHaveAttribute('data-id', 'peak');
  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeHidden();
  await expect(page.locator('body')).toHaveClass(/flying/); // playing again
  await expect(page.locator('#opt-display [data-toggle="peak"]')).toHaveAttribute(
    'aria-checked',
    'false',
  );
  // Keyboard: ↓ moves the choice.
  await page.keyboard.press('Control+KeyK');
  await page.keyboard.type('mute');
  await expect(page.locator('#palette .palette-item')).toHaveCount(1);
  await page.locator('#palette input').fill('snow');
  const first = await page.locator('#palette .palette-item').first().getAttribute('data-id');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#palette .palette-item[aria-selected="true"]')).not.toHaveAttribute(
    'data-id',
    first!,
  );
  await page.locator('#palette input').fill('zzzz');
  await expect(page.locator('#palette .palette-empty')).toHaveText('Nothing matches');
  // Esc closes it (back to the pause menu: Esc can't capture the mouse).
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
  await expect(page.locator('#overlay')).toBeVisible();
});

test('the palette greys what the rules switch off, with the reason, and opens menus', async ({
  page,
}) => {
  await enter(page, () =>
    localStorage.setItem(
      'ski-sim.rules',
      JSON.stringify({
        teleport: true,
        snowmobile: false,
        paraglider: true,
        liftSkip: true,
        aircraft: true,
      }),
    ),
  );
  await page.keyboard.press('Control+KeyK');
  await page.keyboard.type('snowmobile');
  const sled = item(page, 'snowmobile');
  await expect(sled).toHaveAttribute('aria-disabled', 'true');
  await expect(sled.locator('small')).toHaveText('The snowmobile is off · Options → Rules');
  await page.keyboard.press('Enter'); // does nothing
  await expect(palette(page)).toBeVisible();
  await expect(page.locator('#hud [data-mode]')).toHaveText('SKI');
  await shot(page, 'palette-rules');
  // A menu: Time of day opens its Options tab.
  await page.locator('#palette input').fill('time');
  await page.keyboard.press('Enter');
  await expect(page.locator('#opt-time')).toBeVisible();
});

test('Quick settings: presets set the labels and overlays together', async ({ page }) => {
  await enter(page);
  await page.keyboard.press('Tab');
  const preset = (id: string) => page.locator(`#quick-settings .qs-preset[data-preset="${id}"]`);
  const on = (id: string) =>
    page.locator(`#quick-settings .qs-row[data-id="${id}"] .switch`).getAttribute('aria-checked');
  await expect(preset('realistic')).toHaveText('Realistic');
  await preset('realistic').click();
  await expect(preset('realistic')).toHaveAttribute('aria-pressed', 'true');
  for (const id of ['lift', 'peak', 'restaurant', 'airfield', 'pistes'])
    expect(await on(id)).toBe('false');
  await expect(page.locator('#labels .label:not([hidden])')).toHaveCount(0);
  await expect(page.locator('#debug')).toBeHidden();
  await shot(page, 'preset-realistic');
  await preset('navigator').click();
  for (const id of ['lift', 'peak', 'restaurant', 'airfield', 'pistes'])
    expect(await on(id)).toBe('true');
  await expect(page.locator('#debug')).toBeHidden();
  await preset('explorer').click();
  await expect(page.locator('#debug')).toBeVisible(); // F3's debug info too
  await expect(preset('explorer')).toHaveAttribute('aria-pressed', 'true');
  await shot(page, 'preset-explorer');
  // Your own mix: no preset lit. And presets are in the palette.
  await page.locator('#quick-settings .qs-row[data-id="peak"] .switch').click();
  await expect(page.locator('#quick-settings .qs-preset[aria-pressed="true"]')).toHaveCount(0);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Control+KeyK');
  await page.keyboard.type('realistic');
  await page.keyboard.press('Enter');
  await expect(page.locator('#debug')).toBeHidden();
  await expect(page.locator('#labels .label:not([hidden])')).toHaveCount(0);
});

test('a context hint shows once, the first time it is relevant, and never again', async ({
  page,
}) => {
  test.setTimeout(180_000);
  // Labels off, every hint seen but peak names'.
  await enter(page, () => {
    localStorage.setItem(
      'ski-sim.labels',
      JSON.stringify({ lift: false, peak: false, restaurant: false, pistes: false }),
    );
    localStorage.setItem(
      'ski-sim.hints-seen',
      JSON.stringify(['quick', 'lift', 'pistes', 'restaurant', 'map', 'palette']),
    );
  });
  const hint = page.locator('#hint');
  await expect(hint).toBeVisible({ timeout: 20_000 });
  await expect(hint).toHaveAttribute('data-hint', 'peak');
  await expect(hint).toContainText('Press 2 for peak names');
  await shot(page, 'hint-peak');
  await expect(hint).toBeHidden({ timeout: 15_000 });
  expect(await page.evaluate(() => localStorage.getItem('ski-sim.hints-seen'))).toContain('peak');
  // Back again: still relevant, but it's been seen.
  await page.reload();
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10, null, { timeout: 90_000 });
  await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
  await page.waitForTimeout(12_000);
  await expect(hint).toBeHidden();
});

test('the palette is introduced once; tips can be switched off in Options', async ({ page }) => {
  test.setTimeout(180_000);
  await enter(page, () => {
    localStorage.setItem('ski-sim.hints-seen', JSON.stringify(['quick']));
  });
  const hint = page.locator('#hint');
  // Using Quick settings tells you about the palette next time it's closed.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(hint).toHaveAttribute('data-hint', 'palette', { timeout: 15_000 });
  await expect(hint.locator('kbd')).toHaveText([/Ctrl|⌘/, 'K']);
  await shot(page, 'hint-palette');
  // Options → Display: Tips off, then no more hints.
  await page.keyboard.press('KeyO');
  await page.locator('#options [data-tab="opt-display"]').click();
  const tips = page.locator('#opt-display .switch[aria-label="Tips"]');
  await expect(tips).toHaveAttribute('aria-checked', 'true');
  await tips.click();
  await expect(tips).toHaveAttribute('aria-checked', 'false');
  await expect(hint).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('ski-sim.display'))).toContain(
    '"tips":false',
  );
});
