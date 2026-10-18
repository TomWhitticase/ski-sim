import type { Lift, Peak } from '../features/types';
import type { Extent } from '../resort/manifest';
import type { Pose } from './pose';

export type PlaceKind = 'start' | 'peak' | 'lift';

export interface Place {
  kind: PlaceKind;
  name: string;
  detail: string;
  /** Where to put the camera when teleporting here. */
  pose: Pose;
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

/** Teleport destinations: the start, every named lift, and every peak in the resort area. */
export function buildPlaces(
  resortName: string,
  spawn: Pose,
  lifts: Lift[],
  peaks: Peak[],
  extent: Extent,
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
  for (const peak of peaks) {
    if (!inside(extent, peak.east, peak.north)) continue;
    const ele = peak.ele ?? peak.ground;
    places.push({
      kind: 'peak',
      name: peak.name,
      detail: `${Math.round(ele).toLocaleString('en-GB')} m`,
      pose: peakViewpoint(peak, centre),
    });
  }
  return places;
}
