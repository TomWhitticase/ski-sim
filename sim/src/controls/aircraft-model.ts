import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  SphereGeometry,
  Vector3,
} from 'three/webgpu';

import { H125, type HeliType, PC6, type PlaneType } from './aircraft-types';
import { merge, part, type RGB, rod } from './snowmobile-model';

const WHITE: RGB = [0.9, 0.91, 0.92];
const RED: RGB = [0.72, 0.06, 0.06];
const DARK: RGB = [0.08, 0.08, 0.09];
const GREY: RGB = [0.42, 0.44, 0.46];
const METAL: RGB = [0.6, 0.62, 0.65];
const TYRE: RGB = [0.06, 0.06, 0.07];
const SKI: RGB = [0.78, 0.8, 0.82];
const INTERIOR: RGB = [0.18, 0.19, 0.2];
const BLADE: RGB = [0.14, 0.14, 0.15];
const TIP: RGB = [0.9, 0.85, 0.2];

/** One cross-section of a lofted fuselage: a superellipse at `z`, `w` half-wide. */
interface Section {
  z: number;
  w: number;
  bottom: number;
  top: number;
  /** Superellipse exponent: 2 an ellipse, higher boxier. */
  n?: number;
}

/**
 * A fuselage lofted through superellipse sections (nose to tail), split into the
 * painted shell and its windows (`glass` picks the faces by their centre), both open
 * at no end (capped).
 */
function loft(
  sections: Section[],
  colour: (p: Vector3) => RGB,
  glass: (p: Vector3) => boolean,
  around = 28,
): { shell: BufferGeometry; glass: BufferGeometry } {
  const rings = sections.map((s) => {
    const n = s.n ?? 2.6;
    const mid = (s.bottom + s.top) / 2;
    const half = (s.top - s.bottom) / 2;
    const ring: Vector3[] = [];
    for (let i = 0; i < around; i++) {
      const a = (i / around) * Math.PI * 2;
      const c = Math.cos(a);
      const si = Math.sin(a);
      ring.push(
        new Vector3(
          s.w * Math.sign(c) * Math.abs(c) ** (2 / n),
          mid + half * Math.sign(si) * Math.abs(si) ** (2 / n),
          s.z,
        ),
      );
    }
    return ring;
  });
  const shell: number[] = [];
  const shellColour: number[] = [];
  const pane: number[] = [];
  const centre = new Vector3();
  const tri = (a: Vector3, b: Vector3, c: Vector3) => {
    centre.copy(a).add(b).add(c).divideScalar(3);
    if (glass(centre)) {
      pane.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      return;
    }
    shell.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    const rgb = colour(centre);
    for (let k = 0; k < 3; k++) shellColour.push(...rgb);
  };
  for (let k = 0; k < rings.length - 1; k++) {
    const r0 = rings[k]!;
    const r1 = rings[k + 1]!;
    for (let i = 0; i < around; i++) {
      const j = (i + 1) % around;
      // Sections run nose (-z) to tail: wound to face outward.
      tri(r0[i]!, r0[j]!, r1[i]!);
      tri(r0[j]!, r1[j]!, r1[i]!);
    }
  }
  const first = rings[0]!;
  const last = rings[rings.length - 1]!;
  const c0 = first.reduce((a, p) => a.add(p), new Vector3()).divideScalar(around);
  const c1 = last.reduce((a, p) => a.add(p), new Vector3()).divideScalar(around);
  for (let i = 0; i < around; i++) {
    const j = (i + 1) % around;
    tri(c0, first[j]!, first[i]!);
    tri(c1, last[i]!, last[j]!);
  }
  const build = (positions: number[], colours?: number[]) => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    if (colours) g.setAttribute('color', new BufferAttribute(new Float32Array(colours), 3));
    g.computeVertexNormals();
    return g;
  };
  return { shell: build(shell, shellColour), glass: build(pane) };
}

/** Connect two closed rings of points (same count) into a solid, capped both ends. */
function bridge(a: Vector3[], b: Vector3[], colour: RGB): BufferGeometry {
  const positions: number[] = [];
  const push = (...ps: Vector3[]) => ps.forEach((p) => positions.push(p.x, p.y, p.z));
  const n = a.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    push(a[i]!, b[i]!, a[j]!, a[j]!, b[i]!, b[j]!);
  }
  const ca = a.reduce((s, p) => s.add(p), new Vector3()).divideScalar(n);
  const cb = b.reduce((s, p) => s.add(p), new Vector3()).divideScalar(n);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    push(ca, a[j]!, a[i]!, cb, b[i]!, b[j]!);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.computeVertexNormals();
  return part(g, colour, [0, 0, 0]);
}

/**
 * An aerofoil's outline (NACA-ish 12–15 % thick), chord along +z from the leading edge,
 * thickness along `up`, placed at `at`.
 */
function aerofoil(
  chord: number,
  thickness: number,
  at: Vector3,
  up: Vector3 = new Vector3(0, 1, 0),
  steps = 9,
): Vector3[] {
  const pts: Vector3[] = [];
  const half = (x: number) =>
    5 *
    thickness *
    (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
  for (let i = 0; i <= steps; i++) {
    const x = (1 - Math.cos((i / steps) * Math.PI)) / 2;
    pts.push(
      at
        .clone()
        .add(new Vector3(0, 0, x * chord))
        .addScaledVector(up, half(x) * chord),
    );
  }
  for (let i = steps - 1; i > 0; i--) {
    const x = (1 - Math.cos((i / steps) * Math.PI)) / 2;
    pts.push(
      at
        .clone()
        .add(new Vector3(0, 0, x * chord))
        .addScaledVector(up, -half(x) * chord),
    );
  }
  return pts;
}

/** A wheel (tyre and hub) turned to roll along z. */
function wheel(radius: number, width: number, at: [number, number, number]): BufferGeometry[] {
  return [
    part(new CylinderGeometry(radius, radius, width, 16), TYRE, at, [0, 0, Math.PI / 2]),
    part(new CylinderGeometry(radius * 0.45, radius * 0.45, width * 1.08, 10), METAL, at, [
      0,
      0,
      Math.PI / 2,
    ]),
  ];
}

/** A ski under a wheel (wheel-skis): flat, with an upturned tip; `y` is its base. */
function ski(length: number, width: number, x: number, y: number, z: number): BufferGeometry[] {
  const flat = length * 0.82;
  return [
    part(new BoxGeometry(width, 0.06, flat), SKI, [x, y + 0.03, z + (length - flat) / 2]),
    part(
      new BoxGeometry(width, 0.05, length - flat + 0.05),
      SKI,
      [x, y + 0.1, z - flat / 2 + 0.02 - (length - flat) / 2 + 0.04],
      [0.45, 0, 0],
    ),
  ];
}

/** Lights: steady navigation lights, flashing strobes and a rotating beacon. */
export interface AircraftLights {
  nav: Mesh;
  strobes: Mesh;
  beacon: Mesh;
}

export interface AircraftParts {
  /** Whole aircraft: place it at its ground reference (main gear or skids, on the snow). */
  root: Group;
  /** The pilot sits in this frame (its origin is the cabin floor under their seat). */
  seat: Group;
  /** Spinning parts: the propeller or main rotor (about its own y axis), and a tail rotor. */
  rotor: Group;
  tailRotor: Group | null;
  /** Blades and blur disc of the main rotor/prop: the blur fades in as it spins up. */
  blades: Mesh;
  blur: Mesh;
  tailBlur: Mesh | null;
  lights: AircraftLights;
  /** Pilot's eye in the root frame (cockpit view). */
  eye: Vector3;
  /** Pilot's seated pose: hips above the floor, behind the feet, and hands on the controls. */
  pilot: { hipHeight: number; hipBack: number; feet: number; grip: Vector3 };
}

const paint = () =>
  new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.4, side: DoubleSide });
const glassMaterial = () =>
  new MeshStandardNodeMaterial({
    color: 0x1d2c3a,
    roughness: 0.05,
    metalness: 0.4,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
    side: DoubleSide,
  });
const blurMaterial = () =>
  new MeshStandardNodeMaterial({
    color: 0x2a2d32,
    roughness: 0.6,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: DoubleSide,
  });

/** Small glowing spheres merged into one mesh (unlit, so they show at night). */
function lamps(points: { at: [number, number, number]; colour: RGB; r?: number }[]): Mesh {
  const g = merge(
    points.map(({ at, colour, r }) => part(new SphereGeometry(r ?? 0.07, 8, 6), colour, at)),
  );
  return new Mesh(g, new MeshBasicNodeMaterial({ vertexColors: true }));
}

/** Pilatus PC-6 Porter on wheel-skis: high strut-braced wing, long turboprop nose, tailwheel. */
export function createPlane(type: PlaneType = PC6): AircraftParts {
  const span = type.span;
  const hub = type.geometry.propHub;
  const tailArm = type.ground.tailArm;
  const tailY = tailArm * Math.tan(type.ground.threePoint);
  const wingY = type.geometry.wingY;
  const root = new Group();
  root.name = type.id;
  const material = paint();

  // Fuselage: the long cowling round the PT6, the boxy cabin under the wing, a tapering
  // tail cone. Body: -z forward, the main gear's contact point at the origin.
  const sections: Section[] = [
    { z: -3.28, w: 0.26, bottom: hub[0] - 0.26, top: hub[0] + 0.26, n: 2 },
    { z: -3.05, w: 0.38, bottom: hub[0] - 0.4, top: hub[0] + 0.36, n: 2.3 },
    { z: -2.5, w: 0.44, bottom: hub[0] - 0.5, top: hub[0] + 0.42 },
    { z: -1.5, w: 0.54, bottom: 1.12, top: 2.14 },
    { z: -1.05, w: 0.62, bottom: 1.06, top: 2.42 },
    { z: -0.6, w: 0.65, bottom: 1.03, top: wingY - 0.06, n: 3.2 },
    { z: 1.1, w: 0.65, bottom: 1.03, top: wingY - 0.04, n: 3.2 },
    { z: 2.4, w: 0.6, bottom: 1.12, top: wingY - 0.12, n: 3 },
    { z: 4.0, w: 0.42, bottom: 1.4, top: 2.5 },
    { z: 5.8, w: 0.26, bottom: 1.62, top: 2.33 },
    { z: 7.25, w: 0.12, bottom: tailY + 0.45, top: 2.18 },
    { z: 7.5, w: 0.05, bottom: tailY + 0.62, top: 2.08 },
  ];
  const isWindow = (p: Vector3) => {
    // Windscreen over the nose, and side windows along the cabin.
    if (p.z > -1.5 && p.z < -0.55 && p.y > 2.12) return true;
    const side = Math.abs(p.x) > 0.45;
    if (side && p.y > 1.85 && p.y < wingY - 0.18 && p.z > -0.95 && p.z < 1.55) return true;
    return false;
  };
  const fuselage = loft(
    sections,
    (p) => {
      if (p.z < -1.5 && p.y > hub[0] + 0.25) return DARK; // anti-glare panel on the nose
      if (p.y > 1.52 && p.y < 1.66 && p.z > -3.0) return RED; // cheatline
      if (p.y < 1.2) return [0.75, 0.77, 0.79];
      return WHITE;
    },
    isWindow,
  );

  const parts: BufferGeometry[] = [fuselage.shell];
  // Wing: constant chord, slight dihedral, the H4's upturned tips.
  const chord = type.wingArea / span;
  const lead = -0.85;
  for (const side of [-1, 1]) {
    const rootRing = aerofoil(chord, 0.15, new Vector3(side * 0.62, wingY, lead));
    const tipRing = aerofoil(
      chord * 0.98,
      0.13,
      new Vector3(side * (span / 2 - 0.35), wingY + 0.16, lead + 0.02),
    );
    parts.push(bridge(rootRing, tipRing, WHITE));
    // Upturned tip.
    const top = aerofoil(
      chord * 0.8,
      0.1,
      new Vector3(side * (span / 2), wingY + 0.4, lead + 0.18),
    );
    parts.push(bridge(tipRing, top, RED));
    // Strut from the fuselage's belly to a third of the way out, with a jury strut.
    const foot = new Vector3(side * 0.6, 1.2, 0.05);
    const head = new Vector3(side * 4.5, wingY + 0.04, lead + 0.75);
    parts.push(rod(foot, head, 0.05, WHITE));
    parts.push(
      rod(foot.clone().lerp(head, 0.55), new Vector3(side * 2.6, wingY, lead + 0.75), 0.025, GREY),
    );
    // Main gear: a long-travel leg out to the wheel-ski, braced back.
    const axle = new Vector3(side * type.ground.track * 0.5, 0.36, 0);
    parts.push(rod(new Vector3(side * 0.58, 1.12, -0.25), axle, 0.06, GREY));
    parts.push(rod(new Vector3(side * 0.58, 1.1, 0.55), axle, 0.04, GREY));
    parts.push(...wheel(0.32, 0.2, [axle.x, axle.y, axle.z]));
    parts.push(...ski(2.1, 0.34, axle.x, 0, axle.z - 0.15));
    // Exhaust stacks on the cowling's sides.
    parts.push(
      part(
        new CylinderGeometry(0.07, 0.08, 0.28, 10),
        DARK,
        [side * 0.46, hub[0] - 0.05, -2.75],
        [0, 0, (side * Math.PI) / 2.6],
      ),
    );
  }
  // Cabin floor and seats for the pilot to sit in.
  parts.push(part(new BoxGeometry(1.1, 0.04, 2.6), INTERIOR, [0, 1.13, 0.2]));
  for (const x of [-0.32, 0.32]) {
    parts.push(part(new BoxGeometry(0.46, 0.08, 0.48), INTERIOR, [x, 1.56, -0.16]));
    parts.push(part(new BoxGeometry(0.46, 0.62, 0.08), INTERIOR, [x, 1.86, 0.1], [-0.18, 0, 0]));
  }
  // Instrument panel under a slim glareshield.
  parts.push(part(new BoxGeometry(1.0, 0.24, 0.04), INTERIOR, [0, 1.8, -1.14], [0.25, 0, 0]));
  parts.push(part(new BoxGeometry(1.0, 0.025, 0.12), DARK, [0, 1.93, -1.2]));
  // Tailplane, fin and rudder, tailwheel on its spring with a small ski.
  for (const side of [-1, 1]) {
    parts.push(
      bridge(
        aerofoil(1.25, 0.1, new Vector3(side * 0.12, 2.05, 6.25)),
        aerofoil(0.9, 0.08, new Vector3(side * 2.85, 2.05, 6.55)),
        WHITE,
      ),
    );
  }
  const across = new Vector3(1, 0, 0);
  const finRoot = aerofoil(1.65, 0.1, new Vector3(0, 2.1, 5.95), across).map((p) => p);
  const finTop = aerofoil(0.95, 0.08, new Vector3(0, 3.95, 6.7), across);
  parts.push(bridge(finRoot, finTop, RED));
  parts.push(
    rod(new Vector3(0, tailY + 0.62, 7.1), new Vector3(0, tailY + 0.16, tailArm), 0.035, DARK),
  );
  parts.push(...wheel(0.15, 0.09, [0, tailY + 0.15, tailArm]));
  parts.push(...ski(0.6, 0.14, 0, tailY, tailArm - 0.05));
  // Spinner.
  parts.push(
    part(new ConeGeometry(0.24, 0.38, 16), DARK, [0, hub[0], hub[1] - 0.19], [-Math.PI / 2, 0, 0]),
  );

  const body = new Mesh(merge(parts), material);
  body.castShadow = true;
  root.add(body);
  const glass = new Mesh(fuselage.glass, glassMaterial());
  root.add(glass);

  // Propeller: three blades about the hub (its local y is the shaft, along -z).
  const rotor = new Group();
  rotor.position.set(0, hub[0], hub[1]);
  rotor.rotation.x = Math.PI / 2;
  const r = type.engine.propDiameter / 2;
  const bladeParts: BufferGeometry[] = [];
  for (let i = 0; i < type.engine.blades; i++) {
    const a = (i / type.engine.blades) * Math.PI * 2;
    const g = new BoxGeometry(r - 0.18, 0.025, 0.2);
    g.translate((r - 0.18) / 2 + 0.18, 0, 0);
    g.rotateX(0.35); // blade pitch
    g.rotateY(a);
    bladeParts.push(part(g, BLADE, [0, 0, 0]));
    const tip = new BoxGeometry(0.12, 0.03, 0.2);
    tip.translate(r - 0.06, 0, 0);
    tip.rotateX(0.35);
    tip.rotateY(a);
    bladeParts.push(part(tip, TIP, [0, 0, 0]));
  }
  const blades = new Mesh(merge(bladeParts), material);
  blades.castShadow = true;
  rotor.add(blades);
  const blur = new Mesh(new CircleGeometry(r, 32).rotateX(-Math.PI / 2), blurMaterial());
  rotor.add(blur);
  root.add(rotor);

  const lights: AircraftLights = {
    nav: lamps([
      { at: [-span / 2, wingY + 0.38, lead + 0.4], colour: [3, 0.1, 0.08] },
      { at: [span / 2, wingY + 0.38, lead + 0.4], colour: [0.1, 3, 0.3] },
      { at: [0, 2.1, 7.52], colour: [3, 3, 3] },
    ]),
    strobes: lamps([
      { at: [-span / 2, wingY + 0.33, lead + 0.6], colour: [4, 4, 4], r: 0.06 },
      { at: [span / 2, wingY + 0.33, lead + 0.6], colour: [4, 4, 4], r: 0.06 },
    ]),
    beacon: lamps([
      { at: [0, 3.98, 7.1], colour: [4, 0.2, 0.1], r: 0.08 },
      { at: [0, 1.0, 1.0], colour: [4, 0.2, 0.1], r: 0.08 },
    ]),
  };
  root.add(lights.nav, lights.strobes, lights.beacon);

  // Pilot in the left front seat.
  const seat = new Group();
  seat.position.set(-0.32, 1.15, -0.62);
  root.add(seat);
  return {
    root,
    seat,
    rotor,
    tailRotor: null,
    blades,
    blur,
    tailBlur: null,
    lights,
    eye: new Vector3(-0.32, 2.34, -0.42),
    pilot: { hipHeight: 0.46, hipBack: 0.46, feet: 0, grip: new Vector3(0.14, 0.62, -0.08) },
  };
}

/**
 * Airbus H125 / AS350 Écureuil: the rounded cabin with its big bubble windscreen, the
 * engine and gearbox hump, a three-blade Starflex rotor, a slim tail boom to the fin with
 * its two-blade tail rotor on the left, and skids. Red with a white flash.
 */
export function createHelicopter(type: HeliType = H125): AircraftParts {
  const root = new Group();
  root.name = type.id;
  const material = paint();
  const R = type.rotorRadius;
  const hubY = type.ground.hub;
  const tailZ = type.length - R - type.tailRadius;
  const sections: Section[] = [
    { z: -3.05, w: 0.18, bottom: 1.0, top: 1.25, n: 2 },
    { z: -2.85, w: 0.6, bottom: 0.72, top: 1.6, n: 2.2 },
    { z: -2.3, w: 0.86, bottom: 0.6, top: 2.0, n: 2.3 },
    { z: -1.3, w: 0.93, bottom: 0.56, top: 2.12, n: 2.6 },
    { z: 0.3, w: 0.92, bottom: 0.56, top: 2.12, n: 2.8 },
    { z: 1.25, w: 0.8, bottom: 0.66, top: 2.02, n: 2.6 },
    { z: 1.9, w: 0.42, bottom: 1.18, top: 1.92, n: 2.2 },
    { z: 2.6, w: 0.22, bottom: 1.38, top: 1.82, n: 2 },
    { z: tailZ - 0.3, w: 0.12, bottom: 1.72, top: 1.98, n: 2 },
    { z: tailZ + 0.7, w: 0.07, bottom: 1.86, top: 2.0, n: 2 },
  ];
  const cabin = loft(
    sections,
    (p) => {
      if (p.z < 1.0 && p.y > 1.15 && p.y < 1.3) return WHITE;
      if (p.y < 0.75) return [0.32, 0.34, 0.36];
      return RED;
    },
    (p) => {
      // The bubble forward of the doors above the floor line (a centre post and the roof
      // over the seats stay shell), and the door windows.
      if (p.z < -1.55 && p.y > 0.8 && Math.abs(p.x) > 0.1 && (p.y < 1.85 || p.z < -2.25)) {
        return true;
      }
      return Math.abs(p.x) > 0.6 && p.y > 1.32 && p.y < 2.0 && p.z > -1.45 && p.z < 0.55;
    },
  );
  const parts: BufferGeometry[] = [cabin.shell];
  // Engine and gearbox hump, mast and Starflex hub.
  parts.push(part(new BoxGeometry(1.0, 0.45, 2.6), RED, [0, 2.3, 0.6]));
  parts.push(
    part(new CylinderGeometry(0.5, 0.5, 2.6, 14), RED, [0, 2.48, 0.6], [Math.PI / 2, 0, 0]),
  );
  parts.push(
    part(new CylinderGeometry(0.28, 0.3, 0.5, 12), DARK, [0, 2.86, 2.0], [Math.PI / 2, 0, 0]),
  );
  parts.push(
    part(new CylinderGeometry(0.1, 0.12, hubY - 2.7, 10), METAL, [0, (hubY + 2.7) / 2, 0]),
  );
  parts.push(part(new CylinderGeometry(0.34, 0.28, 0.16, 12), DARK, [0, hubY, 0]));
  // Skids and cross tubes.
  const g = type.ground;
  for (const side of [-1, 1]) {
    const x = side * g.skidHalf;
    parts.push(
      rod(new Vector3(x, 0.06, g.skidBack), new Vector3(x, 0.06, -g.skidFront), 0.05, METAL),
    );
    parts.push(
      rod(
        new Vector3(x, 0.06, -g.skidFront),
        new Vector3(x, 0.32, -g.skidFront - 0.35),
        0.05,
        METAL,
      ),
    );
    for (const z of [-0.85, 0.75]) {
      parts.push(rod(new Vector3(x, 0.06, z), new Vector3(side * 0.7, 0.6, z), 0.045, METAL));
    }
  }
  for (const z of [-0.85, 0.75])
    parts.push(rod(new Vector3(-0.7, 0.6, z), new Vector3(0.7, 0.6, z), 0.045, METAL));
  // Horizontal stabiliser with its endplate fins; the fin; the tail rotor's gearbox.
  for (const side of [-1, 1]) {
    parts.push(
      bridge(
        aerofoil(0.55, 0.12, new Vector3(side * 0.1, 1.8, tailZ - 1.4)),
        aerofoil(0.5, 0.12, new Vector3(side * 1.05, 1.8, tailZ - 1.38)),
        RED,
      ),
    );
    parts.push(part(new BoxGeometry(0.04, 0.55, 0.5), RED, [side * 1.06, 1.85, tailZ - 1.15]));
  }
  const across = new Vector3(1, 0, 0);
  parts.push(
    bridge(
      aerofoil(1.1, 0.12, new Vector3(0, 1.98, tailZ - 0.55), across),
      aerofoil(0.55, 0.1, new Vector3(0, 3.0, tailZ + 0.15), across),
      RED,
    ),
  );
  parts.push(
    bridge(
      aerofoil(0.6, 0.12, new Vector3(0, 1.85, tailZ - 0.35), across),
      aerofoil(0.4, 0.1, new Vector3(0, 1.25, tailZ - 0.05), across),
      RED,
    ),
  );
  parts.push(
    part(new CylinderGeometry(0.1, 0.1, 0.3, 10), DARK, [-0.18, 2.1, tailZ], [0, 0, Math.PI / 2]),
  );
  // Inside: floor, two front seats, instrument panel.
  parts.push(part(new BoxGeometry(1.6, 0.04, 2.6), INTERIOR, [0, 0.66, -0.6]));
  for (const x of [-0.45, 0.45]) {
    parts.push(part(new BoxGeometry(0.5, 0.1, 0.5), INTERIOR, [x, 1.08, -1.05]));
    parts.push(part(new BoxGeometry(0.5, 0.7, 0.08), INTERIOR, [x, 1.45, -0.78], [-0.12, 0, 0]));
  }
  // Low instrument panel on a central console: the bubble's all view.
  parts.push(part(new BoxGeometry(1.0, 0.18, 0.05), INTERIOR, [0, 1.25, -2.2], [0.4, 0, 0]));
  parts.push(part(new BoxGeometry(0.28, 0.5, 0.45), INTERIOR, [0, 0.92, -1.9]));

  const body = new Mesh(merge(parts), material);
  body.castShadow = true;
  root.add(body);
  root.add(new Mesh(cabin.glass, glassMaterial()));

  // Main rotor: three blades, spinning anticlockwise seen from above (Airbus rotors turn clockwise; drawn either way at speed).
  const rotor = new Group();
  rotor.position.set(0, hubY + 0.05, 0);
  const bladeParts: BufferGeometry[] = [];
  for (let i = 0; i < type.blades; i++) {
    const a = (i / type.blades) * Math.PI * 2;
    const blade = new BoxGeometry(R - 0.3, 0.05, 0.35);
    blade.translate((R - 0.3) / 2 + 0.3, 0, 0);
    blade.rotateX(0.06);
    blade.rotateY(a);
    bladeParts.push(part(blade, BLADE, [0, 0, 0]));
    const tip = new BoxGeometry(0.25, 0.055, 0.35);
    tip.translate(R - 0.125, 0, 0);
    tip.rotateY(a);
    bladeParts.push(part(tip, TIP, [0, 0, 0]));
  }
  const blades = new Mesh(merge(bladeParts), material);
  blades.castShadow = true;
  rotor.add(blades);
  const blur = new Mesh(new CircleGeometry(R, 48).rotateX(-Math.PI / 2), blurMaterial());
  rotor.add(blur);
  root.add(rotor);

  // Tail rotor: on the left of the fin, spinning about the body's x axis.
  const tailRotor = new Group();
  tailRotor.position.set(-0.36, 2.1, tailZ);
  tailRotor.rotation.order = 'ZYX'; // spin (y) first, then turned to face sideways
  tailRotor.rotation.z = Math.PI / 2;
  const tr = type.tailRadius;
  const tailBlades = new BoxGeometry(tr * 2, 0.03, 0.18);
  const tailMesh = new Mesh(merge([part(tailBlades, BLADE, [0, 0, 0])]), material);
  tailRotor.add(tailMesh);
  const tailBlur = new Mesh(new CircleGeometry(tr, 24).rotateX(-Math.PI / 2), blurMaterial());
  tailRotor.add(tailBlur);
  root.add(tailRotor);

  const lights: AircraftLights = {
    nav: lamps([
      { at: [-1.08, 2.14, tailZ - 1.15], colour: [3, 0.1, 0.08] },
      { at: [1.08, 2.14, tailZ - 1.15], colour: [0.1, 3, 0.3] },
      { at: [0, 2.0, tailZ + 0.75], colour: [3, 3, 3] },
    ]),
    strobes: lamps([{ at: [0, 3.02, tailZ + 0.15], colour: [4, 4, 4], r: 0.07 }]),
    beacon: lamps([
      { at: [0, 2.78, 1.75], colour: [4, 0.2, 0.1], r: 0.08 },
      { at: [0, 0.52, -0.2], colour: [4, 0.2, 0.1], r: 0.08 },
    ]),
  };
  root.add(lights.nav, lights.strobes, lights.beacon);

  // Pilot: front right, as in the AS350.
  const seat = new Group();
  seat.position.set(0.45, 0.68, -1.55);
  root.add(seat);
  return {
    root,
    seat,
    rotor,
    tailRotor,
    blades,
    blur,
    tailBlur,
    lights,
    eye: new Vector3(0.45, 1.88, -1.32),
    pilot: { hipHeight: 0.44, hipBack: 0.5, feet: 0, grip: new Vector3(0.18, 0.45, 0.02) },
  };
}

/** The model for a type. */
export function createAircraft(type: PlaneType | HeliType): AircraftParts {
  return type.kind === 'plane' ? createPlane(type) : createHelicopter(type);
}

/**
 * Spin the prop or rotors (`rpm` 0..1 of governed) by `dt`, fading the blades into their
 * blur disc as they speed up (a real prop aliases at any frame rate). Flash the lights:
 * strobes double-flash each second and a half, the beacon pulses; all off when parked.
 */
export function animateAircraft(
  parts: AircraftParts,
  type: PlaneType | HeliType,
  rpm: number,
  time: number,
  dt: number,
  lightsOn: boolean,
): void {
  const revs = type.kind === 'plane' ? type.engine.rpm : type.rpm;
  // Drawn slower than real: at real revs the blades would strobe.
  const drawn = Math.min(revs, type.kind === 'plane' ? 1300 : 300);
  parts.rotor.rotation.y -=
    ((drawn * rpm) / 60) * Math.PI * 2 * dt * (type.kind === 'plane' ? 1 : -1);
  if (parts.tailRotor) parts.tailRotor.rotation.y += 9 * rpm * Math.PI * 2 * dt;
  const blur = Math.min(1, Math.max(0, (rpm - 0.25) / 0.5));
  (parts.blur.material as MeshStandardNodeMaterial).opacity = 0.28 * blur;
  if (parts.tailBlur) (parts.tailBlur.material as MeshStandardNodeMaterial).opacity = 0.32 * blur;
  parts.blades.visible = blur < 0.95 || type.kind === 'heli';
  const l = parts.lights;
  l.nav.visible = lightsOn;
  const strobe = time % 1.5;
  l.strobes.visible = lightsOn && (strobe < 0.05 || (strobe > 0.15 && strobe < 0.2));
  l.beacon.visible = lightsOn && time % 1 < 0.12;
}
