import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';
import proj4 from 'proj4';

// Carriers never pass through the ground: Cime Caron's cable car arrives up a rock step
// into its top station at 3,167 m, so the pipeline notches the rock under the arrival
// (`carrier_clearance.py`). Freezes the lift clock with the cabin just outside the hall
// and renders it from the side, from behind and from below, to
// test-results/carrier-clearance/.

const RESORT = 'les-3-vallees';
const LIFT = 'Cime Caron';
const DATA = fileURLToPath(new URL(`../../data/processed/${RESORT}`, import.meta.url));

interface Terminal {
  end: string;
  east: number;
  north: number;
  dir: [number, number];
  across: [number, number];
  length: number;
  pad: number;
}

const manifest = JSON.parse(readFileSync(join(DATA, 'manifest.json'), 'utf8'));
const features = JSON.parse(readFileSync(join(DATA, manifest.features.file), 'utf8'));
const lift = features.lifts.find((l: { name: string }) => l.name === LIFT);
const top: Terminal = lift.terminals.find((t: Terminal) => t.end === 'top');
const toLatLon = proj4(manifest.projection, 'WGS84');

/** A point `along` m out from the top bullwheel down the line, `side` m across, `up` m up. */
function at(along: number, side: number, up: number) {
  return {
    east: top.east + top.dir[0] * along + top.across[0] * side,
    north: top.north + top.dir[1] * along + top.across[1] * side,
    alt: top.pad + up,
  };
}

/** `?at=` query for a camera at `from` looking at `to`. */
function pose(from: ReturnType<typeof at>, to: ReturnType<typeof at>): string {
  const de = to.east - from.east;
  const dn = to.north - from.north;
  const heading = ((Math.atan2(de, dn) * 180) / Math.PI + 360) % 360;
  const pitch = (Math.atan2(to.alt - from.alt, Math.hypot(de, dn)) * 180) / Math.PI;
  const [lon, lat] = toLatLon.forward([from.east, from.north]);
  return (
    `resort=${RESORT}&at=${lat.toFixed(7)},${lon.toFixed(7)},${from.alt.toFixed(1)}` +
    `&heading=${heading.toFixed(1)}&pitch=${pitch.toFixed(1)}`
  );
}

// The cabin's grip this far outside the hall's exit: the steepest bit of the arrival.
const OUT = 10;
const cabin = at(top.length + OUT, 0, -6);
const VIEWS = [
  { name: 'caron-arrival-side', query: pose(at(top.length + OUT, 70, 0), cabin) },
  { name: 'caron-arrival-behind', query: pose(at(top.length + 90, 14, -25), cabin) },
  { name: 'caron-arrival-below', query: pose(at(top.length + 32, -12, -22), cabin) },
];

for (const view of VIEWS) {
  test(view.name, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    // No name tags in front of the cabin.
    await page.addInitScript(() =>
      localStorage.setItem(
        'ski-sim.labels',
        JSON.stringify({ lift: false, peak: false, restaurant: false, pistes: false }),
      ),
    );
    await page.goto(`/?${view.query}`);
    await page.waitForFunction(() => (window.__sim?.frames ?? 0) > 30, null, { timeout: 90_000 });
    await page.evaluate(() => document.body.classList.add('flying'));
    // Stop the lift with a cabin `OUT` m outside the top station, coming in.
    const out = await page.evaluate(
      ({ name, t, out }) => {
        interface V {
          x: number;
          z: number;
          clone(): V;
          addScaledVector(v: V, s: number): V;
        }
        const sim = window.__sim as unknown as {
          camera: { position: V };
          lifts: {
            time: number;
            rate: number;
            lines: { lift: { name: string }; pose(ci: number, t: number, p: V, d: V): void }[];
          };
        };
        const lifts = sim.lifts;
        const line = lifts.lines.find((l) => l.lift.name === name)!;
        const pos = sim.camera.position.clone();
        const dir = sim.camera.position.clone();
        const u = (p: V) => (p.x - t.east) * t.dir[0] + (-p.z - t.north) * t.dir[1];
        let best = { time: 0, miss: Infinity };
        for (let time = 0; time < 2000; time += 0.1) {
          for (const ci of [0, 1]) {
            line.pose(ci, time, pos, dir);
            const ahead = pos.clone().addScaledVector(dir, 0.5);
            if (u(ahead) >= u(pos)) continue; // leaving, not arriving
            const miss = Math.abs(u(pos) - (t.length + out));
            if (miss < best.miss) best = { time, miss };
          }
        }
        lifts.time = best.time;
        lifts.rate = 0;
        return best.miss;
      },
      { name: LIFT, t: top, out: OUT },
    );
    expect(out).toBeLessThan(1);
    await page.evaluate(async () => {
      const sim = window.__sim!;
      const until = sim.frames + 40;
      while (sim.frames < until) await new Promise((r) => requestAnimationFrame(r));
    });
    await page.screenshot({ path: `test-results/carrier-clearance/${view.name}.png` });
    expect(errors).toEqual([]);
  });
}
