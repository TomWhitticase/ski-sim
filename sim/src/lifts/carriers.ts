import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  BoxGeometry,
  BufferAttribute,
  type BufferGeometry,
  CylinderGeometry,
  PlaneGeometry,
  Euler,
  Matrix4,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three/webgpu';

type RGB = [number, number, number];

const STEEL: RGB = [0.55, 0.58, 0.62];
const DARK: RGB = [0.12, 0.13, 0.15];
const SEAT: RGB = [0.08, 0.2, 0.42];
const BAR: RGB = [0.75, 0.77, 0.8];
const GONDOLA: RGB = [0.78, 0.12, 0.12];
const CABIN: RGB = [0.92, 0.93, 0.95];
const STRIPE: RGB = [0.05, 0.4, 0.55];
const GLASS: RGB = [0.1, 0.16, 0.22];
const PLATTER: RGB = [0.95, 0.75, 0.1];

/** A part: geometry moved into place and painted one colour. */
function part(
  geometry: BufferGeometry,
  colour: RGB,
  at: [number, number, number],
  rotation: [number, number, number] = [0, 0, 0],
): BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  g.deleteAttribute('uv');
  g.applyMatrix4(
    new Matrix4().compose(
      new Vector3(...at),
      new Quaternion().setFromEuler(new Euler(...rotation)),
      new Vector3(1, 1, 1),
    ),
  );
  const colours = new Float32Array(g.getAttribute('position').count * 3);
  for (let i = 0; i < colours.length; i += 3) colours.set(colour, i);
  g.setAttribute('color', new BufferAttribute(colours, 3));
  return g;
}

function merge(parts: BufferGeometry[]): BufferGeometry {
  const g = mergeGeometries(parts)!;
  g.computeBoundingSphere();
  return g;
}

/**
 * Carrier geometries. Origin = the grip on the cable; -z = direction of travel;
 * everything hangs below (negative y).
 */

/**
 * A round bar from `a` to `b`. `joint` adds a ball at `b`, so a bend into the next bar
 * closes with no gap or notch (frames are drawn as chains of bars).
 */
function bar(
  a: [number, number, number],
  b: [number, number, number],
  r: number,
  colour: RGB,
  joint = false,
): BufferGeometry[] {
  const from = new Vector3(...a);
  const to = new Vector3(...b);
  const span = to.clone().sub(from);
  const g = new CylinderGeometry(r, r, span.length(), 6, 1, true).toNonIndexed();
  g.applyMatrix4(
    new Matrix4().compose(
      from.clone().lerp(to, 0.5),
      new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), span.normalize()),
      new Vector3(1, 1, 1),
    ),
  );
  const out = [part(g, colour, [0, 0, 0])];
  if (joint) out.push(part(new SphereGeometry(r, 6, 4), colour, b));
  return out;
}

/**
 * Height of the safety bar and footrest above / below the seat (lowered, riding). The
 * footrest stays well clear of the platform (the seat is `CHAIR_SEAT_HEIGHT` above it)
 * and of snow that rises at a station's edge.
 */
const BAR_UP = 0.62;
const FOOTREST_DOWN = 0.2;

/**
 * Detachable chair for `seats` people, seat `hang` m below the cable: the grip, a hanger
 * down behind the back, a tubular frame (back, seat rails, armrests) drawn as joined
 * bars, a padded cushion and backrest per seat, and the safety bar lowered with its
 * footrest. Seat top 5 cm above `-hang`; -z is the direction of travel.
 */
export function chairGeometry(seats: number, hang: number): BufferGeometry {
  const W = seats * 0.5; // seating width
  const x1 = W / 2 + 0.05; // frame sides
  const y = -hang; // cushion centre
  const top = y + 1.05; // back frame's top bar
  const zBack = 0.42; // back frame at the top; it leans 10 cm forward to the seat
  const zSeatBack = 0.32;
  const zFront = -0.28;
  const backZ = (yy: number) => zSeatBack + ((zBack - zSeatBack) * (yy - y)) / (top - y);
  const parts: BufferGeometry[] = [
    // Grip and its jaw on the rope, then the hanger: back, then straight down.
    part(new RoundedBoxGeometry(0.24, 0.3, 0.52, 1, 0.05), DARK, [0, -0.12, 0]),
    ...bar([0, -0.25, 0], [0, -0.55, zBack], 0.05, STEEL, true),
    ...bar([0, -0.55, zBack], [0, top, zBack], 0.05, STEEL, true),
    // Back frame: top bar across, then each side down the back and forward under the seat.
    ...bar([-x1, top, zBack], [x1, top, zBack], 0.04, STEEL),
    part(new SphereGeometry(0.04, 6, 4), STEEL, [-x1, top, zBack]),
    part(new SphereGeometry(0.04, 6, 4), STEEL, [x1, top, zBack]),
  ];
  for (const x of [-x1, x1]) {
    parts.push(
      ...bar([x, top, zBack], [x, y - 0.06, zSeatBack], 0.035, STEEL, true),
      ...bar([x, y - 0.06, zSeatBack], [x, y - 0.06, zFront], 0.035, STEEL, true),
      // Armrest from the back post forward, curling down to the seat rail.
      ...bar([x, y + 0.3, backZ(y + 0.3)], [x, y + 0.3, -0.12], 0.03, BAR, true),
      ...bar([x, y + 0.3, -0.12], [x, y - 0.06, -0.2], 0.03, BAR),
    );
  }
  // Cross members under the seat (front edge and middle).
  parts.push(
    ...bar([-x1, y - 0.06, zFront], [x1, y - 0.06, zFront], 0.03, STEEL),
    ...bar([-x1, y - 0.06, 0.02], [x1, y - 0.06, 0.02], 0.03, STEEL),
  );
  // One bench: a seat pan and a back panel the full width, on the frame, with a padded
  // cushion per seat on them (stitched apart by shallow grooves, not gaps).
  parts.push(
    part(new RoundedBoxGeometry(W + 0.04, 0.05, 0.54, 1, 0.02), DARK, [0, y - 0.05, -0.02]),
    part(
      new RoundedBoxGeometry(W + 0.04, 0.6, 0.04, 1, 0.015),
      DARK,
      [0, y + 0.38, 0.4],
      [-0.1, 0, 0],
    ),
  );
  for (let i = 0; i < seats; i++) {
    const x = -W / 2 + 0.25 + i * 0.5;
    parts.push(part(new RoundedBoxGeometry(0.49, 0.09, 0.52, 1, 0.03), SEAT, [x, y, -0.02]));
    parts.push(
      part(
        new RoundedBoxGeometry(0.49, 0.56, 0.07, 1, 0.025),
        SEAT,
        [x, y + 0.38, 0.355],
        [-0.1, 0, 0],
      ),
    );
  }
  // Safety bar, lowered: arms from hinges on the top bar's ends forward to a front bar,
  // with the footrest hanging from it.
  const front: [number, number] = [y + BAR_UP, -0.44];
  for (const x of [-x1, x1]) {
    parts.push(...bar([x, top, zBack], [x, front[0], front[1]], 0.028, BAR, true));
  }
  parts.push(...bar([-x1, front[0], front[1]], [x1, front[0], front[1]], 0.028, BAR));
  const foot = W * 0.32;
  for (const x of [-foot, foot]) {
    parts.push(...bar([x, front[0], front[1]], [x, y - FOOTREST_DOWN, -0.58], 0.025, BAR, true));
  }
  parts.push(
    ...bar(
      [-foot - 0.06, y - FOOTREST_DOWN, -0.58],
      [foot + 0.06, y - FOOTREST_DOWN, -0.58],
      0.03,
      BAR,
    ),
  );
  return merge(parts);
}

/**
 * The same chair for distant views (beyond `CHAIR_DETAIL_RANGE`): its outline in a few
 * boxes, ~10% of the detailed chair's triangles.
 */
export function chairFarGeometry(seats: number, hang: number): BufferGeometry {
  const W = seats * 0.5;
  const x1 = W / 2 + 0.05;
  const y = -hang;
  const top = y + 1.05;
  const parts = [
    part(new BoxGeometry(0.24, 0.3, 0.52), DARK, [0, -0.12, 0]),
    part(new BoxGeometry(0.08, top + 0.25, 0.08), STEEL, [0, (top - 0.25) / 2, 0.42]),
    part(new BoxGeometry(2 * x1, 0.08, 0.08), STEEL, [0, top, 0.42]),
    part(new BoxGeometry(W, 0.1, 0.52), SEAT, [0, y, -0.02]),
    part(new BoxGeometry(W, 0.56, 0.08), SEAT, [0, y + 0.38, 0.36], [-0.1, 0, 0]),
    part(new BoxGeometry(2 * x1, 0.05, 0.05), BAR, [0, y + BAR_UP, -0.44]),
    part(new BoxGeometry(W * 0.7, 0.05, 0.05), BAR, [0, y - FOOTREST_DOWN, -0.58]),
  ];
  for (const x of [-x1, x1]) {
    parts.push(part(new BoxGeometry(0.06, 1.1, 0.06), STEEL, [x, y + 0.5, 0.37]));
  }
  return merge(parts);
}

/** Chairs nearer the camera than this are drawn in full detail (m). */
export const CHAIR_DETAIL_RANGE = 250;

/**
 * An enclosed cabin (gondola or cable car), in grip coordinates: `x` across the line
 * (+x = the door side, which faces the platform), `z` along it, `floor` = the cabin floor.
 */
export interface CabinLayout {
  kind: 'gondola' | 'cabin';
  /** Outside width (x), height and length (z). */
  w: number;
  h: number;
  d: number;
  /** Floor height below the grip (negative y). */
  floor: number;
  /** Window band, from the sill to the roof (m above the floor). */
  sill: number;
  roof: number;
  /** Rounded corner (pillar) radius and wall thickness. */
  corner: number;
  wall: number;
  /** Door opening width, centred on the side. */
  door: number;
  /** Benches along the front and back walls (gondolas): seat height and depth. */
  bench: { height: number; depth: number } | null;
}

export function cabinLayout(kind: 'gondola' | 'cabin', seats: number, hang: number): CabinLayout {
  if (kind === 'gondola') {
    const s = Math.cbrt(Math.max(seats, 4) / 8);
    const h = 2.0 * Math.min(s, 1.15);
    return {
      kind,
      ...{ w: 1.75 * s, h, d: 1.9 * s },
      floor: -hang - h / 2,
      sill: 0.82,
      roof: h - 0.3,
      corner: 0.1,
      wall: 0.05,
      door: Math.min(1.1, 1.9 * s - 0.6),
      bench: { height: 0.45, depth: 0.42 },
    };
  }
  const s = Math.cbrt(Math.max(seats, 40) / 120);
  return {
    kind,
    ...{ w: 3.6 * s, h: 2.9, d: 6.5 * s },
    floor: -hang - 1.45,
    sill: 1.0,
    roof: 2.5,
    corner: 0.22,
    wall: 0.06,
    door: Math.min(1.8, 6.5 * s * 0.4),
    bench: null,
  };
}

/** Back bench (riders face the direction of travel): seat centre z and top height. */
export function backBench(c: CabinLayout): { z: number; top: number } | null {
  if (!c.bench) return null;
  return { z: c.d / 2 - c.wall - c.bench.depth / 2, top: c.bench.height };
}

const LINING: RGB = [0.6, 0.62, 0.65];
const CEILING: RGB = [0.82, 0.83, 0.84];
const FLOOR: RGB = [0.16, 0.17, 0.18];
const TRIM: RGB = [0.1, 0.11, 0.12];

/**
 * Parts of an enclosed cabin. The outside is shared by every carrier (one instanced mesh
 * per type, `interior: false`, glass painted on as opaque tinted panels). The cabin you
 * ride in adds the inside (benches, linings, ceiling, rails) and returns its glass
 * separately, as thin panes for a transparent material.
 */
function cabinParts(
  c: CabinLayout,
  interior: boolean,
): { solid: BufferGeometry[]; glass: BufferGeometry[] } {
  const { w, h, d, floor: y0, sill, roof, corner: r, wall: t } = c;
  const body = c.kind === 'gondola' ? GONDOLA : CABIN;
  const top = y0 + h;
  const base = y0 - 0.08; // underside, below the floor slab
  const xIn = w / 2 - r; // pillar centres
  const zIn = d / 2 - r;
  const solid: BufferGeometry[] = [];
  const glass: BufferGeometry[] = [];
  const add = (
    g: BufferGeometry,
    colour: RGB,
    at: [number, number, number],
    rot?: [number, number, number],
  ) => solid.push(part(g, colour, at, rot));
  const box = (sx: number, sy: number, sz: number) => new BoxGeometry(sx, sy, sz);

  // Rounded corner pillars: body colour below the sill, dark frame through the windows.
  for (const x of [-xIn, xIn]) {
    for (const z of [-zIn, zIn]) {
      const low = sill + y0 - base;
      add(new CylinderGeometry(r, r, low, 8, 1, true), body, [x, base + low / 2, z]);
      add(new CylinderGeometry(r, r, roof - sill, 8, 1, true), TRIM, [
        x,
        y0 + (sill + roof) / 2,
        z,
      ]);
    }
  }
  // Lower walls (front, back, two sides), floor slab and roof.
  const low = sill + y0 - base;
  for (const z of [-1, 1])
    add(box(w - 2 * r, low, t), body, [0, base + low / 2, z * (d / 2 - t / 2)]);
  for (const x of [-1, 1])
    add(box(t, low, d - 2 * r), body, [x * (w / 2 - t / 2), base + low / 2, 0]);
  add(box(w - 2 * t, 0.08, d - 2 * t), FLOOR, [0, y0 - 0.04, 0]);
  const roofH = h - roof;
  add(new RoundedBoxGeometry(w, roofH, d, 1, Math.min(r, roofH / 2 - 0.01)), body, [
    0,
    top - roofH / 2,
    0,
  ]);
  if (c.kind === 'cabin') {
    // Livery stripe round the lower body.
    for (const z of [-1, 1])
      add(box(w - 2 * r, 0.22, 0.01), STRIPE, [0, y0 + 0.45, z * (d / 2 + 0.005)]);
    for (const x of [-1, 1])
      add(box(0.01, 0.22, d - 2 * r), STRIPE, [x * (w / 2 + 0.005), y0 + 0.45, 0]);
  }

  // Sill and header rails round the window band.
  const band = roof - sill;
  for (const y of [y0 + sill, y0 + roof]) {
    for (const z of [-1, 1]) add(box(w - 2 * r, 0.05, 0.03), TRIM, [0, y, z * (d / 2 - 0.005)]);
    for (const x of [-1, 1]) add(box(0.03, 0.05, d - 2 * r), TRIM, [x * (w / 2 - 0.005), y, 0]);
  }
  // Windows on all four sides; the outside has no interior, so they're opaque there.
  const pane = (sx: number, sz: number, at: [number, number, number]) => {
    if (interior) {
      const g = new PlaneGeometry(Math.max(sx, sz), band);
      glass.push(part(g, GLASS, at, [0, sx > sz ? 0 : Math.PI / 2, 0]));
    } else {
      add(box(Math.max(sx, 0.02), band, Math.max(sz, 0.02)), GLASS, at);
    }
  };
  const yMid = y0 + (sill + roof) / 2;
  for (const z of [-1, 1]) pane(w - 2 * r, 0, [0, yMid, z * (d / 2 - t / 2)]);
  for (const x of [-1, 1]) pane(0, d - 2 * r, [x * (w / 2 - t / 2), yMid, 0]);

  // Door(s) on the +x side (cable cars have them on both: the cabin never turns round):
  // dark seams round the leaves, full height, plus the split down the middle.
  for (const x of c.kind === 'cabin' ? [-1, 1] : [1]) {
    const xs = x * (w / 2 + 0.006);
    const hd = roof + 0.03;
    for (const z of [-c.door / 2, 0, c.door / 2]) {
      add(box(0.015, hd, z === 0 ? 0.02 : 0.04), TRIM, [xs, y0 + hd / 2 - 0.03, z]);
    }
    add(box(0.015, 0.04, c.door), TRIM, [xs, y0 + hd - 0.03, 0]);
    // Ski and board racks on the door leaves (gondolas).
    if (c.kind === 'gondola') {
      for (const z of [-c.door / 4, c.door / 4]) {
        add(box(0.06, 0.05, c.door / 2 - 0.12), STEEL, [x * (w / 2 + 0.035), y0 + 0.35, z]);
      }
    }
  }

  if (c.kind === 'gondola') {
    // Grip, hanger arm down to a mount on the roof.
    const drop = -top - 0.15;
    add(box(0.25, 0.3, 0.5), DARK, [0, -0.12, 0]);
    add(new CylinderGeometry(0.06, 0.06, drop, 8), STEEL, [0, -0.15 - drop / 2, 0]);
    add(box(0.18, 0.12, 0.18), DARK, [0, top + 0.12, 0]);
    add(box(w * 0.5, 0.08, d * 0.45), STEEL, [0, top + 0.04, 0]);
  } else {
    // Jig-back: carriage on the track ropes, two hanger arms down to the roof frame.
    const arm = -0.5 - top;
    add(box(0.9, 0.7, 3.4), DARK, [0, -0.2, 0]);
    for (const z of [-1.1, 1.1]) add(box(0.16, arm, 0.16), STEEL, [0, -0.5 - arm / 2, z]);
    add(box(w * 0.7, 0.15, 2.6), STEEL, [0, top + 0.08, 0]);
  }

  if (!interior) return { solid, glass };

  // Inside: linings below the sill, ceiling with a light strip, floor mat.
  const li = 0.015;
  for (const z of [-1, 1])
    add(box(w - 2 * t, sill, li), LINING, [0, y0 + sill / 2, z * (d / 2 - t - li / 2)]);
  for (const x of [-1, 1])
    add(box(li, sill, d - 2 * t), LINING, [x * (w / 2 - t - li / 2), y0 + sill / 2, 0]);
  add(box(w - 2 * t, 0.02, d - 2 * t), CEILING, [0, y0 + roof - 0.01, 0]);
  add(box(w * 0.5, 0.012, 0.1), [0.97, 0.96, 0.9], [0, y0 + roof - 0.026, 0]);
  add(box(w - 2 * t - 0.1, 0.006, d - 2 * t - 0.1), FLOOR, [0, y0 + 0.003, 0]);

  if (c.bench) {
    const { height: bh, depth: bd } = c.bench;
    const bw = w - 2 * t - 0.04;
    for (const side of [-1, 1]) {
      const zs = side * (d / 2 - t - bd / 2);
      add(box(bw, 0.08, bd), SEAT, [0, y0 + bh - 0.04, zs]); // cushion
      add(box(bw, bh - 0.08, bd * 0.7), LINING, [0, y0 + (bh - 0.08) / 2, zs + side * bd * 0.15]);
      add(
        box(bw, 0.44, 0.06),
        SEAT,
        [0, y0 + bh + 0.27, side * (d / 2 - t - 0.06)],
        [side * 0.12, 0, 0],
      ); // backrest
    }
    // Grab handle beside the door.
    add(new CylinderGeometry(0.018, 0.018, 0.5, 6), STEEL, [
      w / 2 - t - 0.06,
      y0 + sill + 0.3,
      c.door / 2 + 0.08,
    ]);
  } else {
    // Standing cabin: ceiling rails along its length, a handrail round the walls.
    for (const x of [-w / 4, w / 4]) {
      add(
        new CylinderGeometry(0.02, 0.02, d - 1, 6),
        STEEL,
        [x, y0 + roof - 0.25, 0],
        [Math.PI / 2, 0, 0],
      );
    }
    for (const z of [-1, 1]) {
      add(
        new CylinderGeometry(0.02, 0.02, w - 2 * r, 6),
        STEEL,
        [0, y0 + sill - 0.05, z * (d / 2 - t - 0.06)],
        [0, 0, Math.PI / 2],
      );
    }
  }
  return { solid, glass };
}

/** Enclosed gondola cabin for `seats` people (the shared outside). */
export function gondolaGeometry(seats: number, hang: number): BufferGeometry {
  return merge(cabinParts(cabinLayout('gondola', seats, hang), false).solid);
}

/** Large jig-back cable car cabin with its carriage (the shared outside). */
export function cabinGeometry(seats: number, hang: number): BufferGeometry {
  return merge(cabinParts(cabinLayout('cabin', seats, hang), false).solid);
}

/** The cabin you're riding in: outside, inside, and its window glass separately. */
export function cabinInteriorGeometry(c: CabinLayout): {
  solid: BufferGeometry;
  glass: BufferGeometry;
} {
  const { solid, glass } = cabinParts(c, true);
  return { solid: merge(solid), glass: merge(glass) };
}

/** Drag-lift carrier: grip and spring box; the pole is a separate, stretched mesh. */
export function platterGripGeometry(): BufferGeometry {
  return merge([
    part(new BoxGeometry(0.16, 0.2, 0.3), DARK, [0, -0.1, 0]),
    part(new CylinderGeometry(0.07, 0.07, 0.5, 8), STEEL, [0, -0.45, 0]),
  ]);
}

/** Unit-length pole (stretched per instance from the grip down toward the snow). */
export function poleGeometry(): BufferGeometry {
  const g = part(new CylinderGeometry(0.025, 0.025, 1, 6), STEEL, [0, -0.5, 0]);
  return merge([g]);
}

export function platterGeometry(tbar: boolean): BufferGeometry {
  return merge([
    tbar
      ? part(new BoxGeometry(1.1, 0.06, 0.06), PLATTER, [0, 0, 0])
      : part(
          new CylinderGeometry(0.17, 0.17, 0.04, 16),
          PLATTER,
          [0, 0, 0.12],
          [Math.PI / 2, 0, 0],
        ),
  ]);
}

/** Static parts (unit sized, scaled per instance). */
const CONCRETE: RGB = [0.56, 0.55, 0.53];

export function towerGeometry(): BufferGeometry {
  // Tapered tubular column, base at y = 0 and top at y = 1, with a ladder up its
  // downhill side (scaled with the column, so only its rails: rungs would stretch).
  const column = new CylinderGeometry(0.55, 0.85, 1, 10);
  column.translate(0, 0.5, 0);
  const parts = [part(column, STEEL, [0, 0, 0])];
  for (const x of [-0.22, 0.22])
    parts.push(part(new BoxGeometry(0.06, 1, 0.06), DARK, [x, 0.5, 0.95]));
  return merge(parts);
}

/** A tower's concrete footing, 1 m across per unit of the column's scale (x, z). */
export function footingGeometry(): BufferGeometry {
  return merge([part(new BoxGeometry(2.4, 1.4, 2.4), CONCRETE, [0, -0.2, 0])]);
}

/**
 * Crossarm, 1 m long across the line (instances stretch it in x to the gauge): the beam,
 * with a grated maintenance catwalk and its handrail along the downhill side.
 */
export function crossArmGeometry(): BufferGeometry {
  return merge([
    part(new BoxGeometry(1, 0.35, 0.45), STEEL, [0, 0, 0]),
    part(new BoxGeometry(1, 0.05, 0.75), DARK, [0, -0.2, 0.6]), // catwalk grating
    part(new BoxGeometry(1, 0.04, 0.04), STEEL, [0, 0.75, 0.95]), // handrail
    part(new BoxGeometry(1, 0.04, 0.04), STEEL, [0, 0.3, 0.95]), // knee rail
  ]);
}

/**
 * Sheave train: a row of rubber-lined wheels between side plates, the cable running
 * along z, hung from the crossarm above it.
 */
export function sheaveGeometry(): BufferGeometry {
  const parts = [
    part(new BoxGeometry(0.16, 0.3, 0.2), DARK, [0, 0.33, 0]), // hanger up to the arm
    part(new BoxGeometry(0.3, 0.1, 2.7), DARK, [0, 0.2, 0]), // rocker beam
  ];
  for (const x of [-0.13, 0.13])
    parts.push(part(new BoxGeometry(0.03, 0.32, 2.7), STEEL, [x, 0, 0]));
  for (let i = 0; i < 6; i++) {
    parts.push(
      part(
        new CylinderGeometry(0.19, 0.19, 0.16, 12),
        DARK,
        [0, 0, -1.1 + i * 0.44],
        [0, 0, Math.PI / 2],
      ),
    );
  }
  return merge(parts);
}

export function bullwheelGeometry(): BufferGeometry {
  return merge([part(new TorusGeometry(1, 0.06, 4, 18), DARK, [0, 0, 0], [Math.PI / 2, 0, 0])]);
}

/** A chair's seat top above the loading platform: it meets you behind the knees. */
export const CHAIR_SEAT_HEIGHT = 0.48;

/**
 * Depth below its grip of what a rider stands on as the carrier comes in, so terminals
 * set the rail height to bring it level with the platform: the snow under a chair
 * (`CHAIR_SEAT_HEIGHT` below the seat), the cabin floor.
 */
export function floorBelowGrip(kind: string, seats: number, hang: number): number {
  // Seat top is 5 cm above the cushion centre, at `hang` below the grip.
  if (kind === 'chair') return hang - 0.05 + CHAIR_SEAT_HEIGHT;
  if (kind === 'gondola' || kind === 'cabin') return -cabinLayout(kind, seats, hang).floor;
  return 0;
}
