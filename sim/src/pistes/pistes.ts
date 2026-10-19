import { DataTexture, LinearFilter, LinearMipmapLinearFilter } from 'three/webgpu';

import type { ParkLayout } from '../parks/park-shapes';
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

/**
 * OSM `piste:type`s the pipeline keeps, in lookup-grid code order (B channel high
 * nibble). Downhill runs are coloured by difficulty; the rest by type.
 */
export const RUN_TYPES = {
  downhill: { name: 'Piste', colour: null },
  snow_park: { name: 'Snow park', colour: '#ff6e00' },
  sled: { name: 'Sledging run', colour: '#8c46be' },
  nordic: { name: 'Cross-country track', colour: '#0096aa' },
  playground: { name: "Kids' area", colour: '#eb5aaa' },
  skitour: { name: 'Ski touring route', colour: '#966e28' },
  hike: { name: 'Winter walk', colour: '#78553c' },
  connection: { name: 'Connection', colour: '#82828c' },
} as const;

export type RunType = keyof typeof RUN_TYPES;
const TYPE_CODES = Object.keys(RUN_TYPES) as RunType[];

export interface PisteRecord {
  index: number;
  name: string | null;
  /** Absent in older builds: downhill. */
  type?: RunType;
  /** 0 = not tagged (only for types other than downhill). */
  difficulty: DifficultyCode | 0;
  groomed: boolean;
  /** Run number (`piste:ref` / `ref`). */
  ref?: string | null;
  oneway?: boolean | null;
  /** Floodlit (part of it at least). */
  lit?: boolean;
  length: number;
  vertical: number;
  top: { east: number; north: number; ground: number; heading: number };
  label: { east: number; north: number };
  lines: [number, number][][];
  areas: [number, number][][];
  tunnels?: [number, number][][];
}

export interface PisteData {
  pistes: PisteRecord[];
  /** [east, north, ground, piste index] */
  markers: [number, number, number, number][];
  /** Generated snow park layouts (see parks/park-shapes.ts). */
  parks?: ParkLayout[];
  /** Floodlight masts along lit runs: [east, north, ground]. */
  lights?: [number, number, number][];
}

export const runType = (p: PisteRecord): RunType => p.type ?? 'downhill';

/** Map/HUD colour: difficulty for runs (and graded connections), else the type's. */
export function pisteColour(p: PisteRecord): string {
  const type = runType(p);
  if (p.difficulty && (type === 'downhill' || type === 'connection')) {
    return DIFFICULTY[p.difficulty].colour;
  }
  return RUN_TYPES[type].colour ?? '#888888';
}

/** "Snow park", "Red", "Off-piste itinerary"... */
export function pisteKind(p: PisteRecord): string {
  const type = runType(p);
  if (type === 'downhill' && p.difficulty) return DIFFICULTY[p.difficulty].name;
  return RUN_TYPES[type].name;
}

export function pisteTitle(p: PisteRecord): string {
  if (p.name) return p.name;
  const type = runType(p);
  if (type !== 'downhill') return RUN_TYPES[type].name;
  const d = DIFFICULTY[p.difficulty || 2];
  return `Unnamed ${d.name.toLowerCase()} piste`;
}

/**
 * The HUD's run row: number and name ("107 Bettex"), plus what it is when that isn't a
 * plain downhill run ("BK Park · Snow park", "Le Lac · Cross-country track · one-way").
 */
export function runLabel(p: PisteRecord): string {
  const ref = p.ref && !p.name?.startsWith(p.ref) ? `${p.ref} ` : '';
  const parts = [ref + pisteTitle(p)];
  const type = runType(p);
  // "Fun Park · Snow park" says it twice: skip the type if the name ends the same way.
  const kind = RUN_TYPES[type].name;
  const last = kind.split(' ').pop()!.toLowerCase();
  if (type !== 'downhill' && p.name && !p.name.toLowerCase().includes(last)) parts.push(kind);
  if (type !== 'downhill' && p.oneway) parts.push('one-way');
  return parts.join(' · ');
}

/** A lookup-grid B value: difficulty in the low nibble, run type code in the high one. */
export function decodeRunCode(b: number): { difficulty: number; type: RunType } {
  return { difficulty: b & 15, type: TYPE_CODES[b >> 4] ?? 'downhill' };
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
 * row 0 = north; R,G = piste index, B = difficulty | type code << 4, see decodeRunCode).
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
    const i = this.offset(east, north);
    if (i < 0) return null;
    const index = this.pixels.data[i]! | (this.pixels.data[i + 1]! << 8);
    return index ? (this.byIndex.get(index) ?? null) : null;
  }

  /** The run type and difficulty stored in the grid itself (no record needed). */
  codeAt(east: number, north: number): { difficulty: number; type: RunType } | null {
    const i = this.offset(east, north);
    if (i < 0 || !(this.pixels.data[i]! | this.pixels.data[i + 1]!)) return null;
    return decodeRunCode(this.pixels.data[i + 2]!);
  }

  private offset(east: number, north: number): number {
    const col = Math.round((east - this.extent.west) / this.cellSize);
    const row = Math.round((this.extent.north - north) / this.cellSize);
    if (col < 0 || row < 0 || col >= this.pixels.width || row >= this.pixels.height) return -1;
    return (row * this.pixels.width + col) * 4;
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
