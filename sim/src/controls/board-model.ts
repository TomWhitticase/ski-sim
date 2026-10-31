/**
 * Procedural snowboard: a directional-twin deck (sidecut, camber, turned-up nose and tail,
 * vertex-coloured topsheet / base / steel edges) and a pair of freestyle bindings
 * (baseplate, highback, ankle and toe straps). Built to match the procedural skis in
 * `ski-model.ts`: one vertex-coloured draw call for the deck, a handful of parts per
 * binding. Pure geometry — no scene, no DOM — so it's unit-testable.
 *
 * Board-local axes match the skier group used elsewhere: x = right (toe edge for a regular
 * rider), y = up, z = back. The nose is at -z.
 */

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  type MeshStandardNodeMaterial,
} from 'three/webgpu';

import type { BoardSetup } from './discipline';

type RGB = [number, number, number];

const TOPSHEET: RGB = [0.06, 0.1, 0.16];
const ACCENT: RGB = [0.95, 0.42, 0.08];
const BASE: RGB = [0.04, 0.04, 0.05];
const EDGE: RGB = [0.62, 0.64, 0.67];

const STATIONS = 48;

export interface BoardDimensions {
  /** Overall length (m). */
  length: number;
  /** Width underfoot / at the nose / at the tail (m). */
  waistWidth: number;
  noseWidth: number;
  tailWidth: number;
  /** Nose / tail turn-up (m). */
  noseRise: number;
  tailRise: number;
  /** Where the effective edge ends and the nose/tail kick begins (fraction from the tail). */
  tailContact: number;
  noseContact: number;
  /** Deck thickness underfoot (m). */
  thickness: number;
}

/** Board shape from a setup. Longer and wider by its numbers; a touch directional. */
export function boardDimensions(s: BoardSetup): BoardDimensions {
  const length = s.length / 100;
  const waist = s.waist / 1000;
  // Sidecut depth either side from the radius (depth ≈ c²/(8R) over the contact length).
  const contact = 0.84 * length;
  const depth = (contact * contact) / (8 * s.radius);
  // Directional: the nose is a little wider and longer than the tail. A stiffer flex keeps
  // more camber, which here reads as slightly less tip/tail rise.
  const stiff = (s.flex - 1) / 9;
  return {
    length,
    waistWidth: waist,
    noseWidth: waist + 2 * depth,
    tailWidth: waist + 1.7 * depth,
    noseRise: 0.075 - 0.02 * stiff,
    tailRise: 0.06 - 0.015 * stiff,
    tailContact: 0.11,
    noseContact: 0.84,
    thickness: 0.009,
  };
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/** Shape of the board at fraction t along it (0 = tail end, 1 = nose end). */
export function boardProfile(t: number, d: BoardDimensions): { halfWidth: number; rise: number } {
  // Width: parallel through the middle, sidecut pulling the waist in, flaring to the tips.
  const waistT = 0.47;
  const edge =
    t < waistT
      ? d.waistWidth + (d.tailWidth - d.waistWidth) * ((waistT - t) / waistT) ** 2
      : d.waistWidth + (d.noseWidth - d.waistWidth) * ((t - waistT) / (1 - waistT)) ** 2;
  // Round the very ends of the nose and tail off.
  const noseRound =
    t > d.noseContact
      ? Math.sqrt(Math.max(0, 1 - ((t - d.noseContact) / (1 - d.noseContact)) ** 2))
      : 1;
  const tailRound =
    t < d.tailContact ? Math.sqrt(Math.max(0, 1 - ((d.tailContact - t) / d.tailContact) ** 2)) : 1;
  const width = edge * (0.4 + 0.6 * noseRound * tailRound);
  // Kick: the nose and tail curve up past the contact points (rocker at the tips).
  const rise =
    d.noseRise * smoothstep(d.noseContact, 1, t) ** 1.5 +
    d.tailRise * smoothstep(d.tailContact, 0, t) ** 1.5;
  return { halfWidth: width / 2, rise };
}

function topColour(t: number): RGB {
  // A bright band across the waist and colour at the nose; dark elsewhere.
  if (t > 0.9 || t < 0.06) return ACCENT;
  if (t > 0.44 && t < 0.52) return ACCENT;
  return TOPSHEET;
}

/**
 * Snowboard deck with separate top, base and edge faces (sharp creases, vertex-coloured),
 * nose at -z, base sitting on y = 0. `underfoot` lifts the whole deck so its base clears
 * the snow by the same amount the skis' bases do.
 */
export function createBoardGeometry(d: BoardDimensions, underfoot: number): BufferGeometry {
  const positions: number[] = [];
  const colours: number[] = [];
  const indices: number[] = [];
  const n = STATIONS;
  const half = d.length / 2;

  const strip = (
    railA: (t: number) => [number, number, number],
    railB: (t: number) => [number, number, number],
    colour: (t: number) => RGB,
  ) => {
    const start = positions.length / 3;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      for (const p of [railA(t), railB(t)]) {
        positions.push(...p);
        colours.push(...colour(t));
      }
    }
    for (let i = 0; i < n; i++) {
      const a = start + i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  };

  const z = (t: number) => half - t * d.length; // t=0 tail (+z), t=1 nose (-z)
  const at = (t: number, side: -1 | 1, top: boolean): [number, number, number] => {
    const p = boardProfile(t, d);
    return [side * p.halfWidth, underfoot + p.rise + (top ? d.thickness : 0), z(t)];
  };
  strip(
    (t) => at(t, -1, true),
    (t) => at(t, 1, true),
    topColour,
  );
  strip(
    (t) => at(t, 1, false),
    (t) => at(t, -1, false),
    () => BASE,
  );
  strip(
    (t) => at(t, 1, true),
    (t) => at(t, 1, false),
    () => EDGE,
  );
  strip(
    (t) => at(t, -1, false),
    (t) => at(t, -1, true),
    () => EDGE,
  );

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colours), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A freestyle binding: a baseplate disc, a highback up the heel edge, and ankle + toe
 * straps. Built facing +toe (the highback behind the heel at -toeX), so the caller rotates
 * the group to the binding angle and reflects it for the back foot / goofy stance. Sits on
 * the deck's topsheet at height `top`.
 */
export function createBinding(
  top: number,
  base: MeshStandardNodeMaterial,
  metal: MeshStandardNodeMaterial,
  strap: MeshStandardNodeMaterial,
  toeX: 1 | -1,
): Group {
  const g = new Group();
  const add = (m: Mesh, x: number, y: number, z: number, rx = 0) => {
    m.position.set(x, top + y, z);
    m.rotation.x = rx;
    m.castShadow = true;
    g.add(m);
    return m;
  };
  // Baseplate: a low disc under the boot.
  add(new Mesh(new CylinderGeometry(0.085, 0.09, 0.012, 16), base), 0, 0.006, 0);
  // Heel cup / highback up the heel edge (behind the heel, away from the toe edge).
  const highback = new Mesh(new BoxGeometry(0.11, 0.17, 0.02), base);
  add(highback, -toeX * 0.085, 0.09, 0);
  highback.rotation.z = toeX * 0.22; // lean the highback back a little
  // Ankle strap across the top of the foot.
  const ankle = add(new Mesh(new BoxGeometry(0.11, 0.03, 0.05), strap), 0, 0.085, 0.0);
  ankle.rotation.z = 0;
  // Toe strap nearer the toes.
  add(new Mesh(new BoxGeometry(0.1, 0.025, 0.045), strap), toeX * 0.01, 0.05, -0.08);
  // Two ratchets on the toe-edge side.
  for (const z of [0.0, -0.08])
    add(new Mesh(new BoxGeometry(0.018, 0.018, 0.022), metal), toeX * 0.07, 0.055, z);
  return g;
}
