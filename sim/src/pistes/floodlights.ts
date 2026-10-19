import { color } from 'three/tsl';
import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardNodeMaterial,
  type UniformNode,
} from 'three/webgpu';

const MAST_HEIGHT = 11;
const MAST_RADIUS = 0.12;
const SINK = 0.5;
/** Lamp colour (sodium-ish warm white); the terrain glow uses the same. */
export const FLOODLIGHT_COLOUR = 0xffd9a0;

/**
 * Masts along floodlit runs (positions from the pipeline), with lamp heads that glow
 * by `on` (0..1, Environment.floodlights). The light they cast is a terrain shader term
 * (`PisteShading.floodlit`), not real lights, so it costs next to nothing.
 */
export function createFloodlights(
  lights: [number, number, number][],
  on: UniformNode<'float', number>,
): Group {
  const group = new Group();
  group.name = 'floodlights';
  if (!lights.length) return group;

  const mastGeometry = new CylinderGeometry(MAST_RADIUS * 0.7, MAST_RADIUS, MAST_HEIGHT, 6);
  mastGeometry.translate(0, MAST_HEIGHT / 2, 0);
  const masts = new InstancedMesh(
    mastGeometry,
    new MeshStandardNodeMaterial({ color: 0x6a6f76, roughness: 0.5, metalness: 0.6 }),
    lights.length,
  );
  const headGeometry = new BoxGeometry(0.9, 0.35, 0.5);
  headGeometry.translate(0, MAST_HEIGHT, 0);
  const headMaterial = new MeshStandardNodeMaterial({ color: 0x30333a, roughness: 0.4 });
  headMaterial.emissiveNode = color(FLOODLIGHT_COLOUR).mul(on.mul(6));
  const heads = new InstancedMesh(headGeometry, headMaterial, lights.length);

  const m = new Matrix4();
  lights.forEach(([east, north, ground], i) => {
    m.makeTranslation(east, ground - SINK, -north);
    masts.setMatrixAt(i, m);
    heads.setMatrixAt(i, m);
  });
  for (const mesh of [masts, heads]) {
    mesh.computeBoundingSphere();
    group.add(mesh);
  }
  return group;
}
