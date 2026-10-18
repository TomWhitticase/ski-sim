import type { Vector3 } from 'three/webgpu';

import { pointInRing } from './building-index';

export interface Solid {
  /** Footprint (east, north). */
  ring: [number, number][];
  base: number;
  top: number;
}

const CELL = 32;

/**
 * Collision against solid footprints (buildings, terminal walls, huts): a uniform grid
 * over their bounding boxes, and a circle-vs-polygon push-out for the skier.
 */
export class ObstacleIndex {
  private readonly cells = new Map<string, Solid[]>();

  constructor(solids: Solid[]) {
    for (const s of solids) {
      let minE = Infinity;
      let maxE = -Infinity;
      let minN = Infinity;
      let maxN = -Infinity;
      for (const [e, n] of s.ring) {
        minE = Math.min(minE, e);
        maxE = Math.max(maxE, e);
        minN = Math.min(minN, n);
        maxN = Math.max(maxN, n);
      }
      for (let cx = Math.floor((minE - 2) / CELL); cx <= Math.floor((maxE + 2) / CELL); cx++) {
        for (let cy = Math.floor((minN - 2) / CELL); cy <= Math.floor((maxN + 2) / CELL); cy++) {
          const key = `${cx},${cy}`;
          const list = this.cells.get(key);
          if (list) list.push(s);
          else this.cells.set(key, [s]);
        }
      }
    }
  }

  /**
   * Push a body of `radius` (world position, feet height) out of any solid it overlaps,
   * and cancel the part of its velocity heading into the wall. Returns whether it hit.
   */
  resolve(position: Vector3, velocity: Vector3, radius = 0.4, height = 1.8): boolean {
    const e = position.x;
    const n = -position.z;
    const list = this.cells.get(`${Math.floor(e / CELL)},${Math.floor(n / CELL)}`);
    if (!list) return false;
    let hit = false;
    for (const s of list) {
      if (position.y > s.top || position.y + height < s.base) continue;
      const pe = position.x;
      const pn = -position.z;
      // Nearest point on the footprint's boundary.
      let best = Infinity;
      let qe = 0;
      let qn = 0;
      for (let i = 0, j = s.ring.length - 1; i < s.ring.length; j = i++) {
        const [ae, an] = s.ring[j]!;
        const [be, bn] = s.ring[i]!;
        const de = be - ae;
        const dn = bn - an;
        const len2 = de * de + dn * dn || 1;
        const t = Math.max(0, Math.min(1, ((pe - ae) * de + (pn - an) * dn) / len2));
        const ce = ae + de * t;
        const cn = an + dn * t;
        const d = (pe - ce) ** 2 + (pn - cn) ** 2;
        if (d < best) {
          best = d;
          qe = ce;
          qn = cn;
        }
      }
      const inside = pointInRing(pe, pn, s.ring);
      const dist = Math.sqrt(best);
      if (!inside && dist >= radius) continue;
      // Outward normal (east, north).
      let ne = inside ? qe - pe : pe - qe;
      let nn = inside ? qn - pn : pn - qn;
      const len = Math.hypot(ne, nn) || 1;
      ne /= len;
      nn /= len;
      position.x = qe + ne * radius;
      position.z = -(qn + nn * radius);
      // Velocity in world axes: east = x, north = -z.
      const vn = velocity.x * ne - velocity.z * nn;
      if (vn < 0) {
        velocity.x -= ne * vn;
        velocity.z += nn * vn;
      }
      hit = true;
    }
    return hit;
  }
}
