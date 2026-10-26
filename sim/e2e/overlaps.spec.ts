import { devices, expect, type Page, test } from '@playwright/test';

// Every place two of our panels can sit on each other, on a desktop and a phone, saved
// to test-results/overlaps/ to be looked at: the upper one must read clearly (near-solid
// glass over a darker, blurred backdrop), never text through text.

const LAKE = 'resort=les-3-vallees&at=45.28856,6.5752,2400&heading=0&pitch=-10';
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `test-results/overlaps/${name}.png` });

/** A fake pointer lock, taken on request and released like the real one. */
async function fakeLock(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { locked?: boolean };
    Object.defineProperty(Document.prototype, 'pointerLockElement', {
      get: () => (w.locked ? document.querySelector('#scene') : null),
    });
    Element.prototype.requestPointerLock = function () {
      w.locked = true;
      document.dispatchEvent(new Event('pointerlockchange'));
      return Promise.resolve();
    };
    Document.prototype.exitPointerLock = function () {
      w.locked = false;
      document.dispatchEvent(new Event('pointerlockchange'));
    };
  });
}

/** A party card with two friends and a notice, as a multiplayer game shows them. */
async function fakeParty(page: Page) {
  await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('#party')!;
    card.hidden = false;
    card.innerHTML =
      '<div class="party-head">Party · K7QX2M</div>' +
      '<div class="party-row" style="--player:#ff9f1c"><i class="party-dot"></i>' +
      '<span class="party-name">Ana (host)</span><span class="party-where">320 m · skiing Cascades</span></div>' +
      '<div class="party-row" style="--player:#2bd576"><i class="party-dot"></i>' +
      '<span class="party-name">Ben</span><span class="party-where">1.4 km · on a lift</span></div>';
    const notice = document.createElement('div');
    notice.className = 'notice glass';
    notice.textContent = 'Ben joined the party';
    document.querySelector('#notices')!.append(notice);
  });
}

/** None of the HUD's panels sits on another. */
async function expectApart(page: Page) {
  const boxes = await page.evaluate(() =>
    ['#party', '#notices .notice', '.hud-stats', '#run', '.hud-side', '#touch-pause']
      .map((s) => document.querySelector(s))
      .filter((el): el is Element => !!el && el.getClientRects().length > 0)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.id || el.className, x: r.x, y: r.y, r: r.right, b: r.bottom };
      }),
  );
  for (const a of boxes)
    for (const b of boxes) {
      if (a === b) continue;
      const apart = a.r <= b.x || b.r <= a.x || a.b <= b.y || b.b <= a.y;
      expect(apart, `${a.id} overlaps ${b.id}`).toBe(true);
    }
}

async function enterWorld(page: Page, touch: boolean) {
  await page.goto(`/?${LAKE}`);
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10, null, { timeout: 90_000 });
  // The fake lock is granted at once on a desktop, so only a phone has "Tap to play".
  if (touch) {
    await expect(page.locator('#click-to-play')).toBeVisible();
    await page.locator('#click-to-play').tap();
  }
  await expect(page.locator('body')).toHaveClass(/flying/);
  await page.waitForTimeout(400);
}

async function pause(page: Page, touch: boolean) {
  if (touch) await page.locator('#touch-pause').tap();
  else await page.evaluate(() => document.exitPointerLock());
  await expect(page.locator('#overlay')).toHaveAttribute('data-screen', 'pause');
}

/** The open hub and the stacked dialogs are near-solid; what's under them is blurred. */
async function expectStacked(page: Page, selector: string) {
  const dialog = page.locator(selector);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveClass(/stacked/);
  const backdrop = await dialog.evaluate((el) => {
    const s = getComputedStyle(el, '::backdrop');
    return s.backdropFilter || s.getPropertyValue('-webkit-backdrop-filter');
  });
  expect(backdrop).toContain('blur');
}

for (const platform of ['desktop', 'phone'] as const) {
  test.describe(platform, () => {
    const touch = platform === 'phone';
    if (touch) {
      const { userAgent, isMobile, hasTouch } = devices['iPhone 14'];
      test.use({
        userAgent,
        isMobile,
        hasTouch,
        deviceScaleFactor: 2,
        viewport: { width: 844, height: 390 },
      });
    }

    test(`menus over menus read clearly (${platform})`, async ({ page }) => {
      test.setTimeout(180_000);
      await fakeLock(page);
      const tap = (selector: string) =>
        touch ? page.locator(selector).tap() : page.locator(selector).click();

      // Options over the title screen (no world yet).
      await page.goto('/');
      await expect(page.locator('#title-play')).toBeVisible();
      await tap('#open-settings');
      await expectStacked(page, '#options');
      await shot(page, `${platform}-options-over-title`);
      await tap('#options .hub-close');

      await enterWorld(page, touch);
      // The party card and a notice beside the HUD's own panels.
      await fakeParty(page);
      await shot(page, `${platform}-party-hud`);
      if (touch) {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(400);
        await shot(page, `${platform}-party-hud-portrait`);
        await expectApart(page);
        await page.setViewportSize({ width: 844, height: 390 });
      }
      await expectApart(page);

      // Options over the pause menu, and a confirm over that.
      await pause(page, touch);
      await shot(page, `${platform}-pause`);
      await tap('#pause-options');
      await expectStacked(page, '#options');
      await shot(page, `${platform}-options-over-pause`);
      await tap('#options .hub-close');

      // Leave? over the pause menu.
      await tap('#pause-quit');
      await expectStacked(page, '#confirm');
      await shot(page, `${platform}-confirm-over-pause`);
      await tap('#confirm button[value="stay"]');

      // The world map: its panel and key over the map (Options can't open over it).
      await tap('#pause-map');
      await expect(page.locator('#world-map')).toBeVisible();
      await page.waitForTimeout(500);
      await shot(page, `${platform}-map`);
      if (touch) {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(500);
        await shot(page, `${platform}-map-portrait`);
        // Unfolded, the key and the bottom sheet don't sit on each other.
        await page.evaluate(
          () => (document.querySelector<HTMLDetailsElement>('.map-key')!.open = true),
        );
        await shot(page, `${platform}-map-portrait-key`);
        const key = (await page.locator('.map-key').boundingBox())!;
        const sheet = (await page.locator('.map-panel').boundingBox())!;
        expect(key.y + key.height).toBeLessThanOrEqual(sheet.y + 1);
        await page.setViewportSize({ width: 844, height: 390 });
      }
    });
  });
}
