// Types for data/processed/<resort>/manifest.json, written by pipeline/build.py.

export interface Extent {
  west: number;
  east: number;
  south: number;
  north: number;
}

export interface HeightmapMeta {
  file: string;
  encoding: 'uint16le';
  rowOrder: 'north-to-south';
  width: number;
  height: number;
  cellSize: number;
  extent: Extent;
  heightOffset: number;
  heightScale: number;
  minHeight: number;
  maxHeight: number;
}

export interface Provenance {
  layer: string;
  name: string;
  url: string;
  license: string;
  attribution: string;
}

/** A start location: a ski village, standing in front of its main lift. */
export interface StartBase {
  name: string;
  kind: string;
  lift: string;
  lifts: number;
  east: number;
  north: number;
  ground: number;
  /** Degrees clockwise from north (facing up the lift). */
  heading: number;
}

export interface ResortManifest {
  version: number;
  resort: { id: string; name: string; country: string };
  origin: { lat: number; lon: number };
  projection: string;
  spawn: { east: number; north: number; altitude: number; heading: number };
  bases?: StartBase[];
  terrain: { near: HeightmapMeta; far: HeightmapMeta };
  minimap: { file: string; extent: Extent };
  features: { file: string; lifts: number; buildings: number; peaks: number };
  pistes: {
    file: string;
    overlay: { file: string; cellSize: number };
    lookup: { file: string; cellSize: number };
    extent: Extent;
    count: number;
    markers: number;
  };
  provenance: Provenance[];
}

const SUPPORTED_VERSION = 7;

export function resortUrl(resortId: string, file: string): string {
  return `/${resortId}/${file}`;
}

export async function loadManifest(resortId: string): Promise<ResortManifest> {
  const res = await fetch(resortUrl(resortId, 'manifest.json'));
  if (!res.ok) {
    throw new Error(
      `No processed data for "${resortId}" (HTTP ${res.status}). ` +
        `Run: cd pipeline && uv run ski-sim build ${resortId}`,
    );
  }
  const manifest = (await res.json()) as ResortManifest;
  if (manifest.version !== SUPPORTED_VERSION) {
    throw new Error(
      `Manifest version ${manifest.version} unsupported (expected ${SUPPORTED_VERSION}). ` +
        `Rebuild: cd pipeline && uv run ski-sim build ${resortId}`,
    );
  }
  return manifest;
}
