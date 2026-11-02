// Screenshot runner for the piste-overlay v2 ship. Captures the running dev server at fixed
// poses (no overlay URL flag — v2 is the default now). Before/after is done by stashing the
// source and restarting the server, using --label to keep the filenames apart.
// Usage: node scripts/piste-shots.mjs [--port 5191] [--out <dir>] [--poses x,y]
//                                     [--angle vulkan] [--webgl] [--phone] [--resort id]
//                                     [--poses-file <json>] [--time <seconds>] [--label <suffix>]
// A fresh browser per shot: WebGPU contexts don't free fast enough on the 4 GB GTX 1650.
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : d;
};
const has = (k) => process.argv.includes(`--${k}`);

const PORT = arg('port', '5191');
const OUT = arg('out', 'test-results/piste');
const ANGLE = arg('angle', 'vulkan');
const WEBGL = has('webgl');
const PHONE = has('phone');
const RESORT = arg('resort', 'les-2-alpes');
const POSES_FILE = arg('poses-file', '');
const TIME = arg('time', ''); // seconds since local midnight; paused
const LABEL = arg('label', ''); // filename suffix, e.g. "before" / "after" / "night"

// Fixed, fair camera poses. Les 2 Alpes (origin 45.00895,6.17065).
const POSES = {
  'on-piste': 'at=45.00235,6.16144,2347&heading=189&pitch=-9',
  junction: 'at=45.00130,6.16600,2520&heading=200&pitch=-14',
  'down-slope': 'at=44.99750,6.14850,2460&heading=214&pitch=-15',
  'several-runs': 'at=45.00950,6.14550,2250&heading=300&pitch=-11',
  'lift-ride': 'at=45.00300,6.16000,2430&heading=20&pitch=-3',
  'high-wide': 'at=44.99850,6.20500,3220&heading=250&pitch=-22',
  'very-far': 'at=44.98161,6.19230,2972&heading=315&pitch=-10',
};
if (POSES_FILE) {
  const extra = JSON.parse(readFileSync(POSES_FILE, 'utf8'));
  for (const [k, v] of Object.entries(extra)) POSES[k] = v;
}

const POSE_KEYS = (arg('poses', Object.keys(POSES).join(',')) || '').split(',').filter(Boolean);

const angleArgs = {
  gl: ['--use-angle=gl'],
  swiftshader: ['--use-angle=swiftshader', '--use-gl=swiftshader'],
  vulkan: ['--use-angle=vulkan', '--enable-features=Vulkan'],
}[ANGLE] ?? ['--use-angle=vulkan', '--enable-features=Vulkan'];

mkdirSync(OUT, { recursive: true });
const viewport = PHONE ? { width: 390, height: 844 } : { width: 1600, height: 900 };

async function shoot(poseKey) {
  const pose = POSES[poseKey];
  if (!pose) {
    console.log(`skip unknown pose ${poseKey}`);
    return false;
  }
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--enable-gpu',
      '--enable-unsafe-webgpu',
      '--ignore-gpu-blocklist',
      '--enable-features=Vulkan',
      ...angleArgs,
      '--no-sandbox',
    ],
  });
  try {
    const ctx = await browser.newContext({
      viewport,
      deviceScaleFactor: PHONE ? 2 : 1,
      storageState: {
        cookies: [],
        origins: [
          {
            origin: `http://localhost:${PORT}`,
            localStorage: [
              { name: 'ski-sim.view', value: 'first-person' },
              {
                name: 'ski-sim.labels',
                value: JSON.stringify({
                  lift: false,
                  peak: false,
                  restaurant: false,
                  pistes: true,
                }),
              },
              ...(TIME
                ? [
                    {
                      name: 'ski-sim.time-of-day',
                      value: JSON.stringify({ seconds: Number(TIME), rate: 0 }),
                    },
                  ]
                : []),
            ],
          },
        ],
      },
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text().slice(0, 160));
    });
    const webglParam = WEBGL ? '&webgl=1' : '';
    const url = `http://localhost:${PORT}/?resort=${RESORT}&${pose}${webglParam}`;
    await page.goto(url, { timeout: 90_000 });
    await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 45, null, { timeout: 90_000 });
    await page.waitForTimeout(800);
    const suffix = `${LABEL ? `_${LABEL}` : ''}${PHONE ? '_phone' : ''}${WEBGL ? '_webgl' : ''}`;
    const path = `${OUT}/${poseKey}${suffix}.png`;
    await page.screenshot({ path });
    console.log(
      `ok  ${path}${errors.length ? `  (${errors.length} console errors: ${errors[0]})` : ''}`,
    );
    return true;
  } finally {
    await browser.close();
  }
}

let ok = 0;
let fail = 0;
for (const poseKey of POSE_KEYS) {
  try {
    if (await shoot(poseKey)) ok++;
    else fail++;
  } catch (e) {
    console.log(`FAIL ${poseKey}: ${String(e).slice(0, 160)}`);
    fail++;
  }
}
console.log(`\ndone: ${ok} ok, ${fail} failed`);
process.exit(fail > 0 && ok === 0 ? 1 : 0);
