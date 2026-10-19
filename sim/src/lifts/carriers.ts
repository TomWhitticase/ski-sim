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

/** Detachable chair for `seats` people, seat `hang` m below the cable. */
export function chairGeometry(seats: number, hang: number): BufferGeometry {
  const w = seats * 0.5;
  const seatY = -hang;
  const parts = [
    part(new BoxGeometry(0.22, 0.28, 0.45), DARK, [0, -0.12, 0]), // grip
    // Hanger: from the grip neck (-0.25) down to the top of the back frame.
    part(new CylinderGeometry(0.045, 0.045, hang - 1.2, 8), STEEL, [
      0,
      -0.25 - (hang - 1.2) / 2,
      0.42,
    ]),
    part(new BoxGeometry(0.08, 0.08, 0.45), STEEL, [0, -0.25, 0.2]), // hanger neck
    part(new BoxGeometry(w + 0.1, 0.07, 0.07), STEEL, [0, seatY + 0.95, 0.42]), // top of back frame
    part(new BoxGeometry(w, 0.1, 0.52), SEAT, [0, seatY, 0]), // cushion
    part(new BoxGeometry(w, 0.62, 0.09), SEAT, [0, seatY + 0.38, 0.3]), // backrest
    part(new BoxGeometry(w + 0.05, 0.05, 0.05), BAR, [0, seatY + 0.72, -0.48]), // safety bar
    part(new BoxGeometry(w * 0.8, 0.04, 0.12), BAR, [0, seatY - 0.48, -0.5]), // footrest
  ];
  for (const x of [-w / 2, w / 2]) {
    parts.push(part(new BoxGeometry(0.05, 0.8, 0.05), BAR, [x, seatY + 0.33, -0.1])); // armrest post
    parts.push(part(new BoxGeometry(0.05, 0.05, 0.6), BAR, [x, seatY + 0.72, -0.2])); // armrest
  }
  return merge(parts);
}

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
export function towerGeometry(): BufferGeometry {
  // Tapered tubular column, base at y = 0 and top at y = 1.
  const column = new CylinderGeometry(0.55, 0.85, 1, 10);
  column.translate(0, 0.5, 0);
  return merge([part(column, STEEL, [0, 0, 0])]);
}

/** Sheave train: a beam with a row of wheels, cable running along z. */
export function sheaveGeometry(): BufferGeometry {
  const parts = [part(new BoxGeometry(0.22, 0.25, 2.6), DARK, [0, 0.15, 0])];
  for (let i = 0; i < 4; i++) {
    parts.push(
      part(
        new CylinderGeometry(0.2, 0.2, 0.12, 12),
        STEEL,
        [0, 0, -0.9 + i * 0.6],
        [0, 0, Math.PI / 2],
      ),
    );
  }
  return merge(parts);
}

export function bullwheelGeometry(): BufferGeometry {
  return merge([part(new TorusGeometry(1, 0.06, 4, 18), DARK, [0, 0, 0], [Math.PI / 2, 0, 0])]);
}

/**
 * Height of a carrier's floor (or seat) below its grip, so terminals can set the rail
 * height to bring it level with the platform: chair seat surface, cabin floor.
 */
export function floorBelowGrip(kind: string, seats: number, hang: number): number {
  if (kind === 'chair') return hang - 0.05; // seat top is 5 cm above the cushion centre
  if (kind === 'gondola' || kind === 'cabin') return -cabinLayout(kind, seats, hang).floor;
  return 0;
}
