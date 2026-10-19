import { PerspectiveCamera, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { blockRadius, Forest } from './forest';
import { STRIDE, TILE } from './tree-placement';

const extent = { west: -400, east: 400, south: -400, north: 400 };
const ground = 1500;
const params = { treeLine: 2100, height: { valley: 26, treeLine: 7 } };
/** Forest everywhere west of east = 0, open snow to the east. */
const forest = new Forest({ cover: (e) => (e < 0 ? 1 : 0), ground: () => ground }, params, extent);

/** A tree within half a tile of (east, north): [east, north, height + 1000·species]. */
function treeNear(east: number, north: number): [number, number, number] {
  const probe = new Forest({ cover: (e) => (e < 0 ? 1 : 0), ground: () => ground }, params, extent);
  const camera = new PerspectiveCamera(70, 1, 1, 5000);
  camera.position.set(east, ground + 2, -north);
  camera.lookAt(east, ground, -north - 10);
  probe.update(camera);
  const tiles = (probe as unknown as { tiles: Map<number, { trees: Float32Array }> }).tiles;
  for (const { trees } of tiles.values()) {
    for (let i = 0; i < trees.length; i += STRIDE) {
      if (Math.abs(trees[i]! - east) < TILE / 2 && Math.abs(trees[i + 2]! - north) < TILE / 2) {
        return [trees[i]!, trees[i + 2]!, trees[i + 3]!];
      }
    }
  }
  throw new Error('no tree found');
}

describe('Forest collisions', () => {
  it('stops a skier running into a trunk', () => {
    const [east, north, height] = treeNear(-200, 100);
    // Skiing east at 10 m/s, stepped right up to the trunk.
    const position = new Vector3(east - 0.1, ground, -north);
    const velocity = new Vector3(10, 0, 0);
    expect(forest.resolve(position, velocity)).toBe(true);
    const gap = Math.hypot(position.x - east, -position.z - north);
    expect(gap).toBeCloseTo(0.4 + blockRadius(height), 5);
    // Moving into the trunk is cancelled; the skier ends up on the near side.
    expect(velocity.x).toBeCloseTo(0);
    expect(position.x).toBeLessThan(east);
  });

  it('lets you ski freely where there are no trees, and over the tops', () => {
    const open = new Vector3(200, ground, -100);
    expect(forest.resolve(open, new Vector3(10, 0, 0))).toBe(false);
    const [east, north] = treeNear(-150, -50);
    const above = new Vector3(east, ground + 40, -north);
    expect(forest.resolve(above, new Vector3(0, -5, 0))).toBe(false);
  });

  it('blocks out to the crown on small trees, the trunk on big ones', () => {
    expect(blockRadius(26)).toBeCloseTo(0.45);
    expect(blockRadius(6)).toBeGreaterThan(1);
    expect(blockRadius(6)).toBeLessThanOrEqual(1.4);
  });
});

describe('Forest drawing', () => {
  it('draws nearby trees in detail, and only the trees in view', () => {
    // Forest only from 160 m north of the camera.
    const f = new Forest(
      { cover: (_, n) => (n > 160 ? 1 : 0), ground: () => ground },
      params,
      extent,
    );
    const camera = new PerspectiveCamera(70, 1, 1, 5000);
    camera.position.set(0, ground + 2, 0);
    camera.lookAt(0, ground + 2, -100); // north
    for (let i = 0; i < 10; i++) f.update(camera);
    const [detailed, simple] = f.counts;
    expect(detailed).toBeGreaterThan(100);
    expect(simple).toBeGreaterThan(100);
    camera.lookAt(0, ground + 2, 100); // turn south: the forest is behind you
    camera.updateMatrixWorld();
    f.update(camera);
    expect(f.counts).toEqual([0, 0, 0]);
  });
});
