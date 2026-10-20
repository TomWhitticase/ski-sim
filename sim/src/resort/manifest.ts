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
  /** When the pipeline built this resort (ISO 8601). */
  generatedAt: string;
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
    /** Unprepared share of the overlay's coverage (greyscale, same grid). Older builds
     * have none: their overlay only covered groomed runs. */
    ungroomed?: { file: string };
    lookup: { file: string; cellSize: number };
    /** Night glow mask for floodlit runs, on its own grid (absent if none are lit). */
    lit?: { file: string; cellSize: number; extent: Extent } | null;
    extent: Extent;
    count: number;
    markers: number;
  };
  landCover: {
    /** How the texture's channels encode the layers (see landcover/land-cover.ts). */
    channels: string;
    near: LandCoverMeta;
    far: LandCoverMeta;
    trees: {
      /** Elevation (m) below which nearly all the area's forest grows; null without forest. */
      treeLine: number | null;
      /** Synthetic typical heights (m): in the valleys and at the tree line. */
      height: { valley: number; treeLine: number };
    };
  };
  provenance: Provenance[];
}

/** A land cover image on its own grid (see landcover/land-cover.ts). */
export interface LandCoverMeta {
  file: string;
  cellSize: number;
  extent: Extent;
}

const SUPPORTED_VERSION = 9;

/**
 * Where pipeline output is served from: the site's base path (dev, GitHub Pages), or
 * `VITE_DATA_URL` at build time when the data lives elsewhere (e.g. object storage).
 */
export const DATA_URL =
  (import.meta.env.VITE_DATA_URL as string | undefined) ?? import.meta.env.BASE_URL;

/**
 * The loaded build's timestamp, added to every data URL so a new deploy's files are
 * fetched fresh while an unchanged build stays cached (Pages caches files for 10 min,
 * which otherwise mixes old data with new code).
 */
let buildStamp = '';

export function resortUrl(resortId: string, file: string): string {
  const stamp = buildStamp && file !== 'manifest.json' ? `?v=${buildStamp}` : '';
  return `${DATA_URL}${resortId}/${file}${stamp}`;
}

export async function loadManifest(resortId: string): Promise<ResortManifest> {
  // Revalidate (ETag), so a new deploy's data is picked up at once, not after the cache expires.
  const res = await fetch(resortUrl(resortId, 'manifest.json'), { cache: 'no-cache' });
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
  buildStamp = encodeURIComponent(manifest.generatedAt);
  return manifest;
}
