import { expect, type Page, test } from '@playwright/test';

/** Mean RGB of the screenshot's lower middle (forest, clear of the HUD), decoded in-page. */
async function meanColour(page: Page): Promise<[number, number, number]> {
  const png = (await page.screenshot()).toString('base64');
  return page.evaluate(async (data) => {
    const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const [x, y, w, h] = [
      bitmap.width * 0.05,
      bitmap.height * 0.45,
      bitmap.width * 0.75,
      bitmap.height * 0.45,
    ];
    const px = ctx.getImageData(x, y, w, h).data;
    const sum = [0, 0, 0];
    for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 3; c++) sum[c]! += px[i + c]!;
    const n = px.length / 4;
    return [sum[0]! / n, sum[1]! / n, sum[2]! / n] as [number, number, number];
  }, png);
}

test('tree detail levels look alike: the same forest drawn at each level has about the same colour', async ({
  page,
}) => {
  // Méribel's forest from above the trees, everything within the far level's range.
  await page.goto('/?resort=les-3-vallees&at=45.3890,6.5700,1640&heading=120&pitch=-12');
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 30, null, { timeout: 90_000 });
  await page.evaluate(() => document.body.classList.add('flying'));
  const colours: [number, number, number][] = [];
  for (const level of [0, 1, 2]) {
    await page.evaluate((level) => {
      (window.__sim as unknown as { forest: { showOnly(l: number): void } }).forest.showOnly(level);
    }, level);
    await page.waitForTimeout(1000);
    colours.push(await meanColour(page));
  }
  const [detailed, ...coarse] = colours;
  for (const c of coarse) {
    for (let i = 0; i < 3; i++) {
      // Within 10% per channel (it was 25-30% darker before the coarse shapes held snow).
      expect(Math.abs(c[i]! / detailed![i]! - 1)).toBeLessThan(0.1);
    }
  }
});
