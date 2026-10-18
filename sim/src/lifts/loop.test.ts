import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { LoopPath, loopCorners, maxStep } from './loop';

// A straight 500 m lift running north (world -z), 5 m gauge, 16 m stations.
const across = new Vector3(1, 0, 0); // uphill track on the east side
const bottom = { wheel: new Vector3(0, 2003, 0), dir: new Vector3(0, 0, -1), length: 16 };
const top = { wheel: new Vector3(0, 2103, -500), dir: new Vector3(0, 0, 1), length: 16 };
const towers = [new Vector3(0, 2060, -250)];

describe('LoopPath', () => {
  const path = new LoopPath(loopCorners(bottom, top, towers, across, 5), 5, 1);

  it('is one continuous loop round both bullwheels', () => {
    expect(maxStep(path)).toBeLessThan(0.6);
    // 2 × ~510 m of sloping line (500 m across, 100 m up) + two half-circles of r 2.5 m.
    expect(path.length).toBeGreaterThan(1030);
    expect(path.length).toBeLessThan(1045);
  });

  it('starts on the uphill side and comes back down the other', () => {
    const pos = new Vector3();
    const dir = new Vector3();
    path.at(0, pos, dir);
    expect(pos.x).toBeCloseTo(2.5);
    expect(dir.z).toBeLessThan(0); // heading up the line
    path.at(path.period / 2 + 5, pos, dir);
    expect(pos.x).toBeLessThan(0); // on the downhill track by mid-loop
  });

  it('crawls through stations and runs at line speed outside', () => {
    const pos = new Vector3();
    const dir = new Vector3();
    // In the bottom station (first ~8 m) a 1 m/s carrier covers ~1 m per second...
    path.at(1, pos, dir);
    expect(Math.abs(pos.z)).toBeLessThan(1.6);
    // ...and a whole loop takes far longer than at line speed alone, because of stations.
    expect(path.period).toBeGreaterThan(path.length / 5 + 30);
  });

  it('a fixed-grip lift (station speed = line speed) moves uniformly', () => {
    const fixed = new LoopPath(loopCorners(bottom, top, towers, across, 5), 2.2, 2.2);
    expect(fixed.period).toBeCloseTo(fixed.length / 2.2, 0);
  });
});
