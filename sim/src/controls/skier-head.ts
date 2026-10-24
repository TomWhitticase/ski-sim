import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  CylinderGeometry,
  Matrix4,
  SphereGeometry,
  Vector3,
} from 'three/webgpu';

/**
 * The skier's head, in head-local metres (y up, -z forward): a ski helmet with a small
 * peak, top vents and ear pads, wraparound goggles on its front with a strap round the
 * back, and a neck gaiter covering the face up to the goggles. One geometry per
 * material, so the whole head is five draw calls.
 */

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/** Helmet shell: an ellipsoid round this centre. */
export const HELMET = { y: 0.015, z: 0.008, rx: 0.112, ry: 0.118, rz: 0.13 };
/** Goggles: lens wrapped round the helmet's centre, `span` radians either side of ahead. */
export const GOGGLES = { y: -0.002, half: 0.034, span: 1.25, rx: 0.12, rz: 0.142 };
/** The face under the gaiter: an ellipsoid (centre y, z; radii). */
export const FACE = { y: -0.012, z: 0.004, rx: 0.078, ry: 0.106, rz: 0.095 };

/**
 * Polar angle (0 = crown) of the helmet's lower edge at azimuth `az` (0 = ahead): high at
 * the front, so the goggles sit under it, down over the ears and lowest at the back.
 */
export const helmetRim = (az: number) => {
  const a = Math.abs(az);
  return (
    Math.PI * (0.42 + 0.3 * smoothstep(0.7, 2.6, a) + 0.12 * Math.exp(-(((a - 1.75) / 0.45) ** 2)))
  );
};

/** A point on the helmet shell (`scale` < 1 is inside it). */
export function helmetPoint(az: number, polar: number, scale = 1): Vector3 {
  const s = Math.sin(polar) * scale;
  return new Vector3(
    Math.sin(az) * s * HELMET.rx,
    HELMET.y + Math.cos(polar) * HELMET.ry * scale,
    HELMET.z - Math.cos(az) * s * HELMET.rz,
  );
}

/** Goggle outline at u ∈ [-1, 1] across: [bottom, top] above `GOGGLES.y`, nose cut-out below. */
export function goggleOutline(u: number, grow = 0): [number, number] {
  const edge = 1 - 0.35 * Math.abs(u) ** 5;
  const half = GOGGLES.half * edge + grow;
  return [-half + 0.016 * Math.exp(-((u / 0.18) ** 2)), half];
}

/** A point on the goggles' curved front, `out` metres outside the lens (negative: behind). */
export function gogglePoint(u: number, v: number, out = 0, grow = 0, span = GOGGLES.span) {
  const [bottom, top] = goggleOutline(u, grow);
  const h = bottom + (top - bottom) * v;
  // Curved top to bottom too (a toric lens), pulling in 6 mm at the edges.
  const r = out - 0.006 * (h / GOGGLES.half) ** 2;
  const az = u * span;
  return new Vector3(
    Math.sin(az) * (GOGGLES.rx + r),
    GOGGLES.y + h,
    HELMET.z - Math.cos(az) * (GOGGLES.rz + r),
  );
}

/** Indexed grid of (cols + 1) × (rows + 1) points (`wrap`: column `cols` is column 0). */
function grid(
  cols: number,
  rows: number,
  point: (i: number, j: number) => Vector3,
  wrap = false,
): BufferGeometry {
  const width = wrap ? cols : cols + 1;
  const positions: number[] = [];
  for (let j = 0; j <= rows; j++)
    for (let i = 0; i < width; i++) positions.push(...point(i, j).toArray());
  const index: number[] = [];
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const a = j * width + i;
      const b = j * width + ((i + 1) % width);
      const c = a + width;
      const d = b + width;
      index.push(a, c, b, b, c, d);
    }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(index);
  return geometry;
}

/** Positions and index only, with smooth normals, so parts merge. */
function finish(geometry: BufferGeometry, weld = false): BufferGeometry {
  for (const name of Object.keys(geometry.attributes))
    if (name !== 'position') geometry.deleteAttribute(name);
  const out = weld ? mergeVertices(geometry, 1e-5) : geometry;
  out.computeVertexNormals();
  return out;
}

/** Shell (with a rolled lip inside its edge) and the peak over the goggles. */
function helmetGeometry(): BufferGeometry {
  const ROWS = 16;
  const shell = grid(
    48,
    ROWS + 1,
    (i, j) => {
      const az = (i / 48) * Math.PI * 2;
      const rim = helmetRim(az);
      return j <= ROWS ? helmetPoint(az, (rim * j) / ROWS) : helmetPoint(az, rim - 0.03, 0.93);
    },
    true,
  );
  // Peak: a wedge from just above the front edge, out and slightly down, tapering away.
  const PEAK = 0.8;
  const peak = grid(20, 2, (i, j) => {
    const az = (i / 20 - 0.5) * 2 * PEAK;
    const rim = helmetRim(az);
    if (j !== 1) return helmetPoint(az, j === 0 ? rim - 0.07 : rim, 1.005);
    const p = helmetPoint(az, rim, 1.005);
    const reach = 0.016 * Math.cos(((az / PEAK) * Math.PI) / 2) ** 0.6;
    return p.add(new Vector3(Math.sin(az) * reach, 0.002, -Math.cos(az) * reach));
  });
  return mergeGeometries([finish(shell, true), finish(peak)]);
}

/** The goggle frame, plus the helmet's vent slots and ear pads in the same black. */
function frameGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const vent = (x: number, z: number) => {
    const { rx, ry, rz } = HELMET;
    const dz = z - HELMET.z;
    const y = ry * Math.sqrt(1 - (x / rx) ** 2 - (dz / rz) ** 2);
    const normal = new Vector3(x / rx ** 2, y / ry ** 2, dz / rz ** 2).normalize();
    const along = new Vector3(0, 0, 1).projectOnPlane(normal).normalize();
    const across = along.clone().cross(normal);
    const slot = new CapsuleGeometry(0.0065, 0.03, 3, 8);
    slot.applyMatrix4(
      new Matrix4()
        .makeBasis(across, along, normal)
        .setPosition(x, HELMET.y + y, z)
        .multiply(new Matrix4().makeScale(1, 1, 0.45)),
    );
    parts.push(finish(slot));
  };
  for (const x of [-0.036, 0, 0.036]) vent(x, -0.07);
  for (const x of [-0.03, 0.03]) vent(x, 0.075);
  for (const side of [-1, 1]) {
    const pad = new SphereGeometry(1, 14, 10);
    pad.scale(0.009, 0.022, 0.04);
    pad.translate(side * 0.086, -0.056, 0.014);
    parts.push(finish(pad));
  }

  // Frame: a face 4 mm behind the lens, a little larger than it, and walls back to the face.
  const SPAN = GOGGLES.span * 1.03;
  parts.push(finish(grid(32, 4, (i, j) => gogglePoint(i / 16 - 1, j / 4, -0.004, 0.006, SPAN))));
  const loop: [number, number][] = [];
  for (let i = 0; i <= 32; i++) loop.push([i / 16 - 1, 1]);
  for (let i = 32; i >= 0; i--) loop.push([i / 16 - 1, 0]);
  parts.push(
    finish(
      grid(loop.length - 1, 1, (i, j) => {
        const [u, v] = loop[i]!;
        return gogglePoint(u, v, j === 0 ? -0.004 : -0.045, 0.006, SPAN);
      }),
    ),
  );
  return mergeGeometries(parts);
}

/** The mirrored lens, its tint shading from deep red at the top to gold at the bottom. */
function lensGeometry(): BufferGeometry {
  const lens = finish(grid(32, 6, (i, j) => gogglePoint(i / 16 - 1, j / 6)));
  const colours: number[] = [];
  for (let j = 0; j <= 6; j++)
    for (let i = 0; i <= 32; i++) {
      const t = j / 6;
      colours.push(1, 0.62 - 0.4 * t, 0.16 - 0.12 * t);
    }
  lens.setAttribute('color', new BufferAttribute(new Float32Array(colours), 3));
  return lens;
}

/** Goggle strap: a band round the back of the helmet between the goggle's ends. */
function strapGeometry(): BufferGeometry {
  const HALF = 0.019;
  const polar = Math.acos((GOGGLES.y - HELMET.y) / HELMET.ry);
  const ring = Math.sin(polar);
  const from = GOGGLES.span * 0.95;
  // Profile: inner bottom, outer bottom, outer top, inner top.
  const profile: [number, number][] = [
    [0, -HALF],
    [0.004, -HALF],
    [0.004, HALF],
    [0, HALF],
  ];
  return finish(
    grid(32, 3, (i, j) => {
      const az = from + (i / 32) * (Math.PI * 2 - 2 * from);
      const [out, h] = profile[j]!;
      return new Vector3(
        Math.sin(az) * (HELMET.rx * ring + out),
        GOGGLES.y + h,
        HELMET.z - Math.cos(az) * (HELMET.rz * ring + out),
      );
    }),
  );
}

/** Neck gaiter: a loose tube from the collar, over the face (fuller round mouth and chin). */
function gaiterGeometry(): BufferGeometry {
  const face = new SphereGeometry(1, 24, 16);
  const p = face.attributes.position!;
  for (let k = 0; k < p.count; k++) {
    const x = p.getX(k);
    const y = p.getY(k);
    const z = p.getZ(k);
    const muzzle = Math.max(0, -z) ** 2 * Math.exp(-(((y + 0.45) / 0.35) ** 2));
    p.setXYZ(k, x * FACE.rx, FACE.y + y * FACE.ry, FACE.z + z * FACE.rz - 0.014 * muzzle);
  }
  const neck = new CylinderGeometry(0.068, 0.076, 0.11, 20, 1, true);
  neck.translate(0, -0.125, 0.01);
  return mergeGeometries([finish(face), finish(neck)]);
}

export interface HeadGeometries {
  helmet: BufferGeometry;
  frame: BufferGeometry;
  lens: BufferGeometry;
  strap: BufferGeometry;
  gaiter: BufferGeometry;
}

let shared: HeadGeometries | null = null;

/** The head's geometries, built once and shared by every skier. */
export function headGeometries(): HeadGeometries {
  shared ??= {
    helmet: helmetGeometry(),
    frame: frameGeometry(),
    lens: lensGeometry(),
    strap: strapGeometry(),
    gaiter: gaiterGeometry(),
  };
  return shared;
}
