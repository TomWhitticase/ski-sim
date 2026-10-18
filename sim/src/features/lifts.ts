import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';

import type { Lift, LiftSupport } from './types';

interface Style {
  /** Tower column radius (m). */
  towerRadius: number;
  cableThickness: number;
  /** Synthetic station box when OSM has no station footprint: length, width, height. */
  station: [number, number, number];
}

const CABLE_CAR: Style = { towerRadius: 1.6, cableThickness: 0.35, station: [22, 14, 12] };
const GONDOLA: Style = { towerRadius: 0.8, cableThickness: 0.3, station: [24, 12, 9] };
const CHAIR: Style = { towerRadius: 0.5, cableThickness: 0.25, station: [14, 10, 7] };
const DRAG: Style = { towerRadius: 0.25, cableThickness: 0.15, station: [4, 3, 3] };

const STYLES: Record<string, Style> = {
  cable_car: CABLE_CAR,
  gondola: GONDOLA,
  mixed_lift: GONDOLA,
  chair_lift: CHAIR,
  drag_lift: DRAG,
  't-bar': DRAG,
  'j-bar': DRAG,
  platter: DRAG,
  rope_tow: DRAG,
};

/** Depth that tower and station bases are sunk into the ground to hide slope gaps. */
const BURY = 2;
/** The cable rests on the crossarm, slightly below the support's cable height. */
const ARM_DROP = 0.6;

const UP = new Vector3(0, 1, 0);
const FORWARD = new Vector3(0, 0, 1);

function world(s: LiftSupport, y = s.top): Vector3 {
  return new Vector3(s.east, y, -s.north);
}

/**
 * Basic static lifts: stations, towers with crossarms, and the up/down cables.
 * Everything is instanced (one draw call per part type across all lifts).
 */
export function createLifts(lifts: Lift[]): Group {
  const towers: Matrix4[] = [];
  const arms: Matrix4[] = [];
  const cables: Matrix4[] = [];
  const stations: Matrix4[] = [];

  const m = new Matrix4();
  const q = new Quaternion();
  const pos = new Vector3();
  const scale = new Vector3();

  for (const lift of lifts) {
    const style = STYLES[lift.type] ?? CHAIR;
    const first = lift.supports[0]!;
    const last = lift.supports[lift.supports.length - 1]!;
    // One across-track direction for the whole lift keeps cables continuous over towers.
    const along = world(last).sub(world(first)).setY(0).normalize();
    const across = new Vector3().crossVectors(along, UP).normalize();
    const heading = Math.atan2(along.x, along.z);
    const offsets = [lift.gauge / 2, -lift.gauge / 2];

    for (const s of lift.supports) {
      const base = s.ground - BURY;
      if (s.kind === 'station') {
        if (s.stationBuilding) continue;
        const [length, width, height] = style.station;
        const top = Math.max(s.top + 1.5, s.ground + height);
        q.setFromAxisAngle(UP, heading);
        pos.set(s.east, (base + top) / 2, -s.north);
        scale.set(width, top - base, length);
        stations.push(m.compose(pos, q, scale).clone());
      } else {
        const armY = s.top - ARM_DROP;
        q.identity();
        pos.set(s.east, (base + armY) / 2, -s.north);
        scale.set(style.towerRadius, armY - base, style.towerRadius);
        towers.push(m.compose(pos, q, scale).clone());

        q.setFromAxisAngle(UP, heading);
        pos.set(s.east, armY, -s.north);
        scale.set(lift.gauge + 1, 0.4, 0.5);
        arms.push(m.compose(pos, q, scale).clone());
      }
    }

    for (let i = 0; i < lift.supports.length - 1; i++) {
      const a = world(lift.supports[i]!);
      const b = world(lift.supports[i + 1]!);
      const span = b.clone().sub(a);
      const length = span.length();
      q.setFromUnitVectors(FORWARD, span.normalize());
      for (const offset of offsets) {
        pos.copy(a).lerp(b, 0.5).addScaledVector(across, offset);
        scale.set(style.cableThickness, style.cableThickness, length);
        cables.push(m.compose(pos, q, scale).clone());
      }
    }
  }

  const steel = new MeshStandardNodeMaterial({ color: 0x8c9198, metalness: 0.6, roughness: 0.45 });
  const cable = new MeshStandardNodeMaterial({ color: 0x1d1f22, metalness: 0.4, roughness: 0.6 });
  const station = new MeshStandardNodeMaterial({ color: 0x7d7f84, roughness: 0.8 });

  // Unit-sized geometries; instance matrices scale them to size.
  const tower = new CylinderGeometry(0.8, 1, 1, 8);
  const box = new BoxGeometry(1, 1, 1);

  const group = new Group();
  group.name = 'lifts';
  group.add(
    instanced(tower, steel, towers, true),
    instanced(box, steel, arms, true),
    instanced(box, cable, cables, false),
    instanced(box, station, stations, true),
  );
  return group;
}

function instanced(
  geometry: BoxGeometry | CylinderGeometry,
  material: MeshStandardNodeMaterial,
  matrices: Matrix4[],
  shadows: boolean,
): InstancedMesh {
  const mesh = new InstancedMesh(geometry, material, Math.max(matrices.length, 1));
  matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
  mesh.count = matrices.length;
  mesh.castShadow = shadows;
  mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  return mesh;
}
