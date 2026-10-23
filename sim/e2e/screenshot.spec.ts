import { expect, test } from '@playwright/test';

// F2 downloads the rendered scene, named by resort and pose.
test('F2 saves a screenshot', async ({ page }) => {
  await page.goto('/?resort=les-3-vallees&at=45.2830,6.5760,2600&heading=27&pitch=-10');
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 10, null, { timeout: 90_000 });
  const download = page.waitForEvent('download');
  await page.keyboard.press('F2');
  const file = await download;
  expect(file.suggestedFilename()).toMatch(
    /^ski-sim_les-3-vallees_45\.283\d+,6\.576\d+,2600_h27_p-10_.*\.png$/,
  );
});
