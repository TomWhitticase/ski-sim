import type { Vector3 } from 'three/webgpu';

/**
 * Snow park features laid out by the pipeline (pipeline/parks.py) as analytic surfaces in
 * the local ENU frame. The snow you ski on is max(terrain, features); a feature dipping
 * below the snow just vanishes. Line profiles start and end on the hill, tangent to it,
 * and their last `END_DIVE` metres sink under the snow so nothing steps up at the join
 * (except where they're meant to stand clear of it: rails, and the top of a rail's ramp).
 *
 * - Line features (kicker, ramp, box, roller): a profile along `heading` of heights
 *   above `y` at the origin, level across `width`, with sides falling at `side` (tan).
 * - Berms and wall rides: a banked wall outside an arc (centre, radius, compass `start` +
 *   `sweep`), above a plane through `y` with gradient `grad`; it tapers in and out along
 *   the arc.
 * - Halfpipes: a floor following `profile` along `heading` (level across), a flat bottom,
 *   circular transitions steepening to `vert` degrees at the coping, and level decks with
 *   outer walls falling at `side`. The walls grow out of the floor over the first `dropIn`
 *   m and sink back into it over the last `exit` m of `length`.
 */
export interface LineFeature {
  kind: 'kicker' | 'ramp' | 'box' | 'roller';
  east: number;
  north: number;
  y: number;
  /** Compass bearing of travel (deg). */
  heading: number;
  width: number;
  side: number;
  /** [u along heading (m), height above y (m)], u ascending. */
  profile: [number, number][];
}

export interface BermFeature {
  kind: 'berm';
  east: number;
  north: number;
  y: number;
  /** Plane gradient: d(height)/d(east), d(height)/d(north). */
  grad: [number, number];
  radius: number;
  /** Compass bearing (deg) from the centre where the arc starts, and its extent (deg). */
  start: number;
  sweep: number;
  /** Bank width from the riding line to the crest, and the crest height (m). */
  width: number;
  height: number;
  side: number;
}

/** A wall ride: shaped like a berm (a steep bank along a gentle arc), drawn in wood. */
export interface WallFeature extends Omit<BermFeature, 'kind'> {
  kind: 'wall';
}

export interface HalfpipeFeature {
  kind: 'halfpipe';
  /** Where the walls start (u = 0) on the centreline. */
  east: number;
  north: number;
  y: number;
  /** Compass bearing down the pipe (deg). */
  heading: number;
  /** [u along heading (m), floor height above y (m)], u ascending; reaches past the walls. */
  profile: [number, number][];
  /** Length of the walls (m). */
  length: number;
  /** Flat bottom width, transition radius (m), steepest wall angle (deg), wall height (m). */
  flat: number;
  radius: number;
  vert: number;
  height: number;
  /** Deck width (m), and how far the walls take to grow in / sink out (m). */
  deck: number;
  dropIn: number;
  exit: number;
  side: number;
}

export type ParkFeature = LineFeature | BermFeature | WallFeature | HalfpipeFeature;

/** Standing on a rail: its direction (world x, z; unit) and your offset across it (m). */
export interface RailContact {
  dirX: number;
  dirZ: number;
  /** + to the left of `dir`. */
  offset: number;
  /** Rise (m) per horizontal metre along `dir` here: the rail's own slope, level across. */
  grade: number;
}

export interface ParkLayout {
  /** The piste record this park belongs to. */
  index: number;
  style: 'jumps' | 'course';
  synthetic: boolean;
  features: ParkFeature[];
}

const RAD = Math.PI / 180;
/** Line features sink `DIVE` m under the snow over their first and last `END_DIVE` m. */
const END_DIVE = 1.5;
const DIVE = 0.5;
/** Berms start this far under the plane so their ends and inner edge tuck under the snow. */
export const BERM_SINK = 0.25;
const BUCKET = 32;
/** Slack when deciding you're on a rail (its edge, a little below its top) (m). */
const RAIL_MARGIN = 0.05;
/** Normal sampling step: fine on features, the terrain's usual 2 m elsewhere. */
const FINE_STEP = 0.05;
const COARSE_STEP = 2;

export function profileAt(profile: [number, number][], u: number): number {
  let lo = 0;
  let hi = profile.length - 1;
  if (u <= profile[0]![0]) return profile[0]![1];
  if (u >= profile[hi]![0]) return profile[hi]![1];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (profile[mid]![0] <= u) lo = mid;
    else hi = mid;
  }
  const [u0, h0] = profile[lo]!;
  const [u1, h1] = profile[hi]!;
  return h0 + ((h1 - h0) * (u - u0)) / (u1 - u0);
}

/** Slope (dh/du) of a profile at `u`: its segment's, the end segment's beyond the ends. */
export function profileGrade(profile: [number, number][], u: number): number {
  let i = 1;
  while (i < profile.length - 1 && profile[i]![0] < u) i++;
  const [u0, h0] = profile[i - 1]!;
  const [u1, h1] = profile[i]!;
  return u1 > u0 ? (h1 - h0) / (u1 - u0) : 0;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Local (u along, v across to the left) coordinates of a line feature or halfpipe. */
export function lineCoords(
  f: LineFeature | HalfpipeFeature,
  east: number,
  north: number,
): [number, number] {
  const de = east - f.east;
  const dn = north - f.north;
  const s = Math.sin(f.heading * RAD);
  const c = Math.cos(f.heading * RAD);
  return [de * s + dn * c, -de * c + dn * s];
}

/** Absolute height of a line feature's surface at (u, v); -Infinity off its ends. */
export function lineHeight(f: LineFeature, u: number, v: number): number {
  const p = f.profile;
  const end = Math.min(u - p[0]![0], p[p.length - 1]![0] - u);
  if (end < 0) return -Infinity;
  const over = Math.abs(v) - f.width / 2;
  // Rails stand in the air, and their ramp runs straight onto one: neither sinks there.
  const sinks = f.kind === 'ramp' ? u - p[0]![0] : end;
  const dive = f.kind === 'box' ? 0 : DIVE * (1 - smoothstep(0, END_DIVE, sinks));
  return f.y + profileAt(p, u) - (over > 0 ? over * f.side : 0) - dive;
}

/** Berm: arc fraction (0..1, NaN off the arc) and distance out from the riding line. */
export function bermCoords(
  f: BermFeature | WallFeature,
  east: number,
  north: number,
): [number, number] {
  const de = east - f.east;
  const dn = north - f.north;
  const bearing = Math.atan2(de, dn) / RAD;
  let a = (((bearing - f.start) % 360) + 360) % 360;
  if (f.sweep < 0) a = 360 - a;
  const along = a <= Math.abs(f.sweep) ? a / Math.abs(f.sweep) : NaN;
  return [along, Math.sqrt(de * de + dn * dn) - f.radius];
}

/** Absolute berm height at arc fraction `along` and distance `out`; -Infinity off it. */
export function bermHeight(f: BermFeature | WallFeature, east: number, north: number): number {
  const [along, out] = bermCoords(f, east, north);
  if (Number.isNaN(along) || out < -1) return -Infinity;
  const plane = f.y + f.grad[0] * (east - f.east) + f.grad[1] * (north - f.north);
  const taper = smoothstep(0, 0.3, along) * smoothstep(0, 0.3, 1 - along);
  const t = Math.max(0, out) / f.width;
  const lift = t <= 1 ? f.height * t ** 1.8 : f.height - (out - f.width) * f.side;
  return plane - BERM_SINK + Math.max(lift * taper, -2);
}

/** Where a halfpipe's cross-section changes, measured out from its centreline (m). */
export function halfpipeEdges(f: HalfpipeFeature): {
  /** Transition start, transition end (where the vert begins), coping, deck's outer edge. */
  flat: number;
  arc: number;
  coping: number;
  deck: number;
  /** Height where the vert begins. */
  arcTop: number;
} {
  const a = f.vert * RAD;
  const flat = f.flat / 2;
  const arc = flat + f.radius * Math.sin(a);
  const arcTop = f.radius * (1 - Math.cos(a));
  const coping = arc + Math.max(0, f.height - arcTop) / Math.tan(a);
  return { flat, arc, coping, deck: coping + f.deck, arcTop };
}

/** Height of a halfpipe's full-size cross-section above its floor, `s` m from the centre. */
export function halfpipeSection(f: HalfpipeFeature, s: number): number {
  const e = halfpipeEdges(f);
  if (s <= e.flat) return 0;
  if (s <= e.arc) {
    const x = s - e.flat;
    return f.radius - Math.sqrt(f.radius * f.radius - x * x);
  }
  if (s <= e.coping) return Math.min(f.height, e.arcTop + (s - e.arc) * Math.tan(f.vert * RAD));
  if (s <= e.deck) return f.height;
  return f.height - (s - e.deck) * f.side;
}

/** How much of the walls stand at u: rising over the drop-in, sinking over the exit. */
export function halfpipeGrowth(f: HalfpipeFeature, u: number): number {
  return smoothstep(0, f.dropIn, u) * smoothstep(0, f.exit, f.length - u);
}

/** Absolute height of a halfpipe at (u along, v across); -Infinity off its ends. */
export function halfpipeHeight(f: HalfpipeFeature, u: number, v: number): number {
  const p = f.profile;
  const end = Math.min(u - p[0]![0], p[p.length - 1]![0] - u);
  if (end < 0) return -Infinity;
  const floor = f.y + profileAt(p, u) - DIVE * (1 - smoothstep(0, END_DIVE, end));
  const s = Math.abs(v);
  const grow = halfpipeGrowth(f, u);
  const deck = halfpipeEdges(f).deck;
  // Outside the decks the walls fall at `side` whatever their height, so the pipe's
  // ends are banks, not cliffs.
  if (s > deck) return floor + grow * f.height - (s - deck) * f.side;
  return floor + grow * halfpipeSection(f, s);
}

export function featureHeight(f: ParkFeature, east: number, north: number): number {
  if (f.kind === 'berm' || f.kind === 'wall') return bermHeight(f, east, north);
  const [u, v] = lineCoords(f, east, north);
  return f.kind === 'halfpipe' ? halfpipeHeight(f, u, v) : lineHeight(f, u, v);
}

/** Ground-plane bounding box of a feature (with its sides). */
export function featureBounds(f: ParkFeature): [number, number, number, number] {
  if (f.kind === 'berm' || f.kind === 'wall') {
    const r = f.radius + f.width + f.height / f.side + 1;
    return [f.east - r, f.north - r, f.east + r, f.north + r];
  }
  const p = f.profile;
  const top = Math.max(...p.map(([, h]) => Math.abs(h)));
  const half =
    f.kind === 'halfpipe'
      ? halfpipeEdges(f).deck + (f.height + top) / f.side + 1
      : f.width / 2 + top / f.side + 1;
  const s = Math.sin(f.heading * RAD);
  const c = Math.cos(f.heading * RAD);
  const corners = [p[0]![0], p[p.length - 1]![0]].flatMap((u) =>
    [-half, half].map((v) => [f.east + u * s - v * c, f.north + u * c + v * s]),
  );
  const es = corners.map((q) => q[0]!);
  const ns = corners.map((q) => q[1]!);
  return [Math.min(...es), Math.min(...ns), Math.max(...es), Math.max(...ns)];
}

/** All parks' features, bucketed for quick height queries. */
export class SnowParks {
  readonly features: ParkFeature[];
  private readonly buckets = new Map<string, ParkFeature[]>();

  constructor(layouts: ParkLayout[]) {
    this.features = layouts.flatMap((p) => p.features);
    for (const f of this.features) {
      const [w, s, e, n] = featureBounds(f);
      for (let i = Math.floor(w / BUCKET); i <= Math.floor(e / BUCKET); i++) {
        for (let j = Math.floor(s / BUCKET); j <= Math.floor(n / BUCKET); j++) {
          const key = `${i},${j}`;
          const list = this.buckets.get(key);
          if (list) list.push(f);
          else this.buckets.set(key, [f]);
        }
      }
    }
  }

  private near(east: number, north: number): ParkFeature[] | undefined {
    return this.buckets.get(`${Math.floor(east / BUCKET)},${Math.floor(north / BUCKET)}`);
  }

  /** Highest feature surface at (east, north); -Infinity if none. */
  featureAt(east: number, north: number): number {
    const list = this.near(east, north);
    if (!list) return -Infinity;
    let best = -Infinity;
    for (const f of list) best = Math.max(best, featureHeight(f, east, north));
    return best;
  }

  /**
   * The rail you're standing on at world (x, z), if a rail is the top surface there:
   * its horizontal direction in world axes and your offset from its centreline (m, + to
   * the left of the direction of travel). Reuses `out`.
   */
  rail(x: number, z: number, ground: number, out: RailContact): RailContact | null {
    const list = this.near(x, -z);
    if (!list) return null;
    const top = this.height(x, z, ground);
    for (const f of list) {
      if (f.kind !== 'box') continue;
      const [u, v] = lineCoords(f, x, -z);
      if (Math.abs(v) > f.width / 2 + RAIL_MARGIN) continue;
      if (lineHeight(f, u, v) < top - RAIL_MARGIN) continue;
      const s = Math.sin(f.heading * RAD);
      const c = Math.cos(f.heading * RAD);
      out.dirX = s;
      out.dirZ = -c;
      out.offset = v;
      out.grade = profileGrade(f.profile, u);
      return out;
    }
    return null;
  }

  /** Snow height at world (x, z) given the terrain height there. */
  height(x: number, z: number, ground: number): number {
    const top = this.featureAt(x, -z);
    return Math.max(ground, top);
  }

  /**
   * Upward unit normal of the snow surface at world (x, z): finely sampled on features
   * (a kicker's transition is only a few metres long), as coarsely as before elsewhere.
   */
  normal(x: number, z: number, ground: (x: number, z: number) => number, out: Vector3): Vector3 {
    const h = this.near(x, -z) ? FINE_STEP : COARSE_STEP;
    const s = (px: number, pz: number) => this.height(px, pz, ground(px, pz));
    return out.set(s(x - h, z) - s(x + h, z), 2 * h, s(x, z - h) - s(x, z + h)).normalize();
  }
}
