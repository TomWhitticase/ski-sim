import { expect, type Page, test } from '@playwright/test';

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

/** Turn the view (~7.9 px per degree; +x right, +y down). */
const look = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([movementX, movementY]) =>
      document.dispatchEvent(
        new MouseEvent('mousemove', { movementX, movementY } as MouseEventInit),
      ),
    [x, y],
  );

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `test-results/views/gondola-${name}.png` });

test('riding a gondola: seated inside the cabin, looking out', async ({ page }) => {
  test.setTimeout(150_000);
  await start(page, 'at=45.2877102,6.5831979,2352&heading=133&pitch=-5'); // near the Moraine base
  await page.keyboard.press('KeyF');
  await expect(page.locator('#prompt')).toContainText('ride Moraine');
  await page.keyboard.press('KeyE');
  await expect(page.locator('#prompt')).toContainText(/hold W to fast-forward · S to skip/, {
    timeout: 60_000,
  });
  await page.waitForTimeout(1000);
  await shot(page, 'boarded-fp');
  // Out of the station and up the line.
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2500);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(500);
  await shot(page, 'ride-fp-forward');
  await look(page, 714, 0);
  await page.waitForTimeout(200);
  await shot(page, 'ride-fp-right');
  await look(page, -1428, 0);
  await page.waitForTimeout(200);
  await shot(page, 'ride-fp-left');
  await look(page, 714, 500);
  await page.waitForTimeout(200);
  await shot(page, 'ride-fp-down');
  await look(page, 1428, -400);
  await page.waitForTimeout(200);
  await shot(page, 'ride-fp-back');
  await look(page, 1428, 0);
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(300);
  await shot(page, 'ride-chase');
  await look(page, 500, 150);
  await page.waitForTimeout(200);
  await shot(page, 'ride-chase-side');
});

test('gondola cabins on the line and in the station', async ({ page }) => {
  // Beside the Moraine line, level with the cabins, looking up it past a tower.
  await start(page, 'at=45.286839,6.584369,2374&heading=108&pitch=-2');
  await page.waitForTimeout(500);
  await shot(page, 'line');
  // Inside the bottom station hall, by the loading point.
  await start(page, 'at=45.287573,6.583400,2351.5&heading=4&pitch=-8');
  await page.waitForTimeout(500);
  await shot(page, 'station');
});

test('riding a cable car: standing at the front window', async ({ page }) => {
  test.setTimeout(150_000);
  await start(page, 'at=45.280569,6.562613,2320&heading=186&pitch=0'); // Cime Caron base
  await page.keyboard.press('KeyF');
  await expect(page.locator('#prompt')).toContainText('ride Cime Caron');
  await page.keyboard.press('KeyE');
  // Fast-forward to the next departure, then a little way up the line.
  await page.keyboard.down('KeyW');
  await expect(page.locator('#prompt')).toContainText(/S to skip to the top · E to jump off/, {
    timeout: 120_000,
  });
  const altitude = async () =>
    parseFloat(
      ((await page.locator('#hud [data-field="altitude"]').textContent()) ?? '').replace(/,/g, ''),
    );
  const base = await altitude();
  await expect.poll(altitude, { timeout: 60_000 }).toBeGreaterThan(base + 40);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(500);
  await shot(page, 'cable-car-fp');
  await look(page, -600, 150);
  await page.waitForTimeout(200);
  await shot(page, 'cable-car-fp-inside');
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(300);
  await shot(page, 'cable-car-chase');
});
