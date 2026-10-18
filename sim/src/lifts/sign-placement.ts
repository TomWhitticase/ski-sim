/**
 * Where a lift's name board goes. Signs stand on the ground beside the station entrance:
 * never on roofs, never inside buildings, never over the cable line. Pure, so it can be
 * unit-tested and checked at runtime (see `checkSign`).
 *
 * Coordinates are world x/z (z = -north); heights are metres above sea level.
 */

export interface SignSite {
  /** Board centre. */
  x: number;
  y: number;
  z: number;
  /** Feet of the two posts (x, z, ground height). */
  posts: [{ x: number; z: number; ground: number }, { x: number; z: number; ground: number }];
}

export interface SignQuery {
  /** Station (cable end) position. */
  station: { x: number; z: number };
  /** Unit horizontal vector the board faces (toward approaching skiers). */
  facing: { x: number; z: number };
  /** Unit horizontal vector across the line. */
  across: { x: number; z: number };
  /** Distance between the up and down cables (m). */
  gauge: number;
  boardWidth: number;
  boardHeight: number;
}

/** Board bottom above the snow (m): readable from skis, below the cable line. */
export const BOARD_CLEARANCE = 2.2;
/** Gap kept between the sign and the cable/carrier corridor (m). */
const LINE_CLEARANCE = 2.5;
/** Most a post may stand proud of, or sink into, the slope at the board site (m). */
export const MAX_POST_GAP = 0.05;
/** Most the ground may differ between the two posts (m); steeper spots are rejected. */
export const MAX_STEP = 2.5;

export function placeSign(
  q: SignQuery,
  groundHeight: (x: number, z: number) => number,
  insideBuilding: (x: number, z: number) => boolean,
): SignSite | null {
  // Try spots around the station entrance on either side of the line, nearest first,
  // with posts at the board ends and then closer together (for tight or steep spots).
  // Take the first whose posts and board are clear of buildings and on even ground.
  for (const halfSpan of [q.boardWidth / 2 - 0.4, 1.2]) {
    for (const ahead of [8, 14, 20, 28, 38, 2, 50]) {
      for (const side of [1, -1]) {
        const lateral = side * (q.gauge / 2 + LINE_CLEARANCE + q.boardWidth / 2);
        const cx = q.station.x + q.facing.x * ahead + q.across.x * lateral;
        const cz = q.station.z + q.facing.z * ahead + q.across.z * lateral;
        const feet = [-1, 1].map((s) => {
          const x = cx + q.across.x * s * halfSpan;
          const z = cz + q.across.z * s * halfSpan;
          return { x, z, ground: groundHeight(x, z) };
        }) as SignSite['posts'];
        if (Math.abs(feet[0].ground - feet[1].ground) > MAX_STEP) continue;
        const blocked = [...feet, { x: cx, z: cz }].some((p) => insideBuilding(p.x, p.z));
        if (blocked) continue;
        // Board bottom clears the snow under both posts.
        const y = Math.max(feet[0].ground, feet[1].ground) + BOARD_CLEARANCE + q.boardHeight / 2;
        return { x: cx, y, z: cz, posts: feet };
      }
    }
  }
  return null;
}

/**
 * Invariants every placed sign must satisfy; returns the problems found (empty = fine).
 * Run on every sign at load: a violation logs an error, which fails the e2e view tests.
 */
export function checkSign(
  site: SignSite,
  boardHeight: number,
  groundHeight: (x: number, z: number) => number,
  insideBuilding: (x: number, z: number) => boolean,
): string[] {
  const problems: string[] = [];
  const bottom = site.y - boardHeight / 2;
  for (const p of site.posts) {
    const g = groundHeight(p.x, p.z);
    if (Math.abs(g - p.ground) > MAX_POST_GAP) problems.push('post not on the ground');
    if (insideBuilding(p.x, p.z)) problems.push('post inside a building');
    const clearance = bottom - g;
    if (clearance < BOARD_CLEARANCE - 0.01)
      problems.push(`board too low (${clearance.toFixed(1)} m)`);
  }
  const lowest = Math.min(...site.posts.map((p) => p.ground));
  // On a slope one post is longer, but the board must never float far above the snow.
  if (bottom - lowest > BOARD_CLEARANCE + MAX_STEP + 0.01) {
    problems.push(`board floating ${(bottom - lowest).toFixed(1)} m above the snow`);
  }
  return problems;
}
