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
  /** Height of the station's top above its pad (buildings are cut away up to here). */
  roofTop: number;
  /** An operator's hut on the -across side (inside the cleared area). */
  hut: boolean;
  /** How you get in (bottom) or out (top): a side door/gate at the (un)loading point,
   *  from behind the bullwheel, or (chair/drag tops) down the ski-off ramp. */
  entrance: 'side' | 'back' | 'ramp';
  /** Length of the cleared walkway from the station to open snow (m). */
  walk: number;
}

export interface Lift {
  id: number;
  name: string | null;
  /** OSM aerialway=* value, e.g. chair_lift, gondola, cable_car, platter. */
  type: string;
  /** Distance between the up and down cables (m). */
  gauge: number;
  /**
   * Rope tension over weight per metre (m): spans sag L² / (8 · catenary) mid-span
   * (`lifts/rope.ts`). Absent in older builds, whose ropes are straight.
   */
  catenary?: number | null;
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
  /** A piece left above a cut (station, walkway, cable): needs an underside. */
  raised?: boolean;
  /** What it's used for, where that changes how it's drawn (mountain restaurants). */
  use?: 'restaurant';
  /** Stone basement height above `base` (huts on a slope: up to the uphill ground). */
  footing?: number;
  /** Gable roof (null = flat). Faces are the footprint split along the ridge. */
  roof?: {
    ridge: [[number, number], [number, number]];
    halfWidth: number;
    rise: number;
    faces: [number, number][][];
    /** Overhang beyond the walls (m); the faces then cover the eaves too. */
    eaves?: number;
  } | null;
}

/** A mountain restaurant (or bar, café, hut) out on the ski area, from pipeline/restaurants.py. */
export interface Restaurant {
  id: number;
  name: string;
  /** The OSM point (or footprint centre). */
  east: number;
  north: number;
  ground: number;
  /** Id of its building in `buildings`, if it has one. */
  building: number | null;
  /** Sun deck: OSM outdoor seating, or placed on the sunny, downhill side. */
  terrace: { ring: [number, number][]; top: number; source: 'osm' | 'synthetic' } | null;
  /** Name board on the wall: centre position, facing `heading` (deg from north). */
  sign: { east: number; north: number; height: number; heading: number; width: number } | null;
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
  /** Missing in builds from before restaurants were added. */
  restaurants?: Restaurant[];
  /** National borders on the map (from pipeline/borders.py); missing in older builds. */
  borders?: Border[];
  /** Runways, taxiways, aprons, helipads and windsocks (pipeline/airfields.py); missing in
   *  older builds. */
  airfields?: Airfields;
  /** Roads, with their snowbanks and snow poles (pipeline/roads.py); missing in older
   * builds. */
  roads?: Roads;
  /** Named towns, villages and hamlets for map labels (pipeline `map_places`); missing in
   *  older builds. */
  places?: {
    name: string;
    kind: 'town' | 'village' | 'suburb' | 'hamlet' | 'neighbourhood';
    east: number;
    north: number;
  }[];
}

/** A national border line across the map (local metres) and the country either side. */
export interface Border {
  line: [number, number][];
  /** Country to the left and right of the line, walking from its first point. */
  left: string | null;
  right: string | null;
}

/** Winter state: paved and ploughed (snowbanks along it), or a groomed snow surface. */
export type WinterState = 'cleared' | 'groomed';

/** An airfield's or heliport's name, for labels and the teleport list. */
export interface Aerodrome {
  id: number | string;
  name: string;
  kind: 'airfield' | 'heliport';
  icao: string | null;
  iata: string | null;
  /** Label position: the middle of the main runway, where there is one. */
  east: number;
  north: number;
  ground: number;
  /** Published elevation (m), if known. */
  ele: number | null;
}

export interface Runway {
  id: number | string;
  /** "04/22": designators of the line's first and last end. */
  ref: string;
  designators: [string, string];
  /** Centreline from the first designator's threshold to the other's. */
  line: [number, number][];
  length: number;
  width: number;
  /** Bearing of the line (deg from north). */
  heading: number;
  surface: string | null;
  winter: WinterState;
  /** Ground height at each end (m). */
  ends: [number, number];
  source: 'osm' | 'ourairports';
}

export interface Taxiway {
  id: number;
  line: [number, number][];
  width: number;
  surface: string | null;
  winter: WinterState;
}

export interface Apron {
  id: number;
  name: string | null;
  ring: [number, number][];
  surface: string | null;
  winter: WinterState;
}

export interface Helipad {
  id: number;
  name: string | null;
  east: number;
  north: number;
  /** The mapped outline, if it's a way. */
  ring: [number, number][] | null;
  shape: 'square' | 'circle';
  /** Side (or diameter) of the pad (m), and the bearing of its long side. */
  size: number;
  heading: number;
  surface: string | null;
  winter: WinterState;
  /** On a building's (flat) roof. */
  roof: boolean;
  building: number | null;
  /** Height of the pad surface (m). */
  top: number;
}

export interface Airfields {
  aerodromes: Aerodrome[];
  runways: Runway[];
  taxiways: Taxiway[];
  aprons: Apron[];
  helipads: Helipad[];
  windsocks: { id: number; east: number; north: number; ground: number }[];
  /** Ploughed snowbank lines beside cleared surfaces (with gaps to ski through). */
  snowbanks: [number, number][][];
  /** Edge markers on groomed snow surfaces: [east, north, ground]. */
  markers: [number, number, number][];
}

/** OSM `highway` classes the pipeline keeps (`osm.ROAD_CLASSES`). */
export type RoadClass =
  | 'motorway'
  | 'trunk'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'motorway_link'
  | 'trunk_link'
  | 'primary_link'
  | 'secondary_link'
  | 'tertiary_link'
  | 'unclassified'
  | 'residential'
  | 'living_street'
  | 'service'
  | 'track';

/** A road (one OSM way), from pipeline/roads.py. */
export interface Road {
  id: number;
  class: RoadClass;
  name: string | null;
  ref: string | null;
  /** Carriageway width (m): tagged, from its lanes, or a class default. */
  width: number;
  widthSource: 'osm' | 'lanes' | 'estimate';
  surface: string | null;
  /** Ploughed asphalt, or under the snow (closed in winter, a track, unpaved). */
  winter: 'cleared' | 'snow';
  structure: 'bridge' | 'tunnel' | null;
  /** Centreline (local metres). */
  line: [number, number][];
  /** What's drawn in the world where part of the road is under an airfield's surface. */
  drawn?: [number, number][][];
}

export interface Roads {
  /** Minor roads first, so main roads draw over them at junctions. */
  roads: Road[];
  /** Ploughed bank lines along cleared roads (synthetic). */
  snowbanks: [number, number][][];
  /** Snow poles along cleared mountain roads: [east, north] (synthetic). */
  poles: [number, number][];
}
