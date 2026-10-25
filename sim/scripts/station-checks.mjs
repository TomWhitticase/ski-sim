// Static checks on generated lift terminals, computed from features.json alone.
// Each check takes (lift, terminal) and returns a list of problem strings (empty = fine).
// Add new checks to CHECKS; station-audit.mjs runs them all.

// Per terminal kind, mirroring pipeline/approach.py (RAIL, MAX_EXIT_ANGLE, MIN_TOWER):
/** Height of the rope above the pad where it leaves the station (m). */
const EXIT_ROPE_HEIGHT = { chair: 2.83, gondola: 4.3, cabin: 7.45, drag: 4.0 };
/** Steepest acceptable rope angle between the station exit and the next support. */
const MAX_EXIT_ANGLE_DEG = { chair: 18, gondola: 18, cabin: 35, drag: 25 };
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
function steepExitRope(lift, t) {
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
  const forcedRise =
    next.s.kind === 'station' ? 0 : Math.max(next.s.ground + MIN_TOWER[t.kind] - rail, 0);
  const forced = (Math.atan2(forcedRise, run) * 180) / Math.PI;
  if (angle <= Math.max(MAX_EXIT_ANGLE_DEG[t.kind], forced) + 0.5) return [];
  return [
    `exit rope ${angle.toFixed(1)}° to the next ${next.s.kind} ` +
      `(${rise.toFixed(1)} m over ${(next.u - t.length).toFixed(1)} m)`,
  ];
}

// --- Buildings round a station (checks that also take the buildings near the terminal) ---

/** The operator's hut stands this far out on the hall's -across side (pipeline HUT_DEPTH). */
const HUT_DEPTH = 3.6;
/** A building piece this close to the hall's walls was cut by it (pipeline CUT_MARGIN 0.1). */
const TOUCHING = 0.5;
/** Cut remnants smaller than this beside a hall read as stray walls (m²). */
const STUB_AREA = 40;
/** A raised storey this much unsupported (share, and m²) hovers. */
const HOVER_SHARE = 0.4;
const HOVER_AREA = 8;

/** A point (east, north) in the terminal's frame, with `across` as the pipeline has it. */
function frame(t, e, n) {
  const de = e - t.east;
  const dn = n - t.north;
  return { u: de * t.dir[0] + dn * t.dir[1], v: de * t.across[0] + dn * t.across[1] };
}

/** The hall's rectangle in the terminal frame (with the operator's hut, as the pipeline). */
function hallRect(t) {
  const w = t.width / 2;
  return { u0: -t.back, u1: t.length, v0: -w - (t.hut ? HUT_DEPTH : 0), v1: w };
}

/** The walkway's rectangle, if there is one (pipeline `_walk_rect`). */
function walkRect(t) {
  const w = t.width / 2;
  const r = t.gauge / 2;
  const at = t.end === 'bottom' ? t.load : t.unload;
  if (t.entrance === 'side') return { u0: at - 3, u1: at + 3, v0: w, v1: w + t.walk };
  if (t.entrance === 'back') return { u0: -t.back - t.walk, u1: -t.back, v0: r + 0.8, v1: r + 4.8 };
  // Down the ski-off ramp: storeys left over it stand on the building either side.
  if (t.entrance === 'ramp' && t.ramp) {
    const h = t.ramp.halfWidth;
    return { u0: -t.back - t.ramp.length, u1: t.unload, v0: r - h, v1: r + h };
  }
  return null;
}

function inRect(r, p, pad = 0) {
  return r && p.u >= r.u0 - pad && p.u <= r.u1 + pad && p.v >= r.v0 - pad && p.v <= r.v1 + pad;
}

function rectDistance(r, p) {
  const du = Math.max(r.u0 - p.u, 0, p.u - r.u1);
  const dv = Math.max(r.v0 - p.v, 0, p.v - r.v1);
  return Math.sqrt(du * du + dv * dv);
}

function inRing(ring, e, n) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ei, ni] = ring[i];
    const [ej, nj] = ring[j];
    if (ni > n !== nj > n && e < ((ej - ei) * (n - ni)) / (nj - ni) + ei) inside = !inside;
  }
  return inside;
}

function ringArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(sum) / 2;
}

/** Points every metre inside a footprint. */
function samples(ring) {
  const es = ring.map((p) => p[0]);
  const ns = ring.map((p) => p[1]);
  const out = [];
  for (let e = Math.floor(Math.min(...es)) + 0.5; e < Math.max(...es); e += 1) {
    for (let n = Math.floor(Math.min(...ns)) + 0.5; n < Math.max(...ns); n += 1) {
      if (inRing(ring, e, n)) out.push([e, n]);
    }
  }
  return out;
}

/** (c) No storey left over a station may hover: under every part of a raised piece is the
 *  hall, the walkway (an arcade) or the building standing at ground level. */
function hoveringStorey(lift, t, buildings, terminals) {
  // Any station's hall or walkway holds storeys up (lifts share station buildings).
  const near = terminals.filter((o) => Math.hypot(o.east - t.east, o.north - t.north) < 150);
  const holds = (e, n) =>
    near.some((o) => {
      const p = frame(o, e, n);
      return inRect(hallRect(o), p, 0.6) || inRect(walkRect(o), p, 0.6);
    });
  const ground = buildings.filter((b) => !b.raised);
  const problems = [];
  for (const b of buildings) {
    if (!b.raised) continue;
    const pts = samples(b.footprint);
    if (!pts.length) continue;
    const loose = pts.filter(
      ([e, n]) => !holds(e, n) && !ground.some((g) => inRing(g.footprint, e, n)),
    ).length;
    if (loose / pts.length > HOVER_SHARE && loose > HOVER_AREA) {
      problems.push(
        `storey hovering beside the station (building ${b.id}, ${loose} m² unsupported)`,
      );
    }
  }
  return problems;
}

/** (d) No small remnant of a cut building may be left against the hall's walls. */
function stubBesideHall(lift, t, buildings) {
  const hall = hallRect(t);
  const problems = [];
  for (const b of buildings) {
    if (b.raised || b.shell || b.use === 'restaurant') continue;
    const area = ringArea(b.footprint);
    if (area >= STUB_AREA) continue;
    const near = b.footprint.some(([e, n]) => rectDistance(hall, frame(t, e, n)) < TOUCHING);
    if (near)
      problems.push(`${area.toFixed(0)} m² remnant of a building against the hall (${b.id})`);
  }
  return problems;
}

export const CHECKS = [towerInsideHall, steepExitRope];
export const BUILDING_CHECKS = [hoveringStorey, stubBesideHall];
/** Buildings this far from a terminal are passed to its building checks (m). */
export const BUILDING_REACH = 60;

/** Every check. `buildings` (optional) are the buildings near the terminal, `terminals`
 *  every terminal of the resort (stations share buildings). */
export function staticChecks(lift, terminal, buildings = null, terminals = [terminal]) {
  return [
    ...CHECKS.flatMap((check) => check(lift, terminal)),
    ...(buildings
      ? BUILDING_CHECKS.flatMap((check) => check(lift, terminal, buildings, terminals))
      : []),
  ];
}
