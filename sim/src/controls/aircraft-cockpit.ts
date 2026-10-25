import {
  BoxGeometry,
  type BufferGeometry,
  CanvasTexture,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  PlaneGeometry,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
} from 'three/webgpu';

import { merge, part, type RGB } from './snowmobile-model';

/**
 * Cockpits as data, one per aircraft type (`COCKPITS`, by type id), and the parts of them
 * only the pilot sees (`createCockpit`): the instrument face, its gauges drawn live on a
 * canvas from the flight state, the controls moving with the input, the pilot's gloved
 * hands on them, and fittings (overhead panel, quadrant). Positions are in the aircraft's
 * frame (m, -z forward, the ground reference at the origin), like `aircraft-model.ts`.
 */

export type GaugeKind =
  'airspeed' | 'attitude' | 'altimeter' | 'vsi' | 'heading' | 'power' | 'rotor' | 'flaps';

type V3 = [number, number, number];

export interface CockpitSpec {
  /** The instrument panel: centre, size and how far it leans back toward the pilot (rad). */
  panel: { centre: V3; width: number; height: number; tilt: number };
  /** Gauges on it: where (m from the panel's centre, x right, y up) and their radius (m). */
  gauges: { kind: GaugeKind; x: number; y: number }[];
  dial: number;
  /** Stick (plane) or cyclic (heli): its pivot on the floor and length to the grip. */
  stick: { pivot: V3; length: number };
  /** Power lever (plane, pushed forward for power) or collective (heli, raised beside the seat). */
  power: { pivot: V3; length: number; kind: 'lever' | 'collective' };
  /** Flap lever beside the power lever (plane). */
  flaps?: { pivot: V3; length: number };
  /** Rudder pedals: midway between them, and half their spacing. */
  pedals: { at: V3; spread: number };
  /** Static fittings: a quadrant under the levers, an overhead panel (heli), a compass. */
  quadrant?: { centre: V3; size: V3 };
  overhead?: { centre: V3; size: V3 };
  compass?: V3;
}

/** Pilatus PC-6: left seat, stick between the knees, power and flap levers on a quadrant to the left of the panel's foot. */
const PC6_COCKPIT: CockpitSpec = {
  panel: { centre: [0, 1.88, -1.3], width: 1.04, height: 0.34, tilt: 0.2 },
  dial: 0.066,
  gauges: [
    { kind: 'airspeed', x: -0.45, y: 0.08 },
    { kind: 'attitude', x: -0.31, y: 0.08 },
    { kind: 'altimeter', x: -0.17, y: 0.08 },
    { kind: 'power', x: -0.45, y: -0.08 },
    { kind: 'heading', x: -0.31, y: -0.08 },
    { kind: 'vsi', x: -0.17, y: -0.08 },
    { kind: 'rotor', x: 0.05, y: 0.08 },
    { kind: 'flaps', x: 0.05, y: -0.08 },
  ],
  stick: { pivot: [-0.32, 1.17, -0.88], length: 0.56 },
  power: { pivot: [-0.02, 1.58, -1.14], length: 0.2, kind: 'lever' },
  flaps: { pivot: [0.06, 1.58, -1.14], length: 0.16 },
  pedals: { at: [-0.32, 1.17, -0.78], spread: 0.16 },
  quadrant: { centre: [0.02, 1.56, -1.16], size: [0.2, 0.08, 0.2] },
  compass: [0, 2.11, -1.36],
};

/** Airbus H125: right seat, cyclic between the knees, collective beside the seat on the left, an overhead panel along the roof beam. */
const H125_COCKPIT: CockpitSpec = {
  panel: { centre: [0, 1.18, -2.08], width: 1.1, height: 0.3, tilt: 0.5 },
  dial: 0.058,
  gauges: [
    { kind: 'airspeed', x: 0.17, y: 0.07 },
    { kind: 'attitude', x: 0.3, y: 0.07 },
    { kind: 'altimeter', x: 0.43, y: 0.07 },
    { kind: 'power', x: 0.17, y: -0.07 },
    { kind: 'heading', x: 0.3, y: -0.07 },
    { kind: 'vsi', x: 0.43, y: -0.07 },
    { kind: 'rotor', x: 0.0, y: 0.07 },
  ],
  stick: { pivot: [0.45, 0.7, -1.62], length: 0.62 },
  power: { pivot: [0.12, 0.8, -1.05], length: 0.55, kind: 'collective' },
  pedals: { at: [0.45, 0.7, -1.72], spread: 0.16 },
  overhead: { centre: [0, 2.07, -1.55], size: [0.22, 0.04, 0.55] },
};

export const COCKPITS: Record<string, CockpitSpec> = { pc6: PC6_COCKPIT, h125: H125_COCKPIT };

/** What the gauges and controls show (the controls as the pilot's inputs, -1..1). */
export interface CockpitState {
  /** True airspeed (m/s), altitude (m), vertical speed (m/s). */
  airspeed: number;
  altitude: number;
  vertical: number;
  /** Nose up (rad), right wing down (rad), heading (deg clockwise from north). */
  pitch: number;
  roll: number;
  heading: number;
  /** Power lever (plane, -1 reverse … 1) or torque share (heli, 0..1+). */
  power: number;
  /** Prop or rotor revs, 0..1. */
  rpm: number;
  /** Flap position 0..2 (plane). */
  flaps: number;
  /** Stick or cyclic: right (+) and back (+); pedals right (+); collective up (+). */
  stickX: number;
  stickY: number;
  pedal: number;
  collective: number;
}

const TAU = Math.PI * 2;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Needle angles (rad, clockwise from 12 o'clock) for each gauge, from the state:
 * airspeed 0–300 km/h round 300°; altimeter hundreds (a turn per 1,000 m) and thousands
 * (a turn per 10,000 m); vertical speed ±10 m/s either side of 9 o'clock; torque or
 * power 0–120 % and revs 0–110 % round 270°.
 */
export const needle = {
  airspeed: (mps: number) => (-150 + (clamp(mps * 3.6, 0, 300) / 300) * 300) * (Math.PI / 180),
  altimeter: (m: number) => ({
    hundreds: ((((m % 1000) + 1000) % 1000) / 1000) * TAU,
    thousands: ((((m % 10000) + 10000) % 10000) / 10000) * TAU,
  }),
  vsi: (mps: number) => -Math.PI / 2 + (clamp(mps, -10, 10) / 10) * ((170 * Math.PI) / 180),
  power: (share: number) => (-135 + (clamp(share, 0, 1.2) / 1.2) * 270) * (Math.PI / 180),
  rotor: (share: number) => (-135 + (clamp(share, 0, 1.1) / 1.1) * 270) * (Math.PI / 180),
};

const GLOVE: RGB = [0.13, 0.14, 0.16];
const CUFF: RGB = [0.08, 0.2, 0.3];
const BLACK: RGB = [0.04, 0.04, 0.05];
const GRIP: RGB = [0.1, 0.1, 0.11];
const METAL: RGB = [0.5, 0.52, 0.55];
const FITTING: RGB = [0.2, 0.21, 0.23];
const LIGHT: RGB = [0.75, 0.75, 0.7];
const PEDAL: RGB = [0.3, 0.31, 0.33];

/** A gloved hand gripping something at the origin, the wrist toward +z (the pilot). */
function hand(): BufferGeometry[] {
  const fist = new SphereGeometry(0.045, 10, 8);
  fist.scale(1, 1.15, 1.2);
  return [
    part(fist, GLOVE, [0, 0, 0.01]),
    part(new CylinderGeometry(0.04, 0.042, 0.1, 10), CUFF, [0, -0.03, 0.08], [1.1, 0, 0]),
  ];
}

/** A lever from its pivot (origin) up `length`, with a knob or grip on top. */
function lever(length: number, knob: RGB, grip: 'knob' | 'stick' | 'collective'): Group {
  const g = new Group();
  const geos: BufferGeometry[] = [];
  if (grip === 'collective') {
    // Along -z (forward) from the pivot beside the seat, a twist grip at its end.
    geos.push(
      part(
        new CylinderGeometry(0.018, 0.022, length, 10),
        METAL,
        [0, 0, -length / 2],
        [Math.PI / 2, 0, 0],
      ),
    );
    geos.push(
      part(new CylinderGeometry(0.03, 0.03, 0.14, 12), GRIP, [0, 0, -length], [Math.PI / 2, 0, 0]),
    );
    geos.push(part(new BoxGeometry(0.07, 0.05, 0.07), BLACK, [0, 0.02, -length - 0.07]));
  } else {
    geos.push(part(new CylinderGeometry(0.014, 0.018, length, 10), METAL, [0, length / 2, 0]));
    if (grip === 'stick') {
      geos.push(part(new CylinderGeometry(0.026, 0.024, 0.13, 12), GRIP, [0, length + 0.05, 0]));
      geos.push(part(new BoxGeometry(0.012, 0.02, 0.012), knob, [0, length + 0.125, -0.012]));
    } else {
      geos.push(part(new SphereGeometry(0.022, 10, 8), knob, [0, length, 0]));
    }
  }
  g.userData.geos = geos;
  return g;
}

export interface Cockpit {
  root: Group;
  /** Draw the gauges and move the controls to this state (redrawn ~15 times a second). */
  update(dt: number, state: CockpitState): void;
}

/**
 * The pilot's-eye parts of a cockpit: drawn only in the cockpit view. A handful of draw
 * calls: the fittings, the instrument face, the stick, the power (or collective) and
 * flap levers, and the two pedals.
 */
export function createCockpit(spec: CockpitSpec): Cockpit {
  const root = new Group();
  root.name = 'cockpit';
  root.visible = false;
  const material = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.55 });
  const add = (parent: Group, geos: BufferGeometry[]) => {
    const m = new Mesh(merge(geos), material);
    parent.add(m);
    return m;
  };

  // Fittings: quadrant, overhead panel with its switch rows, compass on the glareshield.
  const fixed: BufferGeometry[] = [];
  if (spec.quadrant)
    fixed.push(part(new BoxGeometry(...spec.quadrant.size), FITTING, spec.quadrant.centre));
  if (spec.overhead) {
    const [cx, cy, cz] = spec.overhead.centre;
    const [sx, sy, sz] = spec.overhead.size;
    fixed.push(part(new BoxGeometry(sx, sy, sz), FITTING, [cx, cy, cz]));
    for (let i = 0; i < 5; i++) {
      for (const x of [-0.06, 0, 0.06]) {
        const z = cz - sz / 2 + 0.08 + (i * (sz - 0.16)) / 4;
        fixed.push(
          part(new BoxGeometry(0.008, 0.016, 0.01), LIGHT, [cx + x, cy - sy / 2 - 0.008, z]),
        );
      }
    }
  }
  if (spec.compass) {
    fixed.push(part(new CylinderGeometry(0.04, 0.045, 0.06, 14), BLACK, spec.compass));
    fixed.push(
      part(new BoxGeometry(0.05, 0.03, 0.006), LIGHT, [
        spec.compass[0],
        spec.compass[1] + 0.005,
        spec.compass[2] + 0.04,
      ]),
    );
  }
  if (fixed.length) add(root, fixed);

  // The instrument face over the panel: one canvas, redrawn from the state.
  const p = spec.panel;
  const pxPerM = 900;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(p.width * pxPerM);
  canvas.height = Math.round(p.height * pxPerM);
  const ctx = canvas.getContext('2d')!;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  const faceGeometry = new PlaneGeometry(p.width, p.height);
  faceGeometry.rotateX(-p.tilt);
  const normal = new Vector3(0, Math.sin(p.tilt), Math.cos(p.tilt));
  faceGeometry.translate(
    p.centre[0] + normal.x * 0.028,
    p.centre[1] + normal.y * 0.028,
    p.centre[2] + normal.z * 0.028,
  );
  const face = new Mesh(faceGeometry, new MeshBasicNodeMaterial({ map: texture, color: 0xd8d8d8 }));
  face.name = 'cockpit-gauges';
  root.add(face);

  // Controls, each turning about its own pivot, with gloved hands on stick and power.
  const stick = lever(spec.stick.length, [0.8, 0.1, 0.1], 'stick');
  stick.position.set(...spec.stick.pivot);
  const stickHand = hand().map((g) => g.translate(0.02, spec.stick.length + 0.04, 0.02));
  add(stick, [...(stick.userData.geos as BufferGeometry[]), ...stickHand]);
  root.add(stick);

  const power = lever(
    spec.power.length,
    [0.85, 0.85, 0.85],
    spec.power.kind === 'collective' ? 'collective' : 'knob',
  );
  power.position.set(...spec.power.pivot);
  const powerHand =
    spec.power.kind === 'collective'
      ? hand().map((g) => g.rotateY(Math.PI / 2).translate(0.01, 0.01, -spec.power.length + 0.02))
      : hand().map((g) => g.translate(0, spec.power.length + 0.02, 0.03));
  add(power, [...(power.userData.geos as BufferGeometry[]), ...powerHand]);
  root.add(power);

  let flaps: Group | null = null;
  if (spec.flaps) {
    flaps = lever(spec.flaps.length, [0.95, 0.95, 0.95], 'knob');
    flaps.position.set(...spec.flaps.pivot);
    const knob = new BoxGeometry(0.05, 0.02, 0.03);
    add(flaps, [
      ...(flaps.userData.geos as BufferGeometry[]),
      part(knob, LIGHT, [0, spec.flaps.length, 0]),
    ]);
    root.add(flaps);
  }

  const pedals = [-1, 1].map((side) => {
    const g = new Group();
    const [x, y, z] = spec.pedals.at;
    g.position.set(x + side * spec.pedals.spread, y, z);
    add(g, [
      part(new BoxGeometry(0.09, 0.14, 0.02), PEDAL, [0, 0.12, 0], [-0.4, 0, 0]),
      part(new CylinderGeometry(0.008, 0.008, 0.2, 6), METAL, [0, 0.06, 0.04], [0.4, 0, 0]),
    ]);
    root.add(g);
    return g;
  });

  let since = Infinity;
  const draw = (s: CockpitState) => drawGauges(ctx, spec, s, pxPerM);
  return {
    root,
    update(dt, s) {
      stick.rotation.set(0.22 * s.stickY, 0, -0.22 * s.stickX, 'XZY');
      if (spec.power.kind === 'collective') power.rotation.x = 0.12 + 0.18 * s.collective;
      else power.rotation.x = -0.15 - 0.5 * Math.max(-0.4, s.power);
      if (flaps) flaps.rotation.x = 0.3 - 0.35 * s.flaps;
      pedals[0]!.position.z = spec.pedals.at[2] + 0.06 * s.pedal;
      pedals[1]!.position.z = spec.pedals.at[2] - 0.06 * s.pedal;
      since += dt;
      if (since < 1 / 15) return;
      since = 0;
      draw(s);
      texture.needsUpdate = true;
    },
  };
}

/** Every gauge on the panel's canvas, in its place. */
function drawGauges(
  ctx: CanvasRenderingContext2D,
  spec: CockpitSpec,
  s: CockpitState,
  k: number,
): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.fillStyle = '#2a2d31';
  ctx.fillRect(0, 0, w, h);
  const r = spec.dial * k;
  for (const g of spec.gauges) {
    const cx = w / 2 + g.x * k;
    const cy = h / 2 - g.y * k;
    gauge(ctx, g.kind, cx, cy, r, s);
  }
}

const LABEL = '600 13px system-ui, sans-serif';

function bezel(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  ctx.arc(cx, cy, r + 4, 0, TAU);
  ctx.fillStyle = '#7d8187';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.fillStyle = '#0a0b0c';
  ctx.fill();
}

/** Tick marks round a dial from `from` to `to` (rad clockwise from 12), `n` intervals. */
function ticks(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  from: number,
  to: number,
  n: number,
  major = 1,
): void {
  ctx.strokeStyle = '#e8e8e8';
  for (let i = 0; i <= n; i++) {
    const a = from + ((to - from) * i) / n;
    const long = i % major === 0;
    ctx.lineWidth = long ? 2.5 : 1.2;
    const inner = r * (long ? 0.78 : 0.86);
    ctx.beginPath();
    ctx.moveTo(cx + Math.sin(a) * inner, cy - Math.cos(a) * inner);
    ctx.lineTo(cx + Math.sin(a) * r * 0.95, cy - Math.cos(a) * r * 0.95);
    ctx.stroke();
  }
}

function hand2d(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  length: number,
  angle: number,
  width: number,
  colour = '#ffffff',
): void {
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - Math.sin(angle) * length * 0.15, cy + Math.cos(angle) * length * 0.15);
  ctx.lineTo(cx + Math.sin(angle) * length, cy - Math.cos(angle) * length);
  ctx.stroke();
}

function text(
  ctx: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  font = LABEL,
  colour = '#cfd3d8',
): void {
  ctx.font = font;
  ctx.fillStyle = colour;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(value, x, y);
}

function gauge(
  ctx: CanvasRenderingContext2D,
  kind: GaugeKind,
  cx: number,
  cy: number,
  r: number,
  s: CockpitState,
): void {
  if (kind === 'attitude') return attitude(ctx, cx, cy, r, s);
  if (kind === 'heading') return heading(ctx, cx, cy, r, s);
  if (kind === 'flaps') return flapGauge(ctx, cx, cy, r, s);
  bezel(ctx, cx, cy, r);
  const big = `700 ${Math.round(r * 0.3)}px system-ui, sans-serif`;
  if (kind === 'airspeed') {
    ticks(ctx, cx, cy, r, needle.airspeed(0), needle.airspeed(300 / 3.6), 30, 5);
    // The white flap arc and green normal range, as on the real thing.
    arc(ctx, cx, cy, r * 0.97, needle.airspeed(96 / 3.6), needle.airspeed(160 / 3.6), '#f2f2f2');
    arc(ctx, cx, cy, r * 0.97, needle.airspeed(107 / 3.6), needle.airspeed(232 / 3.6), '#3fbf5f');
    text(ctx, 'KM/H', cx, cy + r * 0.4);
    text(ctx, String(Math.round(s.airspeed * 3.6)), cx, cy + r * 0.12, big, '#ffffff');
    hand2d(ctx, cx, cy, r * 0.85, needle.airspeed(s.airspeed), 4);
  } else if (kind === 'altimeter') {
    ticks(ctx, cx, cy, r, 0, TAU, 50, 5);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU;
      text(
        ctx,
        String(i),
        cx + Math.sin(a) * r * 0.62,
        cy - Math.cos(a) * r * 0.62,
        `600 ${Math.round(r * 0.22)}px system-ui`,
      );
    }
    const n = needle.altimeter(s.altitude);
    hand2d(ctx, cx, cy, r * 0.5, n.thousands, 6);
    hand2d(ctx, cx, cy, r * 0.88, n.hundreds, 3);
    text(
      ctx,
      `${Math.round(s.altitude)} M`,
      cx,
      cy + r * 0.38,
      `600 ${Math.round(r * 0.18)}px system-ui`,
      '#ffffff',
    );
  } else if (kind === 'vsi') {
    ticks(ctx, cx, cy, r, needle.vsi(-10), needle.vsi(10), 20, 5);
    text(ctx, 'UP', cx - r * 0.35, cy - r * 0.42);
    text(ctx, 'DN', cx - r * 0.35, cy + r * 0.42);
    text(ctx, 'V/S M/S', cx + r * 0.25, cy);
    hand2d(ctx, cx, cy, r * 0.85, needle.vsi(s.vertical), 4);
  } else if (kind === 'power') {
    ticks(ctx, cx, cy, r, needle.power(0), needle.power(1.2), 12, 2);
    arc(ctx, cx, cy, r * 0.97, needle.power(1), needle.power(1.2), '#e04a3a');
    const reverse = s.power < -0.01;
    text(ctx, 'TRQ %', cx, cy + r * 0.4);
    text(
      ctx,
      reverse ? 'REV' : String(Math.round(Math.max(0, s.power) * 100)),
      cx,
      cy + r * 0.12,
      big,
      reverse ? '#f2b33d' : '#ffffff',
    );
    hand2d(ctx, cx, cy, r * 0.85, needle.power(Math.abs(s.power)), 4);
  } else {
    ticks(ctx, cx, cy, r, needle.rotor(0), needle.rotor(1.1), 11, 1);
    arc(ctx, cx, cy, r * 0.97, needle.rotor(0.95), needle.rotor(1.05), '#3fbf5f');
    text(ctx, 'RPM %', cx, cy + r * 0.4);
    hand2d(ctx, cx, cy, r * 0.85, needle.rotor(s.rpm), 4);
  }
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.06, 0, TAU);
  ctx.fillStyle = '#d0d0d0';
  ctx.fill();
}

function arc(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  from: number,
  to: number,
  colour: string,
): void {
  ctx.strokeStyle = colour;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(cx, cy, r, from - Math.PI / 2, to - Math.PI / 2);
  ctx.stroke();
}

/** Artificial horizon: sky over earth, rolled and pitched under a fixed aircraft symbol. */
function attitude(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  s: CockpitState,
): void {
  bezel(ctx, cx, cy, r);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.clip();
  ctx.translate(cx, cy);
  ctx.rotate(-s.roll);
  const pitchPx = (clamp(s.pitch, -0.6, 0.6) / 0.35) * r * 0.5;
  ctx.translate(0, pitchPx);
  ctx.fillStyle = '#3d8fd6';
  ctx.fillRect(-2 * r, -3 * r, 4 * r, 3 * r);
  ctx.fillStyle = '#7a4f2a';
  ctx.fillRect(-2 * r, 0, 4 * r, 3 * r);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-2 * r, 0);
  ctx.lineTo(2 * r, 0);
  for (const deg of [-20, -10, 10, 20]) {
    const y = -(deg / 20) * r * 0.5;
    const half = r * (Math.abs(deg) === 10 ? 0.18 : 0.3);
    ctx.moveTo(-half, y);
    ctx.lineTo(half, y);
  }
  ctx.stroke();
  ctx.restore();
  // The fixed aircraft: wings and a dot.
  ctx.strokeStyle = '#ffcc33';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.55, cy);
  ctx.lineTo(cx - r * 0.18, cy);
  ctx.lineTo(cx - r * 0.1, cy + r * 0.08);
  ctx.moveTo(cx + r * 0.55, cy);
  ctx.lineTo(cx + r * 0.18, cy);
  ctx.lineTo(cx + r * 0.1, cy + r * 0.08);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, TAU);
  ctx.fillStyle = '#ffcc33';
  ctx.fill();
}

/** Heading: a compass card turning under a fixed lubber line. */
function heading(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  s: CockpitState,
): void {
  bezel(ctx, cx, cy, r);
  const turn = (-s.heading * Math.PI) / 180;
  ctx.strokeStyle = '#e8e8e8';
  for (let d = 0; d < 360; d += 10) {
    const a = turn + (d * Math.PI) / 180;
    const long = d % 30 === 0;
    ctx.lineWidth = long ? 2.5 : 1.2;
    ctx.beginPath();
    ctx.moveTo(
      cx + Math.sin(a) * r * (long ? 0.78 : 0.86),
      cy - Math.cos(a) * r * (long ? 0.78 : 0.86),
    );
    ctx.lineTo(cx + Math.sin(a) * r * 0.95, cy - Math.cos(a) * r * 0.95);
    ctx.stroke();
  }
  const font = `700 ${Math.round(r * 0.24)}px system-ui`;
  ['N', 'E', 'S', 'W'].forEach((l, i) => {
    const a = turn + (i * Math.PI) / 2;
    text(
      ctx,
      l,
      cx + Math.sin(a) * r * 0.6,
      cy - Math.cos(a) * r * 0.6,
      font,
      l === 'N' ? '#f2b33d' : '#ffffff',
    );
  });
  text(
    ctx,
    String(Math.round(s.heading) % 360).padStart(3, '0'),
    cx,
    cy,
    `600 ${Math.round(r * 0.2)}px system-ui`,
    '#ffffff',
  );
  ctx.fillStyle = '#ffcc33';
  ctx.beginPath();
  ctx.moveTo(cx, cy - r * 0.97);
  ctx.lineTo(cx - 6, cy - r * 0.78);
  ctx.lineTo(cx + 6, cy - r * 0.78);
  ctx.fill();
}

/** Flaps: UP, T/O, LDG down a slot, with the flap's position marked. */
function flapGauge(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  s: CockpitState,
): void {
  ctx.fillStyle = '#0a0b0c';
  ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
  text(ctx, 'FLAPS', cx, cy - r * 0.75);
  const top = cy - r * 0.45;
  const bottom = cy + r * 0.8;
  ['UP', 'T/O', 'LDG'].forEach((label, i) => {
    const y = top + ((bottom - top) * i) / 2;
    text(ctx, label, cx + r * 0.35, y, `600 ${Math.round(r * 0.22)}px system-ui`);
  });
  const y = top + ((bottom - top) * clamp(s.flaps, 0, 2)) / 2;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(cx - r * 0.65, y - 4, r * 0.6, 8);
}
