import type { Building, Lift, Peak, Restaurant } from '../features/types';
import { type PisteRecord, pisteColour, pisteKind, pisteTitle } from '../pistes/pistes';
import type { Extent } from '../resort/manifest';
import type { Pose } from './pose';

export type PlaceKind = 'start' | 'peak' | 'lift' | 'piste' | 'restaurant';

export interface Place {
  kind: PlaceKind;
  name: string;
  detail: string;
  /** Where to put the camera when teleporting here. */
  pose: Pose;
  /** Swatch colour for the list (piste difficulty). */
  colour?: string;
  /** Point to look at on arrival (e.g. a summit), so the view aims at it from the ground. */
  lookAt?: { east: number; north: number; altitude: number };
}

const RAD = Math.PI / 180;

/** Compass heading from one point to another (degrees clockwise from north). */
export function bearing(fromEast: number, fromNorth: number, toEast: number, toNorth: number) {
  return (((Math.atan2(toEast - fromEast, toNorth - fromNorth) / RAD) % 360) + 360) % 360;
}

/**
 * Look at a summit from a short way off, slightly above it, approaching from the
 * direction of `from` (usually the resort centre) so the view includes the ski area.
 */
export function peakViewpoint(peak: Peak, from: { east: number; north: number }): Pose {
  const distance = 450;
  let dx = from.east - peak.east;
  let dy = from.north - peak.north;
  const len = Math.hypot(dx, dy);
  if (len < 1) [dx, dy] = [0, -1];
  else [dx, dy] = [dx / len, dy / len];
  const east = peak.east + dx * distance;
  const north = peak.north + dy * distance;
  return {
    east,
    north,
    altitude: peak.ground + 80,
    heading: bearing(east, north, peak.east, peak.north),
    pitch: -8,
  };
}

/** Just behind and above the bottom station, looking up the line. */
export function liftViewpoint(lift: Lift): Pose {
  const bottom = lift.supports[0]!;
  const top = lift.supports[lift.supports.length - 1]!;
  const heading = bearing(bottom.east, bottom.north, top.east, top.north);
  const back = 60;
  return {
    east: bottom.east - Math.sin(heading * RAD) * back,
    north: bottom.north - Math.cos(heading * RAD) * back,
    altitude: bottom.ground + 40,
    heading,
    pitch: 5,
  };
}

/**
 * Just below the top of the run, facing down it (ski mode drops you onto it). The very
 * top is often a flat crest, so start a few metres in where the slope has begun.
 */
export function pisteViewpoint(piste: PisteRecord): Pose {
  const { top } = piste;
  const ahead = 15;
  return {
    east: top.east + Math.sin(top.heading * RAD) * ahead,
    north: top.north + Math.cos(top.heading * RAD) * ahead,
    altitude: top.ground + 3,
    heading: top.heading,
    pitch: -10,
  };
}

/**
 * Out on the snow in front of a restaurant, looking at it: in front of its terrace or
 * name board, else a little way down from the hut.
 */
export function restaurantViewpoint(r: Restaurant, building?: Building): Pose {
  let fromEast = r.east;
  let fromNorth = r.north - 1;
  if (r.terrace) {
    const ring = r.terrace.ring;
    fromEast = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    fromNorth = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  } else if (r.sign) {
    fromEast = r.sign.east;
    fromNorth = r.sign.north;
  }
  let dx = fromEast - r.east;
  let dy = fromNorth - r.north;
  const len = Math.hypot(dx, dy);
  [dx, dy] = len > 0.5 ? [dx / len, dy / len] : [0, -1];
  const distance = 26 + (building ? Math.sqrt(Math.abs(footprintArea(building))) / 2 : 0);
  const east = r.east + dx * distance;
  const north = r.north + dy * distance;
  return {
    east,
    north,
    altitude: r.ground,
    heading: bearing(east, north, r.east, r.north),
    pitch: 2,
  };
}

function footprintArea(b: Building): number {
  let sum = 0;
  const ring = b.footprint;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i]!;
    const [x1, y1] = ring[(i + 1) % ring.length]!;
    sum += x0 * y1 - x1 * y0;
  }
  return sum / 2;
}

const LIFT_TYPES: Record<string, string> = {
  cable_car: 'Cable car',
  gondola: 'Gondola',
  mixed_lift: 'Gondola / chair',
  chair_lift: 'Chairlift',
  drag_lift: 'Drag lift',
  't-bar': 'T-bar',
  'j-bar': 'J-bar',
  platter: 'Platter',
  rope_tow: 'Rope tow',
};

export function liftTypeName(type: string): string {
  return LIFT_TYPES[type] ?? type;
}

function inside(extent: Extent, east: number, north: number): boolean {
  return (
    east >= extent.west && east <= extent.east && north >= extent.south && north <= extent.north
  );
}

/** Teleport destinations: the start, named lifts and pistes, and peaks in the resort area. */
export function buildPlaces(
  resortName: string,
  spawn: Pose,
  lifts: Lift[],
  peaks: Peak[],
  extent: Extent,
  pistes: PisteRecord[] = [],
  restaurants: Restaurant[] = [],
  buildings: Building[] = [],
): Place[] {
  const centre = { east: spawn.east, north: spawn.north };
  const places: Place[] = [{ kind: 'start', name: resortName, detail: 'Start', pose: spawn }];
  for (const lift of lifts) {
    if (!lift.name) continue;
    places.push({
      kind: 'lift',
      name: lift.name,
      detail: `${liftTypeName(lift.type)} · ${Math.round(lift.length).toLocaleString('en-GB')} m`,
      pose: liftViewpoint(lift),
    });
  }
  for (const piste of pistes) {
    if (!piste.name) continue;
    const size =
      piste.length > 0
        ? `${(piste.length / 1000).toFixed(1)} km`
        : `${Math.round(piste.vertical)} m vertical`;
    places.push({
      kind: 'piste',
      name: pisteTitle(piste),
      detail: `${pisteKind(piste)} · ${size}`,
      pose: pisteViewpoint(piste),
      colour: pisteColour(piste),
    });
  }
  const byId = new Map(buildings.map((b) => [b.id, b]));
  for (const r of restaurants) {
    const building = r.building !== null ? byId.get(r.building) : undefined;
    const top = building ? building.top + (building.roof?.rise ?? 0) : r.ground + 6;
    places.push({
      kind: 'restaurant',
      name: r.name,
      detail: `Restaurant · ${Math.round(r.ground).toLocaleString('en-GB')} m`,
      pose: restaurantViewpoint(r, building),
      lookAt: { east: r.east, north: r.north, altitude: (r.ground + top) / 2 },
    });
  }
  for (const peak of peaks) {
    if (!inside(extent, peak.east, peak.north)) continue;
    const ele = peak.ele ?? peak.ground;
    places.push({
      kind: 'peak',
      name: peak.name,
      detail: `${Math.round(ele).toLocaleString('en-GB')} m`,
      pose: peakViewpoint(peak, centre),
      lookAt: { east: peak.east, north: peak.north, altitude: peak.ground },
    });
  }
  return places;
}

/**
 * Put a teleport destination on the ground: `eyeHeight` above the terrain, looking at
 * `lookAt` if given (otherwise keeping the pose's heading and a level-ish view).
 */
export function groundedPose(
  pose: Pose,
  groundHeight: (east: number, north: number) => number,
  eyeHeight: number,
  lookAt?: { east: number; north: number; altitude: number },
): Pose {
  const eye = groundHeight(pose.east, pose.north) + eyeHeight;
  if (!lookAt) return { ...pose, altitude: eye, pitch: Math.max(-10, Math.min(pose.pitch, 10)) };
  const distance = Math.hypot(lookAt.east - pose.east, lookAt.north - pose.north);
  return {
    ...pose,
    altitude: eye,
    heading: bearing(pose.east, pose.north, lookAt.east, lookAt.north),
    pitch: (Math.atan2(lookAt.altitude - eye, distance) * 180) / Math.PI,
  };
}
