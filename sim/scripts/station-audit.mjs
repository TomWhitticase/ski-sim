// Renders every lift terminal from four standard angles into a contact sheet, failing
// stations first. Needs a running dev server (pnpm dev) for the window.__sim handles.
// Usage: pnpm station-audit [--resort <id>] [--lift "<name regex>"] [--limit N]
//          [--failing-only] [--all] [--sample N] [--jobs N] [--out <dir>] [--port N]
//          [--reload] [--headed]
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import proj4 from 'proj4';
import { staticChecks } from './station-checks.mjs';

const SIM_DIR = fileURLToPath(new URL('..', import.meta.url));
const DATA_DIR = resolve(SIM_DIR, '../data/processed');

const { values: args } = parseArgs({
  options: {
    resort: { type: 'string' },
    lift: { type: 'string' },
    limit: { type: 'string' },
    'failing-only': { type: 'boolean', default: false },
    all: { type: 'boolean', default: false },
    sample: { type: 'string', default: '8' },
    jobs: { type: 'string', default: '1' },
    out: { type: 'string', default: join(SIM_DIR, 'test-results/station-audit') },
    port: { type: 'string', default: process.env.SIM_PORT ?? '5173' },
    headed: { type: 'boolean', default: false },
    reload: { type: 'boolean', default: false },
  },
});

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const resortId = args.resort ?? defaultResort();
const manifest = readJson(join(DATA_DIR, resortId, 'manifest.json'));
const features = readJson(join(DATA_DIR, resortId, manifest.features.file));
const toLatLon = proj4(manifest.projection, 'WGS84');
const ground = loadGround(manifest.terrain.near);
const outDir = resolve(args.out);
mkdirSync(outDir, { recursive: true });

/** DEFAULT_RESORT from src/config.ts, else the first built resort. */
function defaultResort() {
  const config = readFileSync(join(SIM_DIR, 'src/config.ts'), 'utf8');
  const match = config.match(/DEFAULT_RESORT\s*=\s*'([^']+)'/);
  return match?.[1] ?? readJson(join(DATA_DIR, 'resorts.json')).resorts[0].id;
}

/** Bilinear ground height (m) at local east/north from the near heightmap; null outside it. */
function loadGround(meta) {
  const buf = readFileSync(join(DATA_DIR, resortId, meta.file));
  const h = new Uint16Array(buf.buffer, buf.byteOffset, meta.width * meta.height);
  const at = (r, c) => meta.heightOffset + h[r * meta.width + c] * meta.heightScale;
  return (east, north) => {
    const x = (east - meta.extent.west) / meta.cellSize;
    const y = (meta.extent.north - north) / meta.cellSize;
    if (x < 0 || y < 0 || x >= meta.width - 1 || y >= meta.height - 1) return null;
    const c = Math.floor(x);
    const r = Math.floor(y);
    const fx = x - c;
    const fy = y - r;
    const top = at(r, c) * (1 - fx) + at(r, c + 1) * fx;
    const bottom = at(r + 1, c) * (1 - fx) + at(r + 1, c + 1) * fx;
    return top * (1 - fy) + bottom * fy;
  };
}

// --- Camera poses --------------------------------------------------------------------------

/** Minimum camera clearance above the terrain (m). */
const CLEARANCE = 4;

/**
 * Four standard views of a terminal. Offsets are in the terminal frame: `along` metres along
 * `dir` from the bullwheel (into the line), `side` metres along `across`, `up` above the pad.
 * Each view lists candidates in order of preference; the least occluded by buildings wins.
 */
const VIEWS = [
  {
    name: 'front',
    candidates: (t) => [8, -8].map((side) => ({ along: t.length + 45, side, up: 22 })),
  },
  {
    name: 'side',
    candidates: (t) => {
      const side = Math.max(28, t.width / 2 + 18);
      // Further out and then higher up, to see over buildings crowding the station.
      return [
        [side, 9],
        [-side, 9],
        [side * 1.4, 12],
        [-side * 1.4, 12],
        [side * 1.4, 30],
        [-side * 1.4, 30],
      ].map(([s, up]) => ({ along: (t.length - t.back) / 2, side: s, up }));
    },
  },
  {
    name: 'behind',
    candidates: (t) =>
      [18, 30, 45].flatMap((up) => [6, -6].map((side) => ({ along: -t.back - 35, side, up }))),
  },
  {
    name: 'top',
    candidates: (t) => [{ along: (t.length - t.back) / 2, side: 0, up: 65, down: true }],
  },
];

/** Buildings bucketed on a coarse grid for line-of-sight tests. */
const BUCKET = 100;
const buildingGrid = new Map();
for (const b of features.buildings) {
  const top = b.top + (b.roof?.rise ?? 0);
  for (const [e, n] of b.footprint) {
    const key = `${Math.floor(e / BUCKET)},${Math.floor(n / BUCKET)}`;
    const list = buildingGrid.get(key) ?? [];
    if (!list.includes(b)) list.push(b);
    buildingGrid.set(key, list);
    b.auditTop = top;
  }
}

function insidePolygon(poly, e, n) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ei, ni] = poly[i];
    const [ej, nj] = poly[j];
    if (ni > n !== nj > n && e < ((ej - ei) * (n - ni)) / (nj - ni) + ei) inside = !inside;
  }
  return inside;
}

/** Fraction of sight lines from the camera to the hall (centre, corners low and high) that a
 * building blocks. */
function occlusion(t, from, target) {
  const [de, dn] = t.dir;
  const [ae, an] = t.across;
  const corners = [3, 8].flatMap((h) =>
    [-t.back, t.length].flatMap((u) =>
      [-t.width / 2, t.width / 2].map((v) => ({
        east: t.east + de * u + ae * v,
        north: t.north + dn * u + an * v,
        alt: t.pad + h,
      })),
    ),
  );
  const rays = [target, ...corners];
  return rays.filter((to) => blocked(t, from, to)).length / rays.length;
}

/** Does a building stand between `from` and `to`? Samples every metre. */
function blocked(t, from, to) {
  const length = Math.hypot(to.east - from.east, to.north - from.north, to.alt - from.alt);
  const steps = Math.ceil(length);
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const e = from.east + (to.east - from.east) * f;
    const n = from.north + (to.north - from.north) * f;
    // The hall itself is the subject, not an obstruction.
    const de = e - t.east;
    const dn = n - t.north;
    const u = de * t.dir[0] + dn * t.dir[1];
    const v = de * t.across[0] + dn * t.across[1];
    if (u > -t.back - 0.5 && u < t.length + 0.5 && Math.abs(v) < t.width / 2 + 0.5) continue;
    const alt = from.alt + (to.alt - from.alt) * f;
    const nearby = buildingGrid.get(`${Math.floor(e / BUCKET)},${Math.floor(n / BUCKET)}`) ?? [];
    if (nearby.some((b) => alt < b.auditTop && insidePolygon(b.footprint, e, n))) return true;
  }
  return false;
}

function poses(t) {
  const [de, dn] = t.dir;
  const [ae, an] = t.across;
  const centre = (t.length - t.back) / 2;
  // Look at the middle of the hall, a few metres above the pad.
  const target = { east: t.east + de * centre, north: t.north + dn * centre, alt: t.pad + 4 };
  return VIEWS.map((v) => {
    const options = v.candidates(t).map((c) => {
      const east = t.east + de * c.along + ae * c.side;
      const north = t.north + dn * c.along + an * c.side;
      const floor = (ground(east, north) ?? t.pad) + CLEARANCE;
      const camera = { east, north, alt: Math.max(t.pad + c.up, floor) };
      return { c, camera, score: c.down ? 0 : occlusion(t, camera, target) };
    });
    // Keep the preferred candidate unless another is clearly less blocked.
    const best = options.reduce((a, b) => (b.score < a.score - 0.1 ? b : a));
    const { east, north, alt } = best.camera;
    let heading;
    let pitch;
    if (best.c.down) {
      // Straight down with the line running up the image.
      heading = (Math.atan2(de, dn) * 180) / Math.PI;
      pitch = -89.9;
    } else {
      const te = target.east - east;
      const tn = target.north - north;
      heading = (Math.atan2(te, tn) * 180) / Math.PI;
      pitch = (Math.atan2(target.alt - alt, Math.sqrt(te * te + tn * tn)) * 180) / Math.PI;
    }
    heading = (heading + 360) % 360;
    const [lon, lat] = toLatLon.forward([east, north]);
    return {
      view: v.name,
      occlusion: best.score,
      local: { east, north, alt, heading, pitch },
      query:
        `at=${lat.toFixed(7)},${lon.toFixed(7)},${alt.toFixed(1)}` +
        `&heading=${heading.toFixed(1)}&pitch=${pitch.toFixed(1)}`,
    };
  });
}

// --- Terminal list and static checks --------------------------------------------------------

const liftFilter = args.lift ? new RegExp(args.lift, 'i') : null;
const liftName = (lift) => lift.name ?? `${lift.type} #${lift.id}`;
const slug = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();

const terminals = features.lifts.flatMap((lift) =>
  (lift.terminals ?? []).map((t) => ({
    lift,
    terminal: t,
    name: liftName(lift),
    id: `${slug(liftName(lift))}-${lift.id}-${t.end}`,
    problems: staticChecks(lift, t).map((p) => `static: ${p}`),
  })),
);

// --- Browser ---------------------------------------------------------------------------------

const browser = await chromium.launch({
  headless: !args.headed,
  args: ['--enable-gpu', '--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const consoleErrors = new Set();
const pageErrors = new Set();

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.add(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.add(err.message));
  return page;
}

const base = `http://localhost:${args.port}/?resort=${encodeURIComponent(resortId)}`;

/** Loads the sim at a pose and waits until it has settled; returns the page's lift problems. */
async function load(page, query) {
  // Fail fast if startup throws (e.g. a manifest version the sim doesn't support).
  let failed;
  const onError = (msg) => {
    if (msg.type() === 'error') failed ??= msg.text();
  };
  page.on('console', onError);
  try {
    await page.goto(`${base}&${query}`);
    const deadline = Date.now() + 90_000;
    while (!(await page.evaluate(() => (window.__sim?.frames ?? 0) > 30))) {
      if (failed && !(await page.evaluate(() => window.__sim?.frames))) {
        throw new Error(`sim failed to start: ${failed.split('\n')[0]}`);
      }
      if (Date.now() > deadline) throw new Error('sim did not render 30 frames within 90 s');
      await page.waitForTimeout(100);
    }
  } finally {
    page.off('console', onError);
  }
  await page.addStyleTag({ content: HIDE_UI });
  return page.evaluate(() => {
    document.body.classList.add('flying');
    window.__sim.labels?.setVisible('peak', false);
    return window.__sim.lifts?.problems ?? null;
  });
}

const HIDE_UI = '#hud, #map-side, #prompt, #crosshair { visibility: hidden !important; }';
/** Frames to let terrain LOD, shadows and labels catch up after a teleport. */
const SETTLE_FRAMES = 40;

/**
 * Moves the fly camera without reloading (a reload costs ~2.5 s of sim startup). Fly mode
 * copies its position into the camera and sets the camera rotation from an Euler every frame;
 * hooking those two calls on the dev-exposed camera swaps in the pose. The first copy after a
 * teleport overwrites the fly position itself, so terrain LOD and lifts follow. Returns false
 * if the camera didn't end up there (then the caller reloads instead).
 */
async function teleport(page, pose) {
  return page.evaluate(
    async ({ east, north, alt, heading, pitch, settle }) => {
      const sim = window.__sim;
      const cam = sim?.camera;
      if (!cam) return false;
      if (!cam.__audit) {
        const audit = { pos: null, rot: null };
        const copy = cam.position.copy;
        cam.position.copy = function (v) {
          if (audit.pos) {
            v.set(...audit.pos);
            audit.pos = null;
          }
          return copy.call(this, v);
        };
        const setFromEuler = cam.quaternion.setFromEuler;
        cam.quaternion.setFromEuler = function (e, update) {
          if (audit.rot) e.set(audit.rot[0], audit.rot[1], 0, 'YXZ');
          return setFromEuler.call(this, e, update);
        };
        cam.__audit = audit;
      }
      cam.__audit.pos = [east, alt, -north];
      cam.__audit.rot = [(pitch * Math.PI) / 180, (-heading * Math.PI) / 180];
      const until = sim.frames + settle;
      while (sim.frames < until) await new Promise((r) => requestAnimationFrame(r));
      const p = cam.position;
      return Math.abs(p.x - east) < 0.5 && Math.abs(p.y - alt) < 0.5 && Math.abs(p.z + north) < 0.5;
    },
    { ...pose.local, settle: SETTLE_FRAMES },
  );
}

// The first load gives the load-time lift problems (the same on every load).
const firstPage = await newPage();
const t0 = Date.now();
const liftProblems = await load(firstPage, poses(terminals[0].terminal)[0].query);
if (liftProblems === null) {
  console.warn('window.__sim.lifts is missing (not a dev build?); runtime lift checks skipped');
}
console.log(`Loaded ${resortId} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

/**
 * Which end(s) of a lift a runtime message names. Messages look like "<lift>: ..." or
 * "<lift> (top): ..."; loading/unloading points belong to the bottom/top terminal.
 */
function endsMentioned(message, name) {
  if (!message.startsWith(`${name}:`) && !message.startsWith(`${name} (`)) return [];
  if (/\(top\)|unloading/.test(message)) return ['top'];
  if (/\(bottom\)|loading/.test(message)) return ['bottom'];
  return ['bottom', 'top'];
}

function attributeRuntime() {
  const lines = [
    ...(liftProblems ?? []).map((m) => ['lifts', m]),
    ...[...consoleErrors, ...pageErrors].flatMap((e) =>
      e.split('\n').map((m) => ['console', m.trim()]),
    ),
  ];
  for (const entry of terminals) {
    for (const [source, message] of lines) {
      if (source === 'console' && liftProblems?.includes(message)) continue;
      const tag = `${source}: ${message}`;
      if (endsMentioned(message, entry.name).includes(entry.terminal.end)) {
        if (!entry.problems.includes(tag)) entry.problems.push(tag);
      }
    }
  }
}
attributeRuntime();

// --- Selection -------------------------------------------------------------------------------

const matching = terminals.filter((e) => !liftFilter || liftFilter.test(e.name));
const failing = matching.filter((e) => e.problems.length);
const passing = matching.filter((e) => !e.problems.length);
let selected;
if (args['failing-only']) selected = failing;
else if (args.all || liftFilter) selected = [...failing, ...passing];
else {
  // Default: every failing station plus an evenly spaced sample of passing ones.
  const n = Math.min(Number(args.sample), passing.length);
  const sample = Array.from({ length: n }, (_, i) => passing[Math.floor((i * passing.length) / n)]);
  selected = [...failing, ...sample];
}
if (args.limit) selected = selected.slice(0, Number(args.limit));

const jobs = selected.flatMap((entry) =>
  poses(entry.terminal).map((pose) => ({
    entry,
    pose,
    file: `${entry.id}-${pose.view}.jpg`,
  })),
);
console.log(
  `${matching.length} terminals (${failing.length} failing); rendering ${selected.length} ` +
    `× ${VIEWS.length} views = ${jobs.length} shots`,
);

// --- Render ----------------------------------------------------------------------------------

const workers = [firstPage];
for (let i = 1; i < Math.max(1, Number(args.jobs)); i++) workers.push(await newPage());
let next = 0;
let done = 0;
let reloads = 0;
const start = Date.now();

async function work(page) {
  while (next < jobs.length) {
    const job = jobs[next++];
    try {
      if (args.reload || !(await teleport(page, job.pose))) {
        await load(page, job.pose.query);
        reloads++;
      }
      await page.screenshot({ path: join(outDir, job.file), type: 'jpeg', quality: 82 });
    } catch (err) {
      job.error = String(err.message ?? err).split('\n')[0];
    }
    done++;
    const each = (Date.now() - start) / done;
    const eta = ((jobs.length - done) * each) / 1000;
    const status =
      `[${done}/${jobs.length}] ${job.entry.name} (${job.entry.terminal.end}) ${job.pose.view}` +
      ` · ${(each / 1000).toFixed(1)} s/shot · ${eta.toFixed(0)} s left`;
    process.stdout.write(`\r${status.padEnd(80)}`);
  }
}
await Promise.all(workers.map(work));
process.stdout.write('\n');
if (reloads > 0) console.log(`${reloads} shots needed a page reload (teleport didn't take)`);
await browser.close();
// Errors logged during the renders may name more lifts.
attributeRuntime();

// --- Report ----------------------------------------------------------------------------------

const rows = selected
  .map((entry) => ({
    lift: entry.name,
    liftId: entry.lift.id,
    type: entry.lift.type,
    end: entry.terminal.end,
    kind: entry.terminal.kind,
    east: entry.terminal.east,
    north: entry.terminal.north,
    pad: entry.terminal.pad,
    problems: entry.problems,
    views: jobs
      .filter((j) => j.entry === entry)
      .map((j) => ({
        view: j.pose.view,
        file: j.error ? null : j.file,
        url: `${base}&${j.pose.query}`,
        occlusion: Number(j.pose.occlusion.toFixed(2)),
        error: j.error,
      })),
  }))
  .sort((a, b) => Number(b.problems.length > 0) - Number(a.problems.length > 0));

writeFileSync(
  join(outDir, 'report.json'),
  JSON.stringify(
    {
      resort: resortId,
      generatedAt: new Date().toISOString(),
      terminals: matching.length,
      failing: failing.length,
      rendered: rows.length,
      unattributedErrors: [...consoleErrors, ...pageErrors].filter(
        (e) => !terminals.some((t) => e.split('\n').some((m) => endsMentioned(m, t.name).length)),
      ),
      stations: rows,
    },
    null,
    2,
  ),
);

const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );
const html = `<!doctype html>
<meta charset="utf-8">
<title>Station audit · ${esc(manifest.resort?.name ?? resortId)}</title>
<style>
  body { font: 13px system-ui, sans-serif; margin: 16px; background: #111; color: #ddd; }
  h1 { font-size: 18px; }
  .row { display: flex; gap: 8px; padding: 8px 0; border-top: 1px solid #333; }
  .info { width: 260px; flex: none; }
  .info b { font-size: 14px; color: #fff; }
  .fail .info b { color: #f77; }
  ul { margin: 4px 0; padding-left: 16px; color: #f99; }
  figure { margin: 0; }
  figcaption { color: #888; }
  img { width: 300px; height: 169px; object-fit: cover; display: block; background: #222; }
  a { color: #8cf; }
</style>
<h1>Station audit · ${esc(resortId)} · ${rows.length} of ${matching.length} terminals ·
  ${failing.length} failing</h1>
${rows
  .map(
    (r) => `<div class="row${r.problems.length ? ' fail' : ''}">
  <div class="info"><b>${esc(r.lift)}</b> · ${esc(r.end)}<br>
    ${esc(r.type)} · ${esc(r.kind)} · pad ${r.pad.toFixed(0)} m<br>
    E ${r.east.toFixed(0)} N ${r.north.toFixed(0)}
    ${r.problems.length ? `<ul>${r.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
  </div>
  ${r.views
    .map(
      (v) =>
        `<figure>${
          v.file
            ? `<a href="${esc(v.file)}"><img loading="lazy" src="${esc(v.file)}"></a>`
            : `<div>${esc(v.error)}</div>`
        }<figcaption>${esc(v.view)}${v.occlusion > 0 ? ` · ${Math.round(v.occlusion * 100)}% hidden by buildings` : ''} · <a href="${esc(v.url)}">open in sim</a></figcaption></figure>`,
    )
    .join('\n  ')}
</div>`,
  )
  .join('\n')}
`;
writeFileSync(join(outDir, 'index.html'), html);
console.log(`Wrote ${join(outDir, 'index.html')} and report.json`);
