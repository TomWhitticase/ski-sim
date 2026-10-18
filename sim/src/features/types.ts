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
}

export interface Building {
  id: number;
  type: string | null;
  /** Outer ring as [east, north] pairs, not closed. */
  footprint: [number, number][];
  base: number;
  top: number;
  heightSource: 'osm-height' | 'osm-levels' | 'estimate';
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
