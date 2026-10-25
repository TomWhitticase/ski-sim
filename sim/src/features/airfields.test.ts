import { describe, expect, it } from 'vitest';
import { InstancedMesh, Matrix4, Vector3 } from 'three/webgpu';

import { airfieldSolids, createAirfields, Polyline, sockPose, WINDSOCK } from './airfields';
import { ObstacleIndex } from './obstacles';
import type { Airfields } from './types';

const flat = () => 1000;

const DATA: Airfields = {
  aerodromes: [],
  runways: [
    {
      id: 1,
      ref: '09/27',
      designators: ['09', '27'],
      line: [
        [0, 0],
        [400, 0],
      ],
      length: 400,
      width: 30,
      heading: 90,
      surface: 'asphalt',
      winter: 'cleared',
      ends: [1000, 1000],
      source: 'osm',
    },
  ],
  taxiways: [],
  aprons: [],
  helipads: [
    {
      id: 2,
      name: null,
      east: 0,
      north: 100,
      ring: null,
      shape: 'square',
      size: 15,
      heading: 0,
      surface: null,
      winter: 'groomed',
      roof: false,
      building: null,
      top: 1000,
    },
  ],
  windsocks: [{ id: 3, east: 50, north: 40, ground: 1000 }],
  snowbanks: [
    [
      [0, 18],
      [50, 18],
    ],
  ],
  markers: [[0, 108, 1000]],
};

describe('airfields', () => {
  it('walks along a polyline, right of its direction', () => {
    const line = new Polyline([
      [0, 0],
      [0, 10],
      [10, 10],
    ]);
    expect(line.length).toBe(20);
    expect(line.at(5)).toEqual([0, 5]);
    // Heading north, the right is east.
    expect(line.at(5, 2)).toEqual([2, 5]);
    // Round the corner, heading east: the right is south.
    const [e, n] = line.at(15, 2);
    expect(e).toBeCloseTo(5);
    expect(n).toBeCloseTo(8);
  });

  it('hangs a windsock limp in still air and straight out downwind in 15 kt', () => {
    const still = sockPose(0, 0, 0, 0);
    expect(still.droop).toBeGreaterThan(60);
    const windy = sockPose(8, 270, 0, 0); // from the west
    expect(windy.droop).toBeLessThan(5);
    expect(((windy.bearing % 360) + 360) % 360).toBeCloseTo(90, -1); // blows east
  });

  it('makes snowbanks, edge markers and windsock masts solid, and lets a skier over a bank', () => {
    const index = new ObstacleIndex(airfieldSolids(DATA, flat));
    // Into the snowbank from the runway side.
    const p = new Vector3(25, 1000, -17.4);
    const v = new Vector3(0, 0, -5); // heading north
    expect(index.resolve(p, v)).toBe(true);
    expect(v.z).toBeCloseTo(0);
    // Into the mast.
    expect(index.resolve(new Vector3(50.1, 1000, -40), new Vector3(1, 0, 0))).toBe(true);
    // Into a marker cone.
    expect(index.resolve(new Vector3(0.2, 1000, -108), new Vector3(1, 0, 0))).toBe(true);
    // Jumping clear over the bank.
    expect(index.resolve(new Vector3(25, 1001.5, -18), new Vector3(0, 0, -5))).toBe(false);
    // Out on the runway: nothing.
    expect(index.resolve(new Vector3(200, 1000, 0), new Vector3(0, 0, -5))).toBe(false);
  });

  it('builds one static mesh and one instanced mesh for the socks', () => {
    const meshes = createAirfields(DATA, flat);
    expect(meshes.root.children.map((c) => c.name)).toEqual(['airfield-surfaces', 'windsocks']);
    meshes.update(8, 270, 1);
    const sock = meshes.root.children[1] as InstancedMesh;
    const m = new Matrix4();
    sock.getMatrixAt(0, m);
    const pos = new Vector3().setFromMatrixPosition(m);
    expect(pos.y).toBeCloseTo(1000 + WINDSOCK.mast);
    // The sock's +x (its length) points downwind: east, so +x in world.
    const tip = new Vector3(WINDSOCK.length, 0, 0).applyMatrix4(m);
    expect(tip.x - pos.x).toBeGreaterThan(3);
  });
});
