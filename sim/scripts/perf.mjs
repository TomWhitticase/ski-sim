// Measures load time and steady-state fps at a few camera poses against the running dev
// server (pnpm dev). Usage: pnpm perf [--headed] [--only=spawn,village]
import { chromium } from '@playwright/test';

const POSES = {
  // Naming the resort loads it straight away (a bare URL waits at the menu).
  spawn: 'resort=les-3-vallees',
  village: 'at=45.3005,6.5765,2420&heading=150&pitch=-18',
  'mont-blanc-horizon': 'at=45.2632,6.5610,3210&heading=25&pitch=0',
  'ski-slope': 'at=45.2830,6.5760,2600&heading=27&pitch=-10',
  // Mountain restaurants above St. Anton (Krazy Kanguruh, Mooserwirt, Sennhütte...).
  'st-anton-huts': 'resort=arlberg&at=47.129080,10.256784,1467&heading=328&pitch=-10',
  'meribel-forest': 'at=45.3890,6.5700,1700&heading=120&pitch=-5',
  // Courchevel's altiport from the approach: runway paint, snowbanks, aprons, buildings.
  'courchevel-altiport': 'at=45.40096,6.63968,1965&heading=224&pitch=-3',
};
const only = process.argv
  .find((a) => a.startsWith('--only='))
  ?.slice(7)
  .split(',');

const browser = await chromium.launch({
  headless: !process.argv.includes('--headed'),
  args: ['--enable-gpu', '--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

for (const [name, query] of Object.entries(POSES)) {
  if (only && !only.includes(name)) continue;
  const start = Date.now();
  await page.goto(`http://localhost:${process.env.SIM_PORT ?? 5173}/?${query}`);
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 0, null, { timeout: 90_000 });
  const firstFrame = Date.now() - start;
  await page.evaluate(() => document.body.classList.add('flying'));
  await page.waitForTimeout(2000);
  const a = await page.evaluate(() => window.__sim.frames);
  await page.waitForTimeout(3000);
  const b = await page.evaluate(() => window.__sim.frames);
  console.log(
    `${name.padEnd(20)} first frame ${String(firstFrame).padStart(5)} ms   ${((b - a) / 3).toFixed(1)} fps`,
  );
}
await browser.close();
