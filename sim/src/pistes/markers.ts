import {
  Color,
  CylinderGeometry,
  InstancedMesh,
  Matrix4,
  MeshStandardNodeMaterial,
} from 'three/webgpu';

import { type PisteData, type PisteRecord, pisteColour } from './pistes';

const POLE_HEIGHT = 2;
const POLE_RADIUS = 0.06;
const SINK = 0.3; // planted in the snow

/**
 * Piste edge poles, like the ones lining French runs: one per marker, coloured by the
 * difficulty of the piste it borders. All drawn in a single instanced call.
 */
export function createPisteMarkers(data: PisteData): InstancedMesh {
  const byIndex = new Map<number, PisteRecord>(data.pistes.map((p) => [p.index, p]));
  const geometry = new CylinderGeometry(POLE_RADIUS, POLE_RADIUS, POLE_HEIGHT, 6);
  geometry.translate(0, POLE_HEIGHT / 2, 0);
  const material = new MeshStandardNodeMaterial({ roughness: 0.6 });
  const mesh = new InstancedMesh(geometry, material, Math.max(data.markers.length, 1));
  mesh.name = 'piste-markers';

  const m = new Matrix4();
  const colour = new Color();
  data.markers.forEach(([east, north, ground, index], i) => {
    m.makeTranslation(east, ground - SINK, -north);
    mesh.setMatrixAt(i, m);
    const piste = byIndex.get(index);
    mesh.setColorAt(i, colour.set(piste ? pisteColour(piste) : '#888888'));
  });
  mesh.count = data.markers.length;
  mesh.computeBoundingSphere();
  return mesh;
}
