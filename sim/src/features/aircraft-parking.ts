import type { Airfields } from './types';

/** A parked aircraft waiting at an airfield: which type, where (ground reference) and facing. */
export interface ParkingSpot {
  type: 'pc6' | 'h125';
  east: number;
  north: number;
  ground: number;
  /** Degrees clockwise from north. */
  heading: number;
  /** Where it is, for a notice ("Courchevel Altiport", "helipad"). */
  name: string;
}

/** Runways shorter than this get no plane (m): a strip a Porter can't use. */
export const MIN_RUNWAY = 200;
/** A plane waits this far in from the runway's top threshold (m). */
const THRESHOLD_IN = 18;
/** Helicopters on pads at least this far apart (a row of pads gets a few, not one each). */
const PAD_SPACING = 35;

const bearing = (de: number, dn: number) => ((Math.atan2(de, dn) * 180) / Math.PI + 360) % 360;

/**
 * Where aircraft wait, from the airfields' real data: a Porter at the top of every runway
 * long enough for one, lined up to take off downhill (an altiport's slope is the take-off
 * run), and an H125 on helipads, a few along a row of them. `groundHeight(east, north)`.
 */
export function parkingSpots(
  airfields: Airfields,
  groundHeight: (east: number, north: number) => number,
): ParkingSpot[] {
  const spots: ParkingSpot[] = [];
  const nameNear = (east: number, north: number) => {
    let best = '';
    let bestD = 1500;
    for (const a of airfields.aerodromes) {
      const d = Math.hypot(a.east - east, a.north - north);
      if (d < bestD) {
        bestD = d;
        best = a.name;
      }
    }
    return best;
  };
  for (const r of airfields.runways) {
    if (r.length < MIN_RUNWAY || r.line.length < 2) continue;
    const a = r.line[0]!;
    const b = r.line[r.line.length - 1]!;
    // Start at the higher end, pointing down the runway.
    const [top, bottom] = r.ends[0] >= r.ends[1] ? [a, b] : [b, a];
    const de = bottom[0] - top[0];
    const dn = bottom[1] - top[1];
    const len = Math.hypot(de, dn) || 1;
    const east = top[0] + (de / len) * THRESHOLD_IN;
    const north = top[1] + (dn / len) * THRESHOLD_IN;
    spots.push({
      type: 'pc6',
      east,
      north,
      ground: groundHeight(east, north),
      heading: bearing(de, dn),
      name: nameNear(east, north) || `Runway ${r.ref}`,
    });
  }
  const pads = [...airfields.helipads].sort((p, q) => q.size - p.size);
  const taken: { east: number; north: number }[] = [];
  for (const pad of pads) {
    if (taken.some((t) => Math.hypot(t.east - pad.east, t.north - pad.north) < PAD_SPACING))
      continue;
    taken.push(pad);
    spots.push({
      type: 'h125',
      east: pad.east,
      north: pad.north,
      ground: pad.top,
      heading: pad.heading,
      name: pad.name ?? (nameNear(pad.east, pad.north) || 'Helipad'),
    });
  }
  return spots;
}

/**
 * Whether a point (east, north) is on a cleared (ploughed, paved) runway, taxiway or apron:
 * a plane's wheels run there; anywhere else it's on its skis.
 */
export function pavedAt(airfields: Airfields): (east: number, north: number) => boolean {
  const strips: { a: [number, number]; b: [number, number]; half: number }[] = [];
  for (const r of airfields.runways) {
    if (r.winter !== 'cleared') continue;
    for (let i = 0; i < r.line.length - 1; i++) {
      strips.push({ a: r.line[i]!, b: r.line[i + 1]!, half: r.width / 2 + 3 });
    }
  }
  for (const t of airfields.taxiways) {
    if (t.winter !== 'cleared') continue;
    for (let i = 0; i < t.line.length - 1; i++) {
      strips.push({ a: t.line[i]!, b: t.line[i + 1]!, half: t.width / 2 + 2 });
    }
  }
  const aprons = airfields.aprons.filter((a) => a.winter === 'cleared').map((a) => a.ring);
  return (east, north) => {
    for (const { a, b, half } of strips) {
      const de = b[0] - a[0];
      const dn = b[1] - a[1];
      const len2 = de * de + dn * dn || 1;
      const t = Math.max(0, Math.min(1, ((east - a[0]) * de + (north - a[1]) * dn) / len2));
      if (Math.hypot(east - a[0] - de * t, north - a[1] - dn * t) < half) return true;
    }
    return aprons.some((ring) => inRing(east, north, ring));
  };
}

function inRing(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
