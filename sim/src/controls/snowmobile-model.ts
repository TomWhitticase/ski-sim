import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  Euler,
  ExtrudeGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  PlaneGeometry,
  Quaternion,
  Shape,
  Vector3,
} from 'three/webgpu';

type RGB = [number, number, number];

const PAINT: RGB = [0.78, 0.07, 0.05]; // red hood and side panels
const STRIPE: RGB = [0.94, 0.95, 0.96];
const BLACK: RGB = [0.05, 0.05, 0.06];
const PLASTIC: RGB = [0.12, 0.12, 0.14];
const ALLOY: RGB = [0.62, 0.64, 0.67];
const RUBBER: RGB = [0.07, 0.07, 0.08];
const SEAT: RGB = [0.09, 0.09, 0.1];

/**
 * Snowmobile dimensions (m), sled-local: origin at the track's contact centre on the snow,
 * x = right, y = up, -z = forward. Roughly a 155" mountain sled: ~3.4 m long, skis
 * ~1.06 m apart, seat ~0.75 m up, tall riser with the bars pulled back over the seat.
 */
export const SLED_LAYOUT = {
  /** Running boards (where the rider's boots rest): height and the boots' fore/aft spot. */
  boardHeight: 0.3,
  footZ: -0.25,
  footX: 0.28,
  /** Rider's hips on the seat, above the boards and behind the boots' origin. */
  hipHeight: 0.58,
  hipBack: 0.25,
  /** Handlebar grips (right side; the left mirrors it). */
  grip: new Vector3(0.42, 1.1, -0.12),
  /** Eye, for first person. */
  eye: new Vector3(0, 1.48, 0.06),
  skiX: 0.53,
  skiZ: -1.25,
  /** Track: length of the run on the snow and its width. */
  trackRear: 1.45,
  trackFront: -0.5,
  trackWidth: 0.38,
  lugSpacing: 0.076,
};

/** A part: geometry moved into place and painted one colour (as in lifts/carriers.ts). */
function part(
  geometry: BufferGeometry,
  colour: RGB | ((p: Vector3) => RGB),
  at: [number, number, number],
  rotation: [number, number, number] = [0, 0, 0],
): BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  g.deleteAttribute('uv');
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  g.applyMatrix4(
    new Matrix4().compose(
      new Vector3(...at),
      new Quaternion().setFromEuler(new Euler(...rotation)),
      new Vector3(1, 1, 1),
    ),
  );
  const position = g.getAttribute('position');
  const colours = new Float32Array(position.count * 3);
  const p = new Vector3();
  for (let i = 0; i < position.count; i++) {
    const c = typeof colour === 'function' ? colour(p.fromBufferAttribute(position, i)) : colour;
    colours.set(c, i * 3);
  }
  g.setAttribute('color', new BufferAttribute(colours, 3));
  return g;
}

function merge(parts: BufferGeometry[]): BufferGeometry {
  const g = mergeGeometries(parts)!;
  g.computeBoundingSphere();
  return g;
}

/** A cylinder between two points. */
function rod(a: Vector3, b: Vector3, radius: number, colour: RGB): BufferGeometry {
  const span = b.clone().sub(a);
  const g = new CylinderGeometry(radius, radius, span.length(), 8);
  g.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), span.normalize()));
  const mid = a.clone().add(b).multiplyScalar(0.5);
  return part(g, colour, [mid.x, mid.y, mid.z]);
}

interface HoodSection {
  z: number;
  width: number;
  bottom: number;
  top: number;
}

/**
 * The hood and belly pan as one lofted shell: rounded-rectangle sections from the dash
 * to the nose, red above a black belly with a white stripe along each side.
 */
function hoodGeometry(): BufferGeometry {
  const sections: HoodSection[] = [
    { z: -0.48, width: 0.6, bottom: 0.24, top: 0.86 },
    { z: -0.75, width: 0.7, bottom: 0.18, top: 0.84 },
    { z: -1.1, width: 0.72, bottom: 0.15, top: 0.72 },
    { z: -1.45, width: 0.62, bottom: 0.16, top: 0.58 },
    { z: -1.72, width: 0.44, bottom: 0.22, top: 0.46 },
    { z: -1.86, width: 0.2, bottom: 0.3, top: 0.38 },
  ];
  const around = 28;
  const exponent = 4; // superellipse: boxy with rounded corners
  const positions: number[] = [];
  const index: number[] = [];
  for (const s of sections) {
    const mid = (s.bottom + s.top) / 2;
    const half = (s.top - s.bottom) / 2;
    for (let i = 0; i < around; i++) {
      const a = (i / around) * Math.PI * 2;
      const c = Math.cos(a);
      const si = Math.sin(a);
      const x = (s.width / 2) * Math.sign(c) * Math.abs(c) ** (2 / exponent);
      const y = mid + half * Math.sign(si) * Math.abs(si) ** (2 / exponent);
      positions.push(x, y, s.z);
    }
  }
  for (let k = 0; k < sections.length - 1; k++) {
    for (let i = 0; i < around; i++) {
      const a = k * around + i;
      const b = k * around + ((i + 1) % around);
      const c = a + around;
      const d = b + around;
      index.push(a, c, b, b, c, d); // wound to face outward
    }
  }
  // Cap the nose and the back of the shell (under the dash).
  const last = (sections.length - 1) * around;
  for (let i = 1; i < around - 1; i++) {
    index.push(last, last + i + 1, last + i);
    index.push(0, i, i + 1);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return part(
    g,
    (p) => {
      const section = sections.reduce((best, s) =>
        Math.abs(s.z - p.z) < Math.abs(best.z - p.z) ? s : best,
      );
      const rel = (p.y - section.bottom) / (section.top - section.bottom);
      if (rel < 0.3) return BLACK;
      if (rel > 0.42 && rel < 0.5 && Math.abs(p.x) > section.width * 0.4) return STRIPE;
      return PAINT;
    },
    [0, 0, 0],
  );
}

/** Side profile of the track loop (z, y), extruded across its width. */
function trackGeometry(): BufferGeometry {
  const L = SLED_LAYOUT;
  const shape = new Shape();
  // Shape x is -z (so the extrusion lands the right way round once turned), y is up.
  const pts: [number, number][] = [];
  const arc = (cz: number, cy: number, r: number, from: number, to: number) => {
    for (let i = 0; i <= 6; i++) {
      const a = from + ((to - from) * i) / 6;
      pts.push([cz + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  arc(L.trackRear - 0.02, 0.13, 0.13, Math.PI / 2, -Math.PI / 2); // rear idler, top round to bottom
  pts.push([L.trackFront, 0]);
  arc(-0.78, 0.3, 0.13, -Math.PI * 0.75, -Math.PI * 1.5); // drive sprocket up front
  pts.push([L.trackRear - 0.02, 0.26]);
  pts.forEach(([z, y], i) => (i === 0 ? shape.moveTo(-z, y) : shape.lineTo(-z, y)));
  const g = new ExtrudeGeometry(shape, { depth: L.trackWidth, bevelEnabled: false });
  g.rotateY(Math.PI / 2);
  g.translate(-L.trackWidth / 2, 0, 0);
  return part(g, RUBBER, [0, 0, 0]);
}

/** Paddles along one straight run of the track (they scroll as the track turns). */
function lugsGeometry(y: number, height: number, from: number, to: number): BufferGeometry {
  const L = SLED_LAYOUT;
  const parts: BufferGeometry[] = [];
  for (let z = from; z <= to; z += L.lugSpacing) {
    parts.push(part(new BoxGeometry(L.trackWidth + 0.02, height, 0.025), RUBBER, [0, y, z]));
  }
  return merge(parts);
}

/** One front ski and its spindle, pivoting about the spindle (origin). */
function skiGeometry(): BufferGeometry {
  return merge([
    part(new BoxGeometry(0.15, 0.03, 1.15), BLACK, [0, -0.25 + 0.015, -0.02]), // runner
    part(new BoxGeometry(0.15, 0.03, 0.32), BLACK, [0, -0.25 + 0.1, -0.69], [0.55, 0, 0]), // tip
    part(new BoxGeometry(0.05, 0.05, 0.9), PLASTIC, [0, -0.25 + 0.05, -0.05]), // keel ridge
    part(new BoxGeometry(0.17, 0.02, 0.06), PLASTIC, [0, -0.25 + 0.22, -0.8]), // handle
    part(new CylinderGeometry(0.035, 0.035, 0.3, 8), ALLOY, [0, -0.1, 0]), // spindle
  ]);
}

function bodyGeometry(): BufferGeometry {
  const L = SLED_LAYOUT;
  const parts: BufferGeometry[] = [hoodGeometry()];
  // Tunnel over the track, with running boards out to each side.
  parts.push(part(new BoxGeometry(0.5, 0.02, 2.05), PLASTIC, [0, 0.49, 0.47]));
  for (const side of [-1, 1]) {
    parts.push(part(new BoxGeometry(0.02, 0.22, 2.05), PAINT, [side * 0.25, 0.39, 0.47]));
    parts.push(
      part(new BoxGeometry(0.2, 0.02, 1.25), ALLOY, [side * 0.35, L.boardHeight - 0.01, 0.2]),
    );
    parts.push(
      part(new BoxGeometry(0.02, 0.05, 1.25), ALLOY, [side * 0.45, L.boardHeight + 0.01, 0.2]),
    );
    // Front suspension: A-arms from the chassis out to the spindles, and the shock.
    const spindleTop = new Vector3(side * L.skiX, 0.33, L.skiZ);
    const spindleLow = new Vector3(side * L.skiX, 0.18, L.skiZ);
    for (const dz of [-0.16, 0.16]) {
      parts.push(rod(spindleTop, new Vector3(side * 0.24, 0.4, L.skiZ + dz), 0.015, PLASTIC));
      parts.push(rod(spindleLow, new Vector3(side * 0.24, 0.24, L.skiZ + dz), 0.015, PLASTIC));
    }
    parts.push(rod(spindleTop, new Vector3(side * 0.22, 0.72, L.skiZ + 0.12), 0.03, ALLOY));
    // Grab strap / rear rack rails.
    parts.push(
      rod(new Vector3(side * 0.22, 0.52, 0.8), new Vector3(side * 0.22, 0.6, 1.45), 0.015, BLACK),
    );
  }
  // Seat, console and the gas tank between knees.
  parts.push(part(new RoundedBoxGeometry(0.34, 0.24, 1.0, 3, 0.06), SEAT, [0, 0.62, 0.28]));
  parts.push(part(new RoundedBoxGeometry(0.36, 0.3, 0.32, 3, 0.06), PAINT, [0, 0.66, -0.36]));
  // Rear bumper, snow flap and tail light housing.
  parts.push(rod(new Vector3(-0.24, 0.48, 1.55), new Vector3(0.24, 0.48, 1.55), 0.022, BLACK));
  parts.push(part(new BoxGeometry(0.42, 0.3, 0.012), BLACK, [0, 0.3, 1.56]));
  // Front bumper loop.
  parts.push(rod(new Vector3(-0.2, 0.32, -1.92), new Vector3(0.2, 0.32, -1.92), 0.02, BLACK));
  // Steering post up the dash, then the tall mountain riser back to the bars.
  const post = new Vector3(0, 0.62, -0.62);
  const riserBase = new Vector3(0, 0.95, -0.46);
  parts.push(rod(post, riserBase, 0.025, BLACK));
  return merge(parts);
}

/** Handlebars, riser and grips; they turn with the steering about the post. */
function barsGeometry(): BufferGeometry {
  const L = SLED_LAYOUT;
  const g = L.grip;
  const base = new Vector3(0, 0.95, -0.46);
  const top = new Vector3(0, g.y, g.z + 0.02);
  return merge([
    rod(base, top, 0.022, ALLOY),
    rod(new Vector3(-g.x - 0.05, g.y, g.z), new Vector3(g.x + 0.05, g.y, g.z), 0.014, ALLOY),
    rod(new Vector3(-0.12, g.y + 0.04, g.z), new Vector3(0.12, g.y + 0.04, g.z), 0.01, ALLOY), // mountain strap bar
    part(new CylinderGeometry(0.02, 0.02, 0.13, 8), BLACK, [-g.x, g.y, g.z], [0, 0, Math.PI / 2]),
    part(new CylinderGeometry(0.02, 0.02, 0.13, 8), BLACK, [g.x, g.y, g.z], [0, 0, Math.PI / 2]),
    // Hand guards.
    part(new BoxGeometry(0.1, 0.06, 0.14), PLASTIC, [-g.x - 0.03, g.y + 0.01, g.z - 0.08]),
    part(new BoxGeometry(0.1, 0.06, 0.14), PLASTIC, [g.x + 0.03, g.y + 0.01, g.z - 0.08]),
  ]);
}

export interface SnowmobileParts {
  /** Whole sled: place and orient it at the track's contact centre. */
  root: Group;
  /** The sprung mass (chassis, seat, bars, rider): moves with the suspension. */
  body: Group;
  /** Where the rider's feet go (the running boards). */
  seat: Group;
  skis: [Group, Group];
  bars: Group;
  /** Bottom and top runs of track paddles (scrolled as the track turns). */
  lugs: [Mesh, Mesh];
}

/** The sled, as a few draw calls: body, bars, skis, track and its paddles, windshield, lights. */
export function createSnowmobile(): SnowmobileParts {
  const L = SLED_LAYOUT;
  const material = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.45 });
  const shade = <T extends Mesh>(m: T) => {
    m.castShadow = true;
    return m;
  };
  const root = new Group();
  root.name = 'snowmobile';
  const body = new Group();
  root.add(body);
  body.add(shade(new Mesh(bodyGeometry(), material)));

  const bars = new Group();
  bars.position.set(0, 0.95, -0.46); // pivot at the top of the steering post
  const barsMesh = shade(new Mesh(barsGeometry().translate(0, -0.95, 0.46), material));
  bars.add(barsMesh);
  body.add(bars);

  // A small tinted windshield on the dash.
  const glass = new MeshStandardNodeMaterial({
    color: 0x1b2a38,
    roughness: 0.05,
    metalness: 0.3,
    transparent: true,
    opacity: 0.5,
    side: DoubleSide,
  });
  const shield = new Mesh(new PlaneGeometry(0.52, 0.24), glass);
  shield.position.set(0, 0.95, -0.66);
  shield.rotation.x = 0.75; // top raked back toward the rider
  body.add(shield);

  // Head and tail lights: unlit materials so they glow in any light.
  const lamp = (
    colour: number,
    w: number,
    h: number,
    at: [number, number, number],
    rotation: [number, number, number],
  ) => {
    const m = new Mesh(new PlaneGeometry(w, h), new MeshBasicNodeMaterial({ color: colour }));
    m.position.set(...at);
    m.rotation.set(...rotation);
    body.add(m);
  };
  // Planes face +z (backwards): the headlight is turned round to face forward and up.
  lamp(0xfff6d8, 0.28, 0.05, [0, 0.52, -1.62], [0.9, Math.PI, 0]); // LED strip on the nose
  lamp(0xff1a10, 0.2, 0.045, [0, 0.47, 1.567], [0, 0, 0]); // tail light

  const seat = new Group();
  seat.position.set(0, L.boardHeight, 0);
  body.add(seat);

  // Unsprung: track, paddles and skis stay on the snow.
  root.add(shade(new Mesh(trackGeometry(), material)));
  const bottom = new Mesh(
    lugsGeometry(-0.012, 0.03, L.trackFront + 0.05, L.trackRear - 0.12),
    material,
  );
  const top = new Mesh(lugsGeometry(0.272, 0.03, -0.55, L.trackRear - 0.12), material);
  root.add(bottom, top);

  const ski = skiGeometry();
  const skis = [-1, 1].map((side) => {
    const g = new Group();
    g.position.set(side * L.skiX, 0.25, L.skiZ);
    g.add(shade(new Mesh(ski, material)));
    root.add(g);
    return g;
  }) as [Group, Group];

  return { root, body, seat, skis, bars, lugs: [bottom, top] };
}
