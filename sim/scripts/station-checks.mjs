// Static checks on generated lift terminals, computed from features.json alone.
// Each check takes (lift, terminal) and returns a list of problem strings (empty = fine).
// Add new checks to CHECKS; station-audit.mjs runs them all.

/** Height of the rope above the pad where it leaves the station (m). */
const EXIT_ROPE_HEIGHT = 5;
/** Steepest acceptable rope angle between the station exit and the next support. */
const MAX_EXIT_ANGLE_DEG = 18;
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

/** (b) The rope leaving the station must not climb or drop too steeply to the next support. */
function steepExitRope(lift, t) {
  let next = null;
  for (const s of lift.supports) {
    const { u, v } = terminalCoords(t, s);
    if (u <= t.length || Math.abs(v) > LINE_TOLERANCE) continue;
    if (!next || u < next.u) next = { u, s };
  }
  if (!next) return [];
  const rise = next.s.top - (t.pad + EXIT_ROPE_HEIGHT);
  const angle = (Math.atan2(Math.abs(rise), next.u - t.length) * 180) / Math.PI;
  if (angle <= MAX_EXIT_ANGLE_DEG) return [];
  return [
    `exit rope ${angle.toFixed(1)}° to the next ${next.s.kind} ` +
      `(${rise.toFixed(1)} m over ${(next.u - t.length).toFixed(1)} m)`,
  ];
}

export const CHECKS = [towerInsideHall, steepExitRope];

export function staticChecks(lift, terminal) {
  return CHECKS.flatMap((check) => check(lift, terminal));
}
