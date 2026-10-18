// Types for data/processed/<resort>/features.json, written by pipeline/features.py.
// Coordinates are local ENU metres; heights are metres above sea level.

export type SupportKind = 'station' | 'tower' | 'synthetic-tower';

export interface LiftSupport {
  east: number;
  north: number;
  ground: number;
  /** Cable height at this support. */
  top: number;
  kind: SupportKind;
  /** Stations only: OSM has a station building footprint here, so don't draw a box. */
  stationBuilding?: boolean;
}

/** A generated lift terminal (station), from pipeline/terminals.py. */
export interface Terminal {
  end: 'bottom' | 'top';
  kind: 'chair' | 'gondola' | 'cabin' | 'drag';
  detachable: boolean;
  /** Bullwheel centre (local ENU). */
  east: number;
  north: number;
  /** Unit vector (east, north) from the bullwheel into the line. */
  dir: [number, number];
  /** Unit vector (east, north) to the uphill track's side. */
  across: [number, number];
  gauge: number;
  /** Hall extent: in front of the bullwheel, behind it, and across. */
  length: number;
  back: number;
  width: number;
  /** Where loading / unloading happens, metres in front of the bullwheel. */
  load: number;
  unload: number;
  /** Flattened pad height (m above sea level). */
  pad: number;
  ramp: { length: number; drop: number; halfWidth: number } | null;
}

export interface Lift {
  id: number;
  name: string | null;
  /** OSM aerialway=* value, e.g. chair_lift, gondola, cable_car, platter. */
  type: string;
  /** Distance between the up and down cables (m). */
  gauge: number;
  length: number;
  vertical: number;
  /** Bottom station first. */
  supports: LiftSupport[];
  /** Published specs from OSM, where tagged. */
  occupancy?: number | null;
  /** People per hour. */
  capacity?: number | null;
  /** Ride time in seconds. */
  duration?: number | null;
  bubble?: boolean;
  detachable?: boolean;
  /** Bottom, then top. */
  terminals: Terminal[];
}

export interface Building {
  id: number;
  type: string | null;
  /** Outer ring as [east, north] pairs, not closed. */
  footprint: [number, number][];
  base: number;
  top: number;
  heightSource: 'osm-height' | 'osm-levels' | 'estimate';
  /** Gable roof (null = flat). Faces are the footprint split along the ridge. */
  roof?: {
    ridge: [[number, number], [number, number]];
    halfWidth: number;
    rise: number;
    faces: [number, number][][];
  } | null;
}

export interface Peak {
  id: number;
  name: string;
  /** Published elevation from OSM, if tagged. */
  ele: number | null;
  /** Position snapped to the DEM summit. */
  east: number;
  north: number;
  ground: number;
}

export interface ResortFeatures {
  lifts: Lift[];
  buildings: Building[];
  peaks: Peak[];
}
