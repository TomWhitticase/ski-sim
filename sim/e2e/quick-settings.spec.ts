import { expect, type Page, test } from '@playwright/test';

// Quick settings (Tab or the button under the minimap), presets, the command palette
// (Ctrl/⌘ + K) and context hints, on a desktop. The touch side is in mobile.spec.ts.

const SCRATCH = 'test-results/quick-settings';
const shot = (page: Page, name: string) => page.screenshot({ path: `${SCRATCH}/${name}.png` });
// Above Val Thorens, looking down the valley at the lifts and peaks.
const VIEW = 'at=45.2981,6.5803,2700&heading=10&pitch=-12';

/** A fake pointer lock that releases and recaptures like the real one. */
async function enter(page: Page, query = VIEW, mode = 'ski') {
  await page.addInitScript((m) => {
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
    localStorage.setItem('ski-sim.mode', m);
  }, mode);
  await page.goto(`/?resort=les-3-vallees&${query}`);
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10, null, { timeout: 90_000 });
  await page.evaluate(() => document.dispatchEvent(new Event('pointerlockchange')));
  await expect(page.locator('body')).toHaveClass(/flying/);
}

const row = (page: Page, id: string) => page.locator(`#quick-settings .qs-row[data-id="${id}"]`);
const labelsShown = (page: Page, kind: string) =>
  page.locator(`#labels .label-${kind}:not([hidden])`).count();

test('Tab opens Quick settings under the minimap; its switches drive the real toggles', async ({
  page,
}) => {
  await enter(page);
  const panel = page.locator('#quick-settings');
  const button = page.locator('#quick-button');
  await expect(panel).toBeHidden();
  await expect(button).toContainText('Quick settings');
  await expect(button.locator('kbd')).toHaveText('Tab');
  // The tests start with every label and piste colours on.
  await expect(button.locator('.qs-count')).toHaveText('5 on');

  await page.keyboard.press('Tab');
  await expect(panel).toBeVisible();
  // The mouse is released (the game carries on behind), but no pause menu.
  await expect(page.locator('body')).not.toHaveClass(/\bflying\b/);
  await expect(page.locator('#overlay')).toBeHidden();
  await expect(page.locator('#hud')).toHaveCSS('opacity', '1');
  // Below the minimap and the time, never over them, and inside the screen.
  const map = (await page.locator('#minimap').boundingBox())!;
  const where = (await page.locator('.hud-where').boundingBox())!;
  const box = (await panel.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(map.y + map.height);
  expect(box.y).toBeGreaterThanOrEqual(where.y + where.height);
  expect(box.y + box.height).toBeLessThanOrEqual(900);
  // Grouped, with each row's key.
  await expect(panel.locator('.qs-group h4')).toHaveText([
    'Labels',
    'On the snow',
    'View & sound',
    'Interface',
    'Go',
  ]);
  await expect(row(page, 'peak').locator('kbd')).toHaveText('2');
  await expect(row(page, 'lift').locator('.qs-label > span')).toHaveText('Lift names');
  await expect(row(page, 'airfield').locator('.qs-label > span')).toHaveText('Airfield names');
  await expect(row(page, 'airfield').locator('kbd')).toHaveText('5');
  // 5 works it, and Options → Display follows.
  await page.keyboard.press('Digit5');
  await expect(row(page, 'airfield').locator('.switch')).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#opt-display [data-toggle="airfield"]')).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await page.keyboard.press('Digit5');
  await expect(row(page, 'airfield').locator('.switch')).toHaveAttribute('aria-checked', 'true');
  await expect(row(page, 'peak').locator('.switch')).toHaveAttribute('aria-checked', 'true');
  await page.waitForTimeout(300);
  await shot(page, 'desktop-open');

  // A switch: peak names go off in the world, in Options → Display and in the strip.
  await page.waitForTimeout(500);
  expect(await labelsShown(page, 'peak')).toBeGreaterThan(0);
  await row(page, 'peak').locator('.switch').click();
  await expect(row(page, 'peak').locator('.switch')).toHaveAttribute('aria-checked', 'false');
  await expect.poll(() => labelsShown(page, 'peak')).toBe(0);
  await expect(page.locator('#opt-display [data-toggle="peak"]')).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await expect(page.locator('#toggles [data-toggle="peak"]')).not.toHaveClass(/\bon\b/);
  await expect(panel.locator('.qs-on')).toHaveText('4 on');
  // Its key still works with the panel open, and the switch follows.
  await page.keyboard.press('Digit2');
  await expect(row(page, 'peak').locator('.switch')).toHaveAttribute('aria-checked', 'true');
  // A click on the row (not just the switch) works it too.
  await row(page, 'restaurant').locator('.qs-label').click();
  await expect(row(page, 'restaurant').locator('.switch')).toHaveAttribute('aria-checked', 'false');
  // ↑ ↓ move between the rows, Space works the one focused.
  await panel.focus();
  await page.keyboard.press('ArrowDown');
  await expect(row(page, 'lift').locator('.switch')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(row(page, 'lift').locator('.switch')).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Space');

  // Tab closes it and captures the mouse again.
  await page.keyboard.press('Tab');
  await expect(panel).toBeHidden();
  await expect(page.locator('body')).toHaveClass(/flying/);

  // Its key pressed in game: the button says what it switched.
  await page.keyboard.press('Digit4');
  await expect(button.locator('.qs-flash')).toBeVisible();
  await expect(button.locator('.qs-flash')).toContainText('Restaurant names');
  await expect(button.locator('.qs-flash b')).toHaveText('On');
  await shot(page, 'desktop-flash');

  // Esc closes it back to the pause menu.
  await page.keyboard.press('Tab');
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(page.locator('#overlay')).toBeVisible();
});

test('Quick settings: the button opens it; an action row closes it and does it', async ({
  page,
}) => {
  await enter(page);
  const panel = page.locator('#quick-settings');
  // Released, the button is there to click (e.g. after Esc).
  await page.keyboard.press('Tab');
  await page.locator('#quick-button').click();
  await expect(panel).toBeHidden();
  await page.locator('#quick-button').click();
  await expect(panel).toBeVisible();
  await row(page, 'map').locator('button').click();
  await expect(panel).toBeHidden();
  await expect(page.locator('#world-map')).toBeVisible();
  await page.keyboard.press('KeyM');
  await expect(page.locator('#world-map')).toBeHidden();
  // A click away closes it.
  await page.keyboard.press('Tab');
  await expect(panel).toBeVisible();
  await page.mouse.click(500, 450);
  await expect(panel).toBeHidden();
  await expect(page.locator('body')).toHaveClass(/flying/);
});

test('Quick settings follows the rules and the mode: what is off says why', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'ski-sim.rules',
      JSON.stringify({
        teleport: false,
        snowmobile: false,
        paraglider: false,
        liftSkip: false,
        aircraft: false,
      }),
    ),
  );
  await enter(page);
  await page.keyboard.press('Tab');
  const glider = row(page, 'paraglider');
  await expect(glider).toHaveClass(/disabled/);
  await expect(glider.locator('button')).toBeDisabled();
  await expect(glider.locator('small')).toHaveText('The paraglider is off · Options → Rules');
  await expect(row(page, 'snowmobile').locator('small')).toContainText('The snowmobile is off');
  await expect(row(page, 'drone')).not.toHaveClass(/disabled/);
  await shot(page, 'desktop-rules');
  // In the drone there's no first person: the switch is greyed and says so.
  await row(page, 'drone').locator('button').click();
  await expect(page.locator('#hud [data-mode]')).toHaveText('DRONE');
  await page.keyboard.press('Tab');
  await expect(row(page, 'view')).toHaveClass(/disabled/);
  await expect(row(page, 'view').locator('small')).toHaveText('The drone has no first person');
  await expect(row(page, 'drone')).toHaveClass(/active/);
});
