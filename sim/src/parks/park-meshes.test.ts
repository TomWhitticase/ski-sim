import { describe, expect, it } from 'vitest';

import { createParkMeshes } from './park-meshes';

describe('createParkMeshes', () => {
  it('returns a hidden mesh when there are no park features (no empty draw)', () => {
    const mesh = createParkMeshes([], () => 0);
    expect(mesh.visible).toBe(false);
    expect(mesh.geometry.getIndex()?.count ?? 0).toBe(0);
  });
});
