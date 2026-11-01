// Static checks on generated lift terminals, computed from features.json and the near
// terrain. Each check takes (lift, terminal, context) and returns a list of problem strings
// (empty = fine); `context.ground(east, north)` is the near terrain's height (null outside).
// Add new checks to CHECKS; station-audit.mjs runs them all.

// Per terminal kind, mirroring pipeline/approach.py (RAIL, MAX_EXIT_ANGLE, MIN_TOWER):
/** Height of the rope above the pad where it leaves the station (m). */
const EXIT_ROPE_HEIGHT = { chair: 2.83, gondola: 4.3, cabin: 7.45, drag: 4.0 };
/** Steepest acceptable rope angle between the station exit and the next support. */
const MAX_EXIT_ANGLE_DEG = { chair: 18, gondola: 18, cabin: 35, drag: 25 };
/** ...or for a first tower flagged `steepExit` (CLIFF_EXIT_ANGLE). */
const CLIFF_EXIT_ANGLE_DEG = { cabin: 50 };
/** Shortest buildable tower (top above ground, m). */
const MIN_TOWER = { chair: 4, gondola: 5, cabin: 8, drag: 3 };
/** How far off the line axis a support can be and still count as "on this line" (m). */
const LINE_TOLERANCE = 20;

/** Support position in the terminal's frame: u along `dir` from the bullwheel, v across. */
function terminalCoords(t, s) {
  const de = s.east - t.east;
  const dn = s.north - t.north;
  const [ue, un] = t.dir;
  return { u: de * ue + dn * un, v: -de * un + dn * ue };
}

/** (a) No tower may stand inside the station hall. */
function towerInsideHall(lift, t) {
  const problems = [];
  for (const s of lift.supports) {
    if (s.kind !== 'tower' && s.kind !== 'synthetic-tower') continue;
    const { u, v } = terminalCoords(t, s);
    if (u >= -t.back && u <= t.length && Math.abs(v) <= t.width / 2) {
      problems.push(`${s.kind} inside the hall (u ${u.toFixed(1)} m, v ${v.toFixed(1)} m)`);
    }
  }
  return problems;
}

/**
 * (b) The rope leaving the station must not climb or drop too steeply to the next support.
 * Where the ground outside climbs steeper than the limit, a minimum-height tower is the
 * gentlest rope possible (a chair up a 35° slope follows it): that's not a fault.
 */
function steepExitRope(lift, t, context) {
  let next = null;
  for (const s of lift.supports) {
    const { u, v } = terminalCoords(t, s);
    if (u <= t.length || Math.abs(v) > LINE_TOLERANCE) continue;
    if (!next || u < next.u) next = { u, s };
  }
  if (!next) return [];
  const rail = t.pad + EXIT_ROPE_HEIGHT[t.kind];
  const run = next.u - t.length;
  const rise = next.s.top - rail;
  const angle = (Math.atan2(Math.abs(rise), run) * 180) / Math.PI;
  // ...nor so low its carriers touch the ground passing it (pipeline `_carrier_floor`).
  const lowest = Math.max(
    next.s.ground + MIN_TOWER[t.kind],
    carrierFloor(lift, t, next.s, context),
  );
  const forcedRise = next.s.kind === 'station' ? 0 : Math.max(lowest - rail, 0);
  const forced = (Math.atan2(forcedRise, run) * 180) / Math.PI;
  // Cable cars may leave a cliff-edge station more steeply, for the cabin's clearance.
  const limit = next.s.steepExit ? CLIFF_EXIT_ANGLE_DEG[t.kind] : MAX_EXIT_ANGLE_DEG[t.kind];
  if (angle <= Math.max(limit, forced) + 0.5) return [];
  return [
    `exit rope ${angle.toFixed(1)}° to the next ${next.s.kind} ` +
      `(${rise.toFixed(1)} m over ${(next.u - t.length).toFixed(1)} m)`,
  ];
}

// --- Carriers clear the ground ---------------------------------------------------------------
// Mirrors pipeline/carrier_clearance.py: the carrier's underside, as the sim draws it
// (`src/lifts/carriers.ts`: `cabinLayout`, a chair with its rider's skis; hang depths from
// `operation.ts`), along the sagging rope (`rope.ts`), against the ground under its whole
// footprint, on both tracks. `carrier-envelope.test.ts` keeps it in step with the sim.

/** Clearance out on the line (m), tapering to none over PLATFORM_RUN outside a hall. */
export const CARRIER_MARGIN = { chair: 0.5, gondola: 1.0, cabin: 1.0 };
const PLATFORM_RUN = 15;
/** Ground this close in front of a hall's exit is the platform's edge, not checked (m). */
const MOUTH = 3;
const TOLERANCE = 0.25;
const STEP = 2;
const KIND = {
  chair_lift: 'chair',
  gondola: 'gondola',
  mixed_lift: 'gondola',
  cable_car: 'cabin',
};

/** The carrier's envelope: underside below the rope, half length, half width (m). */
export function carrierEnvelope(lift) {
  const kind = KIND[lift.type];
  const occupancy = lift.occupancy;
  if (kind === 'chair') {
    const seats = Math.max(1, Math.round(occupancy || 4));
    return { kind, depth: 2.4 + 0.45, halfLength: 1.0, halfWidth: 0.25 * seats + 0.1 };
  }
  if (kind === 'gondola') {
    const s = Math.cbrt(Math.max(Math.round(occupancy || 8), 4) / 8);
    const h = 2 * Math.min(s, 1.15);
    return {
      kind,
      depth: 3.2 + h / 2 + 0.08,
      halfLength: (1.9 * s) / 2,
      halfWidth: (1.75 * s) / 2,
    };
  }
  if (kind === 'cabin') {
    const s = Math.cbrt(Math.max(Math.round(occupancy || 4), 40) / 120);
    return { kind, depth: 6 + 1.45 + 0.08, halfLength: (6.5 * s) / 2, halfWidth: (3.6 * s) / 2 };
  }
  return null;
}

/** Lowest top for tower `s` whose carriers clear the ground under them passing it. */
function carrierFloor(lift, t, s, context) {
  const c = carrierEnvelope(lift);
  if (!c || !context?.ground) return -Infinity;
  const r = lift.gauge / 2;
  let top = -Infinity;
  for (const f of [-c.halfLength, 0, c.halfLength]) {
    for (const o of [-r - c.halfWidth, -r, -r + c.halfWidth, r - c.halfWidth, r, r + c.halfWidth]) {
      const g = context.ground(
        s.east + t.dir[0] * f + t.across[0] * o,
        s.north + t.dir[1] * f + t.across[1] * o,
      );
      if (g !== null) top = Math.max(top, g + c.depth + CARRIER_MARGIN[c.kind]);
    }
  }
  return top;
}

const plan = (a, b) => Math.sqrt((b.east - a.east) ** 2 + (b.north - a.north) ** 2);

/** Rope height `d` m (plan) from support a toward b: level to a hall's exit, then sagging. */
export function ropeAlong(a, b, d, catenary) {
  const total = plan(a, b);
  let start = 0;
  let end = total;
  let pa = a;
  let pb = b;
  if (a.exit) {
    pa = { east: a.exit[0], north: a.exit[1] };
    start = Math.min(plan(a, pa), total);
  }
  if (b.exit) {
    pb = { east: b.exit[0], north: b.exit[1] };
    end = Math.max(total - plan(b, pb), start);
  }
  if (end - start < 1e-6) return d <= start ? a.top : b.top;
  const u = Math.min(Math.max((d - start) / (end - start), 0), 1);
  const length = plan(pa, pb);
  const sag = catenary ? ((length * length) / (2 * catenary)) * u * (1 - u) : 0;
  return a.top + (b.top - a.top) * u - sag;
}

/** Is (e, n) in terminal t's hall (or `mouth` m in front of it), how far outside its exit? */
function hallFrame(t, e, n, mouth = 0) {
  const de = e - t.east;
  const dn = n - t.north;
  const u = de * t.dir[0] + dn * t.dir[1];
  const v = de * t.across[0] + dn * t.across[1];
  const inside = u >= -t.back && u <= t.length + mouth && Math.abs(v) <= t.width / 2 + 1;
  const outside =
    Math.abs(v) <= t.width / 2 + 15 && u >= -t.back ? Math.max(u - t.length, 0) : Infinity;
  return { inside, outside };
}

/**
 * Every carrier position along the line (every STEP m, both tracks): how far its underside
 * is into the ground (positive) or short of its margin, and which terminal it's nearer.
 */
export function carrierShortfalls(lift, ground) {
  const c = carrierEnvelope(lift);
  const terms = lift.terminals ?? [];
  const s = lift.supports;
  if (!c || terms.length !== 2 || s.length < 2) return [];
  let ax = s.at(-1).east - s[0].east;
  let ay = s.at(-1).north - s[0].north;
  const len = Math.sqrt(ax * ax + ay * ay) || 1;
  [ax, ay] = [ay / len, -ax / len]; // across, as the sim
  const r = lift.gauge / 2;
  const total = s.slice(1).reduce((sum, b, i) => sum + plan(s[i], b), 0);
  const out = [];
  let along = 0;
  for (let i = 0; i + 1 < s.length; i++) {
    const a = s[i];
    const b = s[i + 1];
    const span = plan(a, b);
    if (span < 1e-3) continue;
    const ue = (b.east - a.east) / span;
    const un = (b.north - a.north) / span;
    for (let d = 0; d <= span + 1e-6; d = d < span && d + STEP > span ? span : d + STEP) {
      const bottom = ropeAlong(a, b, d, lift.catenary) - c.depth;
      for (const side of [-1, 1]) {
        const ge = a.east + ue * d + ax * side * r;
        const gn = a.north + un * d + ay * side * r;
        const frames = terms.map((t) => hallFrame(t, ge, gn));
        if (frames.some((f) => f.inside)) continue; // in the station
        const outside = Math.min(...frames.map((f) => f.outside));
        const margin = CARRIER_MARGIN[c.kind] * Math.min(Math.max(outside / PLATFORM_RUN, 0), 1);
        let worst = -Infinity;
        for (const fa of [-c.halfLength, 0, c.halfLength]) {
          for (const fw of [-c.halfWidth, 0, c.halfWidth]) {
            const pe = ge + ue * fa + ax * fw;
            const pn = gn + un * fa + ay * fw;
            if (terms.some((t) => hallFrame(t, pe, pn, MOUTH).inside)) continue;
            const g = ground(pe, pn);
            if (g !== null) worst = Math.max(worst, g + margin - bottom);
          }
        }
        out.push({
          along: along + d,
          side,
          shortfall: worst,
          outside,
          end: along + d < total / 2 ? 'bottom' : 'top',
        });
      }
      if (d >= span) break;
    }
    along += span;
  }
  return out;
}

/**
 * (c) Carriers (a chair's skis, a cabin's floor) must stay above the ground all along the
 * line, coming down to the platform only at the hall. Each terminal reports its half of
 * the line, as stretches.
 */
function carrierInGround(lift, t, context) {
  if (!context?.ground) return [];
  const bad = carrierShortfalls(lift, context.ground).filter(
    (p) => p.end === t.end && p.shortfall > TOLERANCE,
  );
  bad.sort((p, q) => p.along - q.along);
  const stretches = [];
  for (const p of bad) {
    const last = stretches.at(-1);
    if (last && p.along - last.to <= 3 * STEP) {
      last.to = p.along;
      if (p.shortfall > last.worst.shortfall) last.worst = p;
    } else stretches.push({ from: p.along, to: p.along, worst: p });
  }
  return stretches.map(({ from, to, worst }) => {
    const where = Number.isFinite(worst.outside)
      ? `${worst.outside.toFixed(0)} m outside the hall`
      : 'out on the line';
    return (
      `carrier ${worst.shortfall.toFixed(1)} m into the ground (or its margin) ${where} ` +
      `(${from.toFixed(0)}–${to.toFixed(0)} m along)`
    );
  });
}

export const CHECKS = [towerInsideHall, steepExitRope, carrierInGround];

export function staticChecks(lift, terminal, context = {}) {
  return CHECKS.flatMap((check) => check(lift, terminal, context));
}
