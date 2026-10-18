import { Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { SnowTrails } from './snow-trails';

describe('SnowTrails', () => {
  it('lays marks face-up along the path, sized to the track width', () => {
    const trails = new SnowTrails();
    const up = new Vector3(0, 1, 0);
    trails.extend('left', new Vector3(0, 100, 0), up, 0.1, 0);
    trails.extend('left', new Vector3(0, 100, -1), up, 0.1, 0); // 1 m north
    expect(trails.mesh.count).toBe(1);

    const m = new Matrix4();
    trails.mesh.getMatrixAt(0, m);
    const position = new Vector3();
    const q = new Quaternion();
    const scale = new Vector3();
    m.decompose(position, q, scale);
    expect(new Vector3(0, 1, 0).applyQuaternion(q).y).toBeCloseTo(1); // faces up
    expect(scale.x).toBeCloseTo(0.1);
    expect(position.z).toBeCloseTo(-0.5);
  });

  it('starts a fresh track instead of streaking across a teleport', () => {
    const trails = new SnowTrails();
    const up = new Vector3(0, 1, 0);
    trails.extend('right', new Vector3(0, 0, 0), up, 0.1, 0);
    trails.extend('right', new Vector3(100, 0, 0), up, 0.1, 0);
    expect(trails.mesh.count).toBe(0);
  });
});
