// Quick FPS probe at a fixed overlay-heavy pose, fresh browser. Run against the before/after
// dev-server state and compare. Usage: node scripts/piste-perf.mjs [--port 5191] [--label X]
import { chromium } from '@playwright/test';
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const PORT = arg('port', '5191');
const LABEL = arg('label', '');
const POSE = 'at=44.99850,6.20500,3220&heading=250&pitch=-22'; // high-wide: lots of overlay
const SAMPLE_MS = 6000;
async function fps() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--enable-gpu',
      '--enable-unsafe-webgpu',
      '--ignore-gpu-blocklist',
      '--use-angle=vulkan',
      '--enable-features=Vulkan',
      '--no-sandbox',
    ],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    await page.goto(`http://localhost:${PORT}/?resort=les-2-alpes&${POSE}`, { timeout: 90000 });
    await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 60, null, { timeout: 90000 });
    const f0 = await page.evaluate(() => window.__sim.frames);
    const t0 = Date.now();
    await page.waitForTimeout(SAMPLE_MS);
    const f1 = await page.evaluate(() => window.__sim.frames);
    const dt = (Date.now() - t0) / 1000;
    return (f1 - f0) / dt;
  } finally {
    await browser.close();
  }
}
const runs = [];
for (let i = 0; i < 3; i++) runs.push(await fps());
const avg = runs.reduce((a, b) => a + b, 0) / runs.length;
console.log(
  `${LABEL.padEnd(8)} fps: ${runs.map((r) => r.toFixed(1)).join(', ')}  avg ${avg.toFixed(1)}`,
);
