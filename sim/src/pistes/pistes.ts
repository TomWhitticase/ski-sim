import { DataTexture, LinearFilter, LinearMipmapLinearFilter } from 'three/webgpu';

import type { Extent } from '../resort/manifest';

/** OSM difficulty codes written by pipeline/pistes.py. */
export const DIFFICULTY = {
  1: { name: 'Green', osm: 'novice', colour: '#2e9e44' },
  2: { name: 'Blue', osm: 'easy', colour: '#1c6edc' },
  3: { name: 'Red', osm: 'intermediate', colour: '#d62828' },
  4: { name: 'Black', osm: 'advanced', colour: '#19191c' },
  5: { name: 'Black', osm: 'expert', colour: '#19191c' },
  6: { name: 'Off-piste itinerary', osm: 'freeride', colour: '#f08c00' },
} as const;

export type DifficultyCode = keyof typeof DIFFICULTY;

export interface PisteRecord {
  index: number;
  name: string | null;
  difficulty: DifficultyCode;
  groomed: boolean;
  length: number;
  vertical: number;
  top: { east: number; north: number; ground: number; heading: number };
  label: { east: number; north: number };
  lines: [number, number][][];
  areas: [number, number][][];
}

export interface PisteData {
  pistes: PisteRecord[];
  /** [east, north, ground, piste index] */
  markers: [number, number, number, number][];
}

export function pisteTitle(p: PisteRecord): string {
  const d = DIFFICULTY[p.difficulty];
  return p.name ?? `Unnamed ${d.name.toLowerCase()} piste`;
}

/** Decode a PNG without colour management or premultiplication (the bytes are data). */
export async function loadPixels(url: string): Promise<ImageData> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url} (HTTP ${res.status})`);
  const bitmap = await createImageBitmap(await res.blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height, { colorSpace: 'srgb' });
}

/**
 * "Which piste is here?" from the pipeline's coarse lookup grid (grid-registered,
 * row 0 = north; R,G = piste index, B = difficulty).
 */
export class PisteLookup {
  private readonly byIndex = new Map<number, PisteRecord>();

  constructor(
    private readonly pixels: ImageData,
    private readonly cellSize: number,
    private readonly extent: Extent,
    pistes: PisteRecord[],
  ) {
    for (const p of pistes) this.byIndex.set(p.index, p);
  }

  at(east: number, north: number): PisteRecord | null {
    const col = Math.round((east - this.extent.west) / this.cellSize);
    const row = Math.round((this.extent.north - north) / this.cellSize);
    if (col < 0 || row < 0 || col >= this.pixels.width || row >= this.pixels.height) return null;
    const i = (row * this.pixels.width + col) * 4;
    const index = this.pixels.data[i]! | (this.pixels.data[i + 1]! << 8);
    return index ? (this.byIndex.get(index) ?? null) : null;
  }
}

/** The overlay (RGB = premultiplied piste colour, A = coverage) as a GPU texture. */
export function overlayTexture(pixels: ImageData): DataTexture {
  const texture = new DataTexture(new Uint8Array(pixels.data.buffer), pixels.width, pixels.height);
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}
