#!/usr/bin/env node
// Snowboard pose review contact sheet: before/after pairs per situation and angle.
//
//   REVIEW=before|after pnpm exec playwright test e2e/snowboard-review.spec.ts  (each state)
//   node scripts/snowboard-review.mjs [srcDir] [outDir]
//
// srcDir holds before/ and after/ (default test-results/snowboard-review, or where REVIEW_OUT
// pointed); outDir gets index.html plus copies of both sets (default
// test-results/snowboard-review). Run it after any other Playwright run: Playwright clears
// test-results/ when it starts.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const src = resolve(process.argv[2] ?? 'test-results/snowboard-review');
const out = resolve(process.argv[3] ?? 'test-results/snowboard-review');
mkdirSync(out, { recursive: true });
for (const set of ['before', 'after']) {
  if (src !== out && existsSync(join(src, set)))
    cpSync(join(src, set), join(out, set), { recursive: true });
}
// The written findings (an HTML fragment) go at the top of the sheet.
if (src !== out && existsSync(join(src, 'findings.html')))
  cpSync(join(src, 'findings.html'), join(out, 'findings.html'));
const shots = (set) =>
  existsSync(join(out, set)) ? readdirSync(join(out, set)).filter((f) => f.endsWith('.png')) : [];
const before = new Set(shots('before'));
const after = new Set(shots('after'));
const all = [...new Set([...before, ...after])].sort();

// Situations in the order the spec renders them; anything else goes last.
const ORDER = [
  'stand-flat',
  'stand-goofy',
  'push-flat',
  'push-flat-recover',
  'push-goofy',
  'traverse',
  'straight-slow',
  'straight-fast',
  'carve-heel-slow',
  'carve-heel-fast',
  'carve-toe-slow',
  'carve-toe-fast',
  'carve-goofy-toe',
  'skid-heel',
  'skid-toe',
  'hockey-stop',
  'tuck',
  'air',
  'landing',
  'switch',
  'chairlift',
  'drone-pilot',
  'first-person',
  'touch-stand',
];
const ANGLES = ['toe', 'heel', 'nose', 'tail', 'above', 'three-quarter', 'legs', 'stand', 'push'];
const split = (f) => {
  const base = f.replace(/\.png$/, '');
  for (const a of ANGLES) if (base.endsWith(`-${a}`)) return [base.slice(0, -a.length - 1), a];
  return [base, ''];
};
const groups = new Map();
for (const f of all) {
  const [situation, angle] = split(f);
  if (!groups.has(situation)) groups.set(situation, []);
  groups.get(situation).push({ f, angle });
}
const rank = (s) => (ORDER.indexOf(s) === -1 ? 999 : ORDER.indexOf(s));
const situations = [...groups.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

const findings = existsSync(join(out, 'findings.html'))
  ? readFileSync(join(out, 'findings.html'), 'utf8')
  : '';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const img = (set, f, has) =>
  has
    ? `<a href="${set}/${f}"><img loading="lazy" src="${set}/${f}" alt="${set} ${esc(f)}"></a>`
    : `<div class="missing">no ${set} shot</div>`;
const sections = situations
  .map((s) => {
    const rows = groups
      .get(s)
      .sort((a, b) => ANGLES.indexOf(a.angle) - ANGLES.indexOf(b.angle))
      .map(
        ({ f, angle }) => `<div class="pair"><h3>${esc(angle || s)}</h3><div class="imgs">
${img('before', f, before.has(f))}${img('after', f, after.has(f))}</div></div>`,
      )
      .join('\n');
    return `<section id="${esc(s)}"><h2>${esc(s)}</h2>${rows}</section>`;
  })
  .join('\n');

writeFileSync(
  join(out, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>Snowboard pose review</title>
<style>
body{font:14px/1.45 system-ui,sans-serif;margin:24px;background:#f4f5f7;color:#1b1e23}
h1{margin:0 0 4px}h2{margin:28px 0 8px;border-bottom:1px solid #ccd;padding-bottom:4px}
h3{margin:0 0 4px;font-size:12px;color:#556}
nav a{margin-right:10px}
.pair{display:inline-block;vertical-align:top;margin:0 14px 14px 0}
.imgs{display:grid;grid-template-columns:1fr 1fr;gap:4px}
.imgs img,.missing{width:400px;aspect-ratio:16/9;object-fit:cover;object-position:50% 45%;border-radius:4px;display:block;background:#dde}
.missing{display:grid;place-items:center;color:#889}
.legend{color:#556}table{border-collapse:collapse;background:#fff}td,th{border:1px solid #ccd;padding:6px 8px;vertical-align:top;text-align:left}
</style>
<h1>Snowboard pose review</h1>
<p class="legend">Each pair: <b>before</b> (left) and <b>after</b> (right), the same situation driven
in-game and frozen on one frame, from the same camera. Angles are in the board's frame: toe edge,
heel edge, nose, tail, above, three-quarter and a close-up on the legs. Click a shot for full size.</p>
<nav>${situations.map((s) => `<a href="#${esc(s)}">${esc(s)}</a>`).join(' ')}</nav>
${findings}
${sections}
`,
);
console.log(`${situations.length} situations, ${all.length} shots → ${join(out, 'index.html')}`);
