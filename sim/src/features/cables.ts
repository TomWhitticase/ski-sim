import type { Vector3 } from 'three/webgpu';

const CELL = 64;

/**
 * Lift ropes as line segments in a grid, so a flying aircraft can tell when it's flown into
 * one. Each span sits in every cell it passes over (stepped along it, not its bounding
 * box: a long cable car span crosses a corner of the map).
 */
export class CableIndex {
  private readonly cells = new Map<string, number[]>();
  private readonly segments: {
    ax: number;
    ay: number;
    az: number;
    bx: number;
    by: number;
    bz: number;
  }[] = [];

  constructor(segments: [Vector3, Vector3][]) {
    for (const [a, b] of segments) {
      const i = this.segments.length;
      this.segments.push({ ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z });
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      const steps = Math.max(1, Math.ceil(length / (CELL / 2)));
      const seen = new Set<string>();
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        const cx = Math.floor(x / CELL);
        const cz = Math.floor(z / CELL);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            const key = `${cx + dx},${cz + dz}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const list = this.cells.get(key);
            if (list) list.push(i);
            else this.cells.set(key, [i]);
          }
        }
      }
    }
  }

  /** Is there a rope within `radius` of the point (world)? */
  hit(p: Vector3, radius: number): boolean {
    const list = this.cells.get(`${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`);
    if (!list) return false;
    for (const i of list) {
      const s = this.segments[i]!;
      const dx = s.bx - s.ax;
      const dy = s.by - s.ay;
      const dz = s.bz - s.az;
      const len2 = dx * dx + dy * dy + dz * dz || 1;
      const t = Math.max(
        0,
        Math.min(1, ((p.x - s.ax) * dx + (p.y - s.ay) * dy + (p.z - s.az) * dz) / len2),
      );
      const ex = s.ax + dx * t - p.x;
      const ey = s.ay + dy * t - p.y;
      const ez = s.az + dz * t - p.z;
      if (ex * ex + ey * ey + ez * ez < radius * radius) return true;
    }
    return false;
  }
}
