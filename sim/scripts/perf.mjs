// Measures load time and steady-state fps at a few camera poses against the running dev
// server (pnpm dev). Usage: pnpm perf [--headed] [--only name,name] [--mobile]
// [--glass full|light|tint] [--hub]
//   --mobile  an iPhone 14 on its side (touch, the phone's quality settings and HUD)
//   --glass   the interface glass strength (default: the device's)
//   --hub     with the Options hub open over the world (the most glass on screen)
import { chromium, devices } from '@playwright/test';

const POSES = {
  spawn: '',
  village: 'at=45.3005,6.5765,2420&heading=150&pitch=-18',
  'mont-blanc-horizon': 'at=45.2632,6.5610,3210&heading=25&pitch=0',
  'ski-slope': 'at=45.2830,6.5760,2600&heading=27&pitch=-10',
  // Mountain restaurants above St. Anton (Krazy Kanguruh, Mooserwirt, Sennhütte...).
  'st-anton-huts': 'resort=arlberg&at=47.129080,10.256784,1467&heading=328&pitch=-10',
  'meribel-forest': 'at=45.3890,6.5700,1700&heading=120&pitch=-5',
  // Weather on: a sea of cloud in the Belleville valley seen from above (Open-Meteo
  // answered here, nothing fetched), and the same pose with no weather.
  'sea-of-cloud': 'at=45.2760,6.5620,3500&heading=355&pitch=-12&weather=sea',
  'sea-of-cloud-clear': 'at=45.2760,6.5620,3500&heading=355&pitch=-12',
  // Courchevel's altiport from the approach: runway paint, snowbanks, aprons, buildings.
  'courchevel-altiport': 'at=45.40096,6.63968,1965&heading=224&pitch=-3',
  // Courchevel 1850's streets and the hairpins below: the most road tiles in view.
  'courchevel-roads': 'at=45.41350,6.64250,1960&heading=225&pitch=-24',
};

/** Open-Meteo's answer: saturated below 2,600 m north of the ridge, dry elsewhere. */
function seaOfCloud(url) {
  const start = Date.parse(`${url.searchParams.get('start_date')}T00:00:00Z`);
  const time = Array.from({ length: 72 }, (_, i) =>
    new Date(start + i * 3_600_000).toISOString().slice(0, 16),
  );
  const list = (k) => (url.searchParams.get(k) ?? '').split(',').filter(Boolean).map(Number);
  const lats = list('latitude');
  const elevations = list('elevation');
  const pressure = url.searchParams.get('hourly').includes('hPa');
  return lats.map((lat, i) => {
    const cloud = lat > 45.27 && elevations[i] < 2600;
    const fill = (v) => time.map(() => (pressure ? null : v));
    return {
      hourly: {
        time,
        temperature_2m: fill(-3),
        relative_humidity_2m: fill(cloud ? 100 : 40),
        precipitation: fill(0),
        snowfall: fill(0),
        cloud_cover_low: fill(cloud ? 100 : 0),
        cloud_cover_mid: fill(0),
        cloud_cover_high: fill(0),
        wind_speed_10m: fill(3),
        wind_direction_10m: fill(270),
        wind_gusts_10m: fill(8),
      },
    };
  });
}
const arg = (name) =>
  process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null;
const only = arg('--only')?.split(',') ?? null;
const mobile = process.argv.includes('--mobile');
const glass = arg('--glass');
const hub = process.argv.includes('--hub');

const browser = await chromium.launch({
  headless: !process.argv.includes('--headed'),
  args: ['--enable-gpu', '--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const { userAgent, isMobile, hasTouch, deviceScaleFactor } = devices['iPhone 14'];
const page = await browser.newPage(
  mobile
    ? { userAgent, isMobile, hasTouch, deviceScaleFactor, viewport: { width: 844, height: 390 } }
    : { viewport: { width: 1600, height: 900 } },
);

await page.route('**/*open-meteo.com/**', (route) =>
  route.fulfill({ json: seaOfCloud(new URL(route.request().url())) }),
);

for (const [name, query] of Object.entries(POSES)) {
  if (only && !only.includes(name)) continue;
  const weather = query.includes('weather=sea')
    ? { 'les-3-vallees': { mode: 'past', date: '2024-01-10' } }
    : {};
  await page.goto(`http://localhost:${process.env.SIM_PORT ?? 5173}/`);
  await page.evaluate(
    ([w, g]) => {
      localStorage.setItem('ski-sim.weather', JSON.stringify(w));
      localStorage.setItem('ski-sim.time-of-day', JSON.stringify({ seconds: 11 * 3600, rate: 0 }));
      if (g) localStorage.setItem('ski-sim.display', JSON.stringify({ glass: g, uiScale: 1 }));
      else localStorage.removeItem('ski-sim.display');
    },
    [weather, glass],
  );
  const start = Date.now();
  await page.goto(`http://localhost:${process.env.SIM_PORT ?? 5173}/?${query}`);
  await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 0, null, { timeout: 90_000 });
  const firstFrame = Date.now() - start;
  await page.evaluate(() => document.body.classList.add('flying'));
  if (hub) await page.evaluate(() => document.querySelector('#options').showModal());
  await page.waitForTimeout(2000);
  const a = await page.evaluate(() => window.__sim.frames);
  await page.waitForTimeout(3000);
  const b = await page.evaluate(() => window.__sim.frames);
  console.log(
    `${name.padEnd(20)} first frame ${String(firstFrame).padStart(5)} ms   ${((b - a) / 3).toFixed(1)} fps`,
  );
}
await browser.close();
