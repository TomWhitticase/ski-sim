import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  BoxGeometry,
  BufferAttribute,
  type BufferGeometry,
  CylinderGeometry,
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

/** Enclosed gondola cabin for `seats` people. */
export function gondolaGeometry(seats: number, hang: number): BufferGeometry {
  const s = Math.cbrt(Math.max(seats, 4) / 8);
  const [w, h, d] = [1.75 * s, 2.0 * Math.min(s, 1.15), 1.9 * s];
  const cy = -hang;
  const parts = [
    part(new BoxGeometry(0.25, 0.3, 0.5), DARK, [0, -0.12, 0]),
    // Hanger: from the grip (-0.15) down to the cabin roof (cy + h/2).
    part(new CylinderGeometry(0.06, 0.06, hang - h / 2 - 0.15, 8), STEEL, [
      0,
      -0.15 - (hang - h / 2 - 0.15) / 2,
      0,
    ]),
    part(new RoundedBoxGeometry(w, h, d, 2, 0.28), GONDOLA, [0, cy, 0]),
    // Window band all round.
    part(new BoxGeometry(w + 0.02, h * 0.38, d * 0.82), GLASS, [0, cy + h * 0.12, 0]),
    part(new BoxGeometry(w * 0.82, h * 0.38, d + 0.02), GLASS, [0, cy + h * 0.12, 0]),
    part(new BoxGeometry(w * 0.6, 0.06, d * 0.5), STEEL, [0, cy + h / 2 + 0.03, 0]), // roof plate
  ];
  return merge(parts);
}

/** Large jig-back cable car cabin with its carriage. */
export function cabinGeometry(seats: number, hang: number): BufferGeometry {
  const s = Math.cbrt(Math.max(seats, 40) / 120);
  const [w, h, d] = [3.6 * s, 2.9, 6.5 * s];
  const cy = -hang;
  const parts = [
    part(new BoxGeometry(0.9, 0.7, 3.4), DARK, [0, -0.2, 0]), // carriage on the track ropes
    ...[-1.1, 1.1].map((z) =>
      part(new BoxGeometry(0.16, hang - h / 2 - 0.5, 0.16), STEEL, [
        0,
        -0.5 - (hang - h / 2 - 0.5) / 2,
        z,
      ]),
    ),
    part(new BoxGeometry(w * 0.7, 0.15, 2.6), STEEL, [0, cy + h / 2 + 0.08, 0]),
    part(new RoundedBoxGeometry(w, h, d, 2, 0.35), CABIN, [0, cy, 0]),
    part(new BoxGeometry(w + 0.02, h * 0.42, d * 0.88), GLASS, [0, cy + h * 0.12, 0]),
    part(new BoxGeometry(w * 0.86, h * 0.42, d + 0.02), GLASS, [0, cy + h * 0.12, 0]),
    part(new BoxGeometry(w + 0.04, 0.22, d + 0.04), STRIPE, [0, cy - h * 0.22, 0]),
  ];
  return merge(parts);
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
  if (kind === 'gondola') {
    const s = Math.cbrt(Math.max(seats, 4) / 8);
    return hang + (2.0 * Math.min(s, 1.15)) / 2;
  }
  if (kind === 'cabin') return hang + 1.45;
  return 0;
}
