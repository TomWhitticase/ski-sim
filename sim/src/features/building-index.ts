import type { Building } from './types';

const CELL = 50; // m

/** Point-in-polygon (even-odd) for a ring of [east, north] points. */
export function pointInRing(e: number, n: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > n !== yj > n && e < ((xj - xi) * (n - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * "Is this point inside a building?" over thousands of footprints: a uniform grid maps
 * each 50 m cell to the buildings whose bounding box touches it.
 */
export class BuildingIndex {
  private readonly cells = new Map<string, Building[]>();

  constructor(
    buildings: Building[],
    private readonly margin = 1,
  ) {
    for (const b of buildings) {
      let minE = Infinity;
      let maxE = -Infinity;
      let minN = Infinity;
      let maxN = -Infinity;
      for (const [e, n] of b.footprint) {
        minE = Math.min(minE, e);
        maxE = Math.max(maxE, e);
        minN = Math.min(minN, n);
        maxN = Math.max(maxN, n);
      }
      for (
        let cx = Math.floor((minE - margin) / CELL);
        cx <= Math.floor((maxE + margin) / CELL);
        cx++
      ) {
        for (
          let cy = Math.floor((minN - margin) / CELL);
          cy <= Math.floor((maxN + margin) / CELL);
          cy++
        ) {
          const key = `${cx},${cy}`;
          const list = this.cells.get(key);
          if (list) list.push(b);
          else this.cells.set(key, [b]);
        }
      }
    }
  }

  /** Inside (or within `margin` m of the edge of, via a small ring of probes) a building. */
  contains(east: number, north: number): boolean {
    const list = this.cells.get(`${Math.floor(east / CELL)},${Math.floor(north / CELL)}`);
    if (!list) return false;
    const m = this.margin;
    const probes: [number, number][] = [
      [east, north],
      [east + m, north],
      [east - m, north],
      [east, north + m],
      [east, north - m],
    ];
    return list.some((b) => probes.some(([e, n]) => pointInRing(e, n, b.footprint)));
  }
}
