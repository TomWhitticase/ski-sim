import { float, instancedBufferAttribute, texture, uv, vec2 } from 'three/tsl';
import {
  CanvasTexture,
  CylinderGeometry,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearMipmapLinearFilter,
  Matrix4,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
} from 'three/webgpu';

import { liftTypeName } from '../nav/places';
import type { LiftLine } from './lift-system';

const CELL_W = 1024;
const CELL_H = 192;
const COLUMNS = 2;
const BOARD = { width: 11, height: 2.1 };
/** Board centre above the station's ground (m). */
const MOUNT_HEIGHT = 8;

/** Text for the second line of a sign, e.g. "Chairlift · 6 seats · 1,410 m". */
export function signSubtitle(line: LiftLine): string {
  const parts = [liftTypeName(line.lift.type)];
  if (line.op.kind !== 'platter' && line.op.kind !== 'tbar') parts.push(`${line.seats} seats`);
  parts.push(`${Math.round(line.lift.length).toLocaleString('en-GB')} m`);
  return parts.join(' · ');
}

function drawAtlas(lines: LiftLine[]): CanvasTexture {
  const rows = Math.ceil(lines.length / COLUMNS);
  const canvas = document.createElement('canvas');
  canvas.width = CELL_W * COLUMNS;
  canvas.height = CELL_H * Math.max(rows, 1);
  const ctx = canvas.getContext('2d')!;
  lines.forEach((line, i) => {
    const x = (i % COLUMNS) * CELL_W;
    const y = Math.floor(i / COLUMNS) * CELL_H;
    // Panel: resort blue with a white keyline, like the real station signs.
    ctx.fillStyle = '#0b3d91';
    ctx.fillRect(x, y, CELL_W, CELL_H);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 8;
    ctx.strokeRect(x + 12, y + 12, CELL_W - 24, CELL_H - 24);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const name = line.name.toUpperCase();
    let size = 92;
    ctx.font = `800 ${size}px system-ui, sans-serif`;
    while (ctx.measureText(name).width > CELL_W - 80 && size > 40) {
      size -= 4;
      ctx.font = `800 ${size}px system-ui, sans-serif`;
    }
    ctx.fillText(name, x + CELL_W / 2, y + CELL_H * 0.42);
    ctx.font = '500 36px system-ui, sans-serif';
    ctx.fillStyle = '#cfe1ff';
    ctx.fillText(signSubtitle(line), x + CELL_W / 2, y + CELL_H * 0.78);
  });
  const t = new CanvasTexture(canvas);
  t.colorSpace = SRGBColorSpace;
  t.minFilter = LinearMipmapLinearFilter;
  t.anisotropy = 8;
  return t;
}

/**
 * Name boards at the bottom and top of every lift, on two posts beside the line.
 * One texture atlas and one instanced mesh for all of them (plus one for the posts).
 */
export function createLiftSigns(
  lines: LiftLine[],
  groundHeight: (x: number, z: number) => number,
  /** Highest building roof near (x, z), if any: signs go on top of station buildings. */
  roofNear: (x: number, z: number) => number | null = () => null,
): Group {
  const group = new Group();
  group.name = 'lift-signs';
  const atlas = drawAtlas(lines);
  const rows = Math.max(Math.ceil(lines.length / COLUMNS), 1);

  const boards: { matrix: Matrix4; cell: number }[] = [];
  const posts: Matrix4[] = [];
  const q = new Quaternion();
  const m = new Matrix4();

  lines.forEach((line, cell) => {
    const along = line.top.clone().sub(line.bottom).setY(0).normalize();
    for (const [station, facing] of [
      [line.bottom, along.clone().negate()], // read by skiers approaching from below
      [line.top, along.clone()], // and by those arriving at the top
    ] as const) {
      // Gantry over the line, just ahead of the station, above the carriers and any
      // station roof, so it's visible from a long way off.
      const centre = station.clone().addScaledVector(facing, 4);
      const ground = groundHeight(centre.x, centre.z);
      const roof = roofNear(station.x, station.z);
      const base = roof ?? ground;
      centre.y = Math.max(ground + MOUNT_HEIGHT, station.y + 2.5, (roof ?? -Infinity) + 2.2);
      for (const dir of [facing, facing.clone().negate()]) {
        q.setFromUnitVectors(new Vector3(0, 0, 1), dir);
        // Back-to-back faces 4 cm apart so they never share a plane.
        const face = centre.clone().addScaledVector(dir, 0.02);
        m.compose(face, q, new Vector3(BOARD.width, BOARD.height, 1));
        boards.push({ matrix: m.clone(), cell });
      }
      // Posts either side of the line (standing on the roof if there's a building).
      const span = Math.max(BOARD.width / 2.6, line.lift.gauge / 2 + 1.2);
      for (const side of [-1, 1]) {
        const post = centre.clone().addScaledVector(line.across, side * span);
        const height = centre.y - base + 0.6;
        post.y = base + height / 2;
        posts.push(m.compose(post, q.identity(), new Vector3(1, height, 1)).clone());
      }
      // Crossbeam joining the posts under the board.
      const beam = centre.clone();
      beam.y -= BOARD.height / 2 + 0.1;
      q.setFromUnitVectors(new Vector3(0, 1, 0), line.across);
      posts.push(m.compose(beam, q, new Vector3(0.8, span * 2, 0.8)).clone());
    }
  });

  const cells = new InstancedBufferAttribute(new Float32Array(boards.map((b) => b.cell)), 1);
  const material = new MeshBasicNodeMaterial();
  const cell = instancedBufferAttribute<'float'>(cells, 'float');
  const col = cell.mod(COLUMNS);
  const row = cell.div(COLUMNS).floor();
  const atlasUv = vec2(
    col.add(uv().x).div(COLUMNS),
    float(1).sub(row.add(1).sub(uv().y).div(rows)),
  );
  material.colorNode = texture(atlas, atlasUv);
  const boardMesh = new InstancedMesh(new PlaneGeometry(1, 1), material, boards.length);
  boards.forEach((b, i) => boardMesh.setMatrixAt(i, b.matrix));
  boardMesh.computeBoundingSphere();
  boardMesh.name = 'lift-sign-boards';

  const postMesh = new InstancedMesh(
    new CylinderGeometry(0.08, 0.1, 1, 8),
    new MeshStandardNodeMaterial({ color: 0x3a3f46, metalness: 0.5, roughness: 0.5 }),
    posts.length,
  );
  posts.forEach((p, i) => postMesh.setMatrixAt(i, p));
  postMesh.castShadow = true;
  postMesh.computeBoundingSphere();

  group.add(boardMesh, postMesh);
  return group;
}
