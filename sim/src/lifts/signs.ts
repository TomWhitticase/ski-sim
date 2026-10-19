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
import type { SignMount } from './terminals';

const CELL_W = 1024;
const CELL_H = 192;
/** Keep the atlas within GPU texture limits (8192 px is the WebGPU default). */
const MAX_ATLAS = 8192;

/** Grid for `count` sign cells: roughly square, so it stays under the size limit. */
export function atlasLayout(count: number): { columns: number; rows: number; scale: number } {
  const columns = Math.max(1, Math.ceil(Math.sqrt((count * CELL_H) / CELL_W)));
  const rows = Math.max(1, Math.ceil(count / columns));
  const scale = Math.min(1, MAX_ATLAS / (columns * CELL_W), MAX_ATLAS / (rows * CELL_H));
  return { columns, rows, scale };
}
const BOARD = { width: 11, height: 2.1 };

/** Text for the second line of a sign, e.g. "Chairlift · 6 seats · 1,410 m". */
export function signSubtitle(line: LiftLine): string {
  const parts = [liftTypeName(line.lift.type)];
  if (line.op.kind !== 'platter' && line.op.kind !== 'tbar') parts.push(`${line.seats} seats`);
  parts.push(`${Math.round(line.lift.length).toLocaleString('en-GB')} m`);
  return parts.join(' · ');
}

function drawAtlas(lines: LiftLine[]): CanvasTexture {
  const { columns: COLUMNS, rows, scale } = atlasLayout(lines.length);
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(CELL_W * COLUMNS * scale);
  canvas.height = Math.floor(CELL_H * rows * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);
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
/**
 * Name boards mounted on each lift's stations (over the entrance; on the line end where
 * riders arrive at the top): positions come from the station builder, so a board is
 * attached by construction and can't float or wander. Drag lifts get a small arch.
 * One texture atlas and one instanced mesh for all the boards (plus one for posts).
 */
export function createLiftSigns(lines: LiftLine[], mounts: SignMount[][][]): Group {
  const group = new Group();
  group.name = 'lift-signs';
  const atlas = drawAtlas(lines);
  const { columns: COLUMNS, rows } = atlasLayout(lines.length);

  const boards: { matrix: Matrix4; cell: number }[] = [];
  const posts: Matrix4[] = [];
  const q = new Quaternion();
  const m = new Matrix4();
  const Z = new Vector3(0, 0, 1);

  lines.forEach((_, cell) => {
    for (const mount of (mounts[cell] ?? []).flat()) {
      const width = Math.min(BOARD.width, mount.width);
      const height = width * (BOARD.height / BOARD.width);
      // Facing out, plus a back face (4 cm behind) for free-standing arches.
      const faces = mount.posts ? [mount.facing, mount.facing.clone().negate()] : [mount.facing];
      for (const dir of faces) {
        q.setFromUnitVectors(Z, dir);
        const centre = mount.centre.clone().addScaledVector(dir, 0.02);
        m.compose(centre, q, new Vector3(width, height, 1));
        boards.push({ matrix: m.clone(), cell });
      }
      if (mount.posts) {
        const top = mount.centre.y + height / 2;
        for (const foot of mount.posts) {
          const h = top - foot.y + 0.3;
          posts.push(
            m
              .compose(
                new Vector3(foot.x, foot.y - 0.3 + h / 2, foot.z),
                q.identity(),
                new Vector3(1, h, 1),
              )
              .clone(),
          );
        }
      }
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
