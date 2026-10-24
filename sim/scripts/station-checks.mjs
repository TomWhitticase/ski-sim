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

export const CHECKS = [towerInsideHall, steepExitRope];

export function staticChecks(lift, terminal) {
  return CHECKS.flatMap((check) => check(lift, terminal));
}
