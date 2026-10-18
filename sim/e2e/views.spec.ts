import { expect, test } from '@playwright/test';

// Fixed camera poses rendered to screenshots for visual review. Pose: lat,lon,altitude.
const VIEWS = [
  { name: 'spawn', query: '' },
  { name: 'caron-from-village', query: 'at=45.2985,6.5830,2450&heading=215&pitch=5' },
  { name: 'peclet-glacier', query: 'at=45.2900,6.5850,3100&heading=105&pitch=-5' },
  { name: 'orelle-valley', query: 'at=45.2500,6.5650,3200&heading=200&pitch=-20' },
  { name: 'mont-blanc-horizon', query: 'at=45.2632,6.5610,3210&heading=25&pitch=0' },
];

for (const view of VIEWS) {
  test(view.name, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

    await page.goto(`/?${view.query}`);
    await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 30, null, { timeout: 90_000 });
    // Hide the start overlay so the scene is visible.
    await page.evaluate(() => document.body.classList.add('flying'));
    await page.waitForTimeout(500);
    await page.screenshot({ path: `test-results/views/${view.name}.png` });

    expect(errors).toEqual([]);
  });
}
