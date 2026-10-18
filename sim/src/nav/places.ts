import type { Lift, Peak } from '../features/types';
import { DIFFICULTY, type PisteRecord, pisteTitle } from '../pistes/pistes';
import type { Extent } from '../resort/manifest';
import type { Pose } from './pose';

export type PlaceKind = 'start' | 'peak' | 'lift' | 'piste';

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
    const d = DIFFICULTY[piste.difficulty];
    const size =
      piste.length > 0
        ? `${(piste.length / 1000).toFixed(1)} km`
        : `${Math.round(piste.vertical)} m vertical`;
    places.push({
      kind: 'piste',
      name: pisteTitle(piste),
      detail: `${d.name} · ${size}`,
      pose: pisteViewpoint(piste),
      colour: d.colour,
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
