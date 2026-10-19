import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshStandardNodeMaterial,
} from 'three/webgpu';

import {
  BERM_SINK,
  type BermFeature,
  bermHeight,
  type LineFeature,
  lineHeight,
  type ParkFeature,
} from './park-shapes';

const SNOW: [number, number, number] = [1, 1, 1];
/** Dyed lines on the lip, so riders can read the take-off (blue, like most parks). */
const DYE: [number, number, number] = [0.18, 0.4, 0.85];
const BOX_TOP: [number, number, number] = [0.82, 0.83, 0.85];
const BOX_SIDE: [number, number, number] = [0.85, 0.27, 0.17];
/** Drawn this far below the physics surface, so where a feature meets the snow the
 * terrain wins instead of z-fighting (the step is never visible). */
const SINK = 0.05;
const ACROSS = 6;

class Builder {
  readonly positions: number[] = [];
  readonly colours: number[] = [];
  readonly indices: number[] = [];

  vertex(east: number, y: number, north: number, c: [number, number, number]): number {
    this.positions.push(east, y, -north);
    this.colours.push(...c);
    return this.positions.length / 3 - 1;
  }

  /** A grid of vertices (rows × cols, row-major), two triangles per cell. */
  grid(first: number, rows: number, cols: number, flip = false): void {
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = first + r * cols + c;
        const b = a + 1;
        const d = a + cols;
        const e = d + 1;
        if (flip) this.indices.push(a, b, d, b, e, d);
        else this.indices.push(a, d, b, b, d, e);
      }
    }
  }
}

function lineSurface(b: Builder, f: LineFeature): void {
  const s = Math.sin((f.heading * Math.PI) / 180);
  const c = Math.cos((f.heading * Math.PI) / 180);
  const top = Math.max(...f.profile.map(([, h]) => Math.abs(h)));
  // Across: the flat top, then the sides down well below the snow.
  const reach = f.width / 2 + (top + 1) / f.side;
  const vs: number[] = [-reach];
  for (let i = 0; i <= ACROSS; i++) vs.push(-f.width / 2 + (f.width * i) / ACROSS);
  vs.push(reach);
  const first = b.positions.length / 3;
  for (const [u] of f.profile) {
    const dyed = f.kind === 'kicker' && u > -0.6 && u <= 0;
    for (const v of vs) {
      const y = lineHeight(f, u, v) - SINK;
      b.vertex(f.east + u * s - v * c, y, f.north + u * c + v * s, dyed ? DYE : SNOW);
    }
  }
  b.grid(first, f.profile.length, vs.length);
}

/** A box: a top following the profile, vertical sides and end down into the snow. */
function box(b: Builder, f: LineFeature, ground: (east: number, north: number) => number): void {
  const s = Math.sin((f.heading * Math.PI) / 180);
  const c = Math.cos((f.heading * Math.PI) / 180);
  const at = (u: number, v: number): [number, number] => [
    f.east + u * s - v * c,
    f.north + u * c + v * s,
  ];
  const half = f.width / 2;
  const [u0, u1] = [f.profile[0]![0], f.profile[f.profile.length - 1]![0]];
  const corners = [
    [u0, -half],
    [u1, -half],
    [u1, half],
    [u0, half],
  ] as const;
  const topY = (u: number) => lineHeight(f, u, 0);
  const quad = (pts: [number, number, number][], colour: [number, number, number]) => {
    const i = pts.map(([e, y, n]) => b.vertex(e, y, n, colour));
    b.indices.push(i[0]!, i[1]!, i[2]!, i[0]!, i[2]!, i[3]!);
  };
  const top = corners.map(([u, v]) => {
    const [e, n] = at(u, v);
    return [e, topY(u), n] as [number, number, number];
  });
  quad([top[0]!, top[1]!, top[2]!, top[3]!], BOX_TOP);
  // Sides: each edge from the top down to under the snow.
  for (let k = 0; k < 4; k++) {
    const p = top[k]!;
    const q = top[(k + 1) % 4]!;
    const below = (t: [number, number, number]): [number, number, number] => [
      t[0],
      ground(t[0], t[2]) - 0.3,
      t[2],
    ];
    quad([p, below(p), below(q), q], BOX_SIDE);
  }
}

function berm(b: Builder, f: BermFeature): void {
  const arcSteps = Math.max(12, Math.round(Math.abs(f.sweep) / 5));
  const outs: number[] = [];
  for (let i = 0; i <= 10; i++) outs.push(-0.8 + ((f.width + 0.8) * i) / 10);
  outs.push(f.width + (f.height + 1) / f.side);
  const first = b.positions.length / 3;
  // Stay just inside the arc's ends, where the height is defined.
  for (let i = 0; i <= arcSteps; i++) {
    const t = 0.001 + (0.998 * i) / arcSteps;
    const bearing = ((f.start + f.sweep * t) * Math.PI) / 180;
    for (const out of outs) {
      const r = f.radius + out;
      const east = f.east + r * Math.sin(bearing);
      const north = f.north + r * Math.cos(bearing);
      const y = bermHeight(f, east, north);
      b.vertex(east, (Number.isFinite(y) ? y : f.y - BERM_SINK - 1) - SINK, north, SNOW);
    }
  }
  b.grid(first, arcSteps + 1, outs.length, f.sweep < 0);
}

/**
 * Every park feature in one vertex-coloured mesh (one draw call): snow kickers, ramps,
 * rollers and berms, plus the boxes.
 */
export function createParkMeshes(
  features: ParkFeature[],
  ground: (east: number, north: number) => number,
): Mesh {
  const b = new Builder();
  for (const f of features) {
    if (f.kind === 'berm') berm(b, f);
    else if (f.kind === 'box') box(b, f, ground);
    else lineSurface(b, f);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(b.positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(b.colours, 3));
  geometry.setIndex(b.indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const material = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.85 });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'snow-parks';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
