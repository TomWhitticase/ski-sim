// The weather as a field over the resort: Open-Meteo points on a grid (each at its own
// ground height, plus a column of extra heights at the centre) blended by where you are
// and how high, and the cloud deck over each point (base, top, cover) worked out from
// them. Pure, so it's unit-tested; `WeatherState` keeps a snapshot per moment and the
// renderer reads the deck from it (cloud-layer.ts).

import {
  type CloudLayer,
  condensationHeight,
  type Conditions,
  deriveConditions,
  type FieldGrid,
  hourIndex,
  type Sample,
  sampleSeries,
  valueAt,
  type WeatherDay,
} from './weather';

/** Temperature lapse rate (°C/m): heights between and beyond the points follow it. */
export const LAPSE = -0.0065;
/** Most points on the grid (one Open-Meteo call each). */
export const MAX_GRID = 45;
/** No finer than the best models (~1–2 km). */
const MIN_SPACING = 1200;
/** Around the lifts (m). */
const MARGIN = 1500;
/** Relative humidity (%) counted as cloud: models put 2 m humidity at 95–100 % inside it. */
const SATURATED = 95;
/** Pressure-level cloud (%) counted as a deck. */
const LEVEL_CLOUD = 40;
/** Vertical reach of a point's values (m). */
const SIGMA_Z = 200;
/** How far up or down a point's difference from its neighbourhood carries (m). */
const ANOMALY_REACH = 500;
/** Scanning a column for cloud (m). */
const STEP = 30;
/** Thinner decks are noise. */
const MIN_DEPTH = 80;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// --- Where to ask -------------------------------------------------------------------

export interface PlanPoint {
  east: number;
  north: number;
  /** m: the ground there, or an extra height. */
  elevation: number;
}

/** The points one resort-day asks for. */
export interface WeatherPlan {
  grid: FieldGrid;
  /** The grid's `nx * ny` points (row by row from the south-west), then the extra heights. */
  points: PlanPoint[];
  /** A few points for pressure-level cloud: the grid's corners and centre. */
  profiles: { east: number; north: number }[];
}

type LiftLike = { supports: { east: number; north: number; ground: number }[] };

/**
 * The heights for the centre column (m): the bottom of the lifts (the 10th percentile of
 * bottom stations, so one long valley lift doesn't set it), halfway, the top, and 400 m
 * and 1,000 m over it (where the tops of cloud over the summits are).
 */
export function columnHeights(lifts: LiftLike[]): number[] {
  const ends = lifts.filter((l) => l.supports.length >= 2);
  if (ends.length === 0) return [1500, 2500, 3500, 4100];
  const bottoms = ends.map((l) => l.supports[0]!.ground).sort((a, b) => a - b);
  const bottom = bottoms[Math.floor((bottoms.length - 1) * 0.1)]!;
  const top = Math.max(...ends.map((l) => l.supports.at(-1)!.ground));
  const heights = top - bottom < 300 ? [bottom, top] : [bottom, (bottom + top) / 2, top];
  return [...heights, top + 400, top + 1000].map(Math.round);
}

/**
 * A grid over the lifts (plus `MARGIN`, inside the near terrain) of at most `MAX_GRID`
 * points, each at the ground height there, plus the centre column.
 */
export function planWeatherSites(
  lifts: LiftLike[],
  extent: { west: number; east: number; south: number; north: number },
  ground: (east: number, north: number) => number,
  maxGrid = MAX_GRID,
): WeatherPlan {
  const all = lifts.flatMap((l) => l.supports);
  const cx = (extent.west + extent.east) / 2;
  const cy = (extent.south + extent.north) / 2;
  let west = all.length ? Math.min(...all.map((s) => s.east)) - MARGIN : cx - 4000;
  let east = all.length ? Math.max(...all.map((s) => s.east)) + MARGIN : cx + 4000;
  let south = all.length ? Math.min(...all.map((s) => s.north)) - MARGIN : cy - 4000;
  let north = all.length ? Math.max(...all.map((s) => s.north)) + MARGIN : cy + 4000;
  west = Math.max(west, extent.west);
  east = Math.min(east, extent.east);
  south = Math.max(south, extent.south);
  north = Math.min(north, extent.north);
  const w = Math.max(1, east - west);
  const h = Math.max(1, north - south);
  let spacing = Math.max(MIN_SPACING, Math.sqrt((w * h) / maxGrid));
  const count = (span: number) => Math.max(2, Math.round(span / spacing) + 1);
  while (count(w) * count(h) > maxGrid) spacing *= 1.05;
  const nx = count(w);
  const ny = count(h);
  const grid: FieldGrid = { nx, ny, west, south, east, north };
  const points: PlanPoint[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const e = west + (i * w) / (nx - 1);
      const n = south + (j * h) / (ny - 1);
      points.push({ east: e, north: n, elevation: Math.round(ground(e, n)) });
    }
  }
  const mx = (west + east) / 2;
  const my = (south + north) / 2;
  for (const elevation of columnHeights(lifts)) points.push({ east: mx, north: my, elevation });
  const profiles = [
    { east: west, north: south },
    { east, north: south },
    { east: west, north },
    { east, north },
    { east: mx, north: my },
  ];
  return { grid, points, profiles };
}

// --- A moment of the field ----------------------------------------------------------

/** The field at one moment: every point's values and the deck over each grid point. */
export interface FieldSnapshot {
  at: number;
  grid: FieldGrid;
  samples: Sample[];
  /** Per grid point; base and top filled in everywhere when `hasLayer`. */
  layers: CloudLayer[];
  hasLayer: boolean;
  /** Per grid point, how much each sample says about it (horizontal distance). */
  weights: Float64Array[];
}

/** Horizontal weights depend only on where the points are: once per day. */
const WEIGHTS = new WeakMap<WeatherDay, Float64Array[]>();

function siteWeights(day: WeatherDay): Float64Array[] {
  const cached = WEIGHTS.get(day);
  if (cached) return cached;
  const { grid, sites } = day;
  const spacing =
    grid.nx > 1 || grid.ny > 1
      ? Math.max(
          (grid.east - grid.west) / Math.max(1, grid.nx - 1),
          (grid.north - grid.south) / Math.max(1, grid.ny - 1),
        )
      : 3000;
  const sigma = 0.75 * spacing;
  const n = grid.nx * grid.ny;
  const out: Float64Array[] = [];
  for (let s = 0; s < n; s++) {
    const a = sites[s]!;
    const w = new Float64Array(sites.length);
    for (let k = 0; k < sites.length; k++) {
      const b = sites[k]!;
      const d2 = (a.east - b.east) ** 2 + (a.north - b.north) ** 2;
      w[k] = Math.exp((-0.5 * d2) / (sigma * sigma));
    }
    out.push(w);
  }
  WEIGHTS.set(day, out);
  return out;
}

/** The values that change with height, as a grid point's neighbourhood sees them at `z`. */
interface Profile {
  /** Temperature less the lapse rate (°C), so smoothing doesn't flatten it. */
  theta: number;
  humidity: number;
  windX: number;
  windY: number;
  gusts: number;
  freshSnow: number;
}

/**
 * A point's local vertical profile at `z`: the samples near it horizontally, weighted by
 * how close they are in height. Aloft, beyond its own neighbours, the centre column takes
 * over by itself (its weight falls off more slowly than theirs).
 */
function profileAt(
  f: Pick<FieldSnapshot, 'samples' | 'weights'>,
  site: number,
  z: number,
): Profile {
  const w = f.weights[site]!;
  let sw = 0;
  const p: Profile = { theta: 0, humidity: 0, windX: 0, windY: 0, gusts: 0, freshSnow: 0 };
  for (let k = 0; k < f.samples.length; k++) {
    const s = f.samples[k]!;
    const dz = (z - s.elevation) / SIGMA_Z;
    const wk = w[k]! * Math.exp(-0.5 * dz * dz);
    if (wk < 1e-300) continue;
    sw += wk;
    p.theta += wk * (s.temperature - LAPSE * s.elevation);
    p.humidity += wk * s.humidity;
    p.windX += wk * s.windX;
    p.windY += wk * s.windY;
    p.gusts += wk * s.gusts;
    p.freshSnow += wk * s.freshSnow;
  }
  if (sw === 0) {
    // Far beyond every sample: the nearest in height.
    const own = f.samples[site]!;
    return {
      theta: own.temperature - LAPSE * own.elevation,
      humidity: own.humidity,
      windX: own.windX,
      windY: own.windY,
      gusts: own.gusts,
      freshSnow: own.freshSnow,
    };
  }
  for (const k of Object.keys(p) as (keyof Profile)[]) p[k] /= sw;
  return p;
}

/** How much of a point's own difference from its neighbourhood is left `dz` metres away. */
const anomaly = (dz: number) => Math.exp(-Math.abs(dz) / ANOMALY_REACH);

/**
 * A grid point's values carried to `altitude`: its neighbourhood's profile there, plus its
 * own difference from that profile, fading with the height between (temperature,
 * humidity, wind, new snow); cloud, rain and visibility are its own.
 */
function sampleAtHeight(f: FieldSnapshot, site: number, altitude: number): Sample {
  const own = f.samples[site]!;
  const from = profileAt(f, site, own.elevation);
  const to = profileAt(f, site, altitude);
  const k = anomaly(altitude - own.elevation);
  const carry = (mine: number, there: number, here: number) => there + (mine - here) * k;
  return {
    ...own,
    elevation: altitude,
    temperature:
      carry(own.temperature - LAPSE * own.elevation, to.theta, from.theta) + LAPSE * altitude,
    humidity: clamp(carry(own.humidity, to.humidity, from.humidity), 0, 100),
    windX: carry(own.windX, to.windX, from.windX),
    windY: carry(own.windY, to.windY, from.windY),
    gusts: Math.max(0, carry(own.gusts, to.gusts, from.gusts)),
    freshSnow: Math.max(0, carry(own.freshSnow, to.freshSnow, from.freshSnow)),
  };
}

/**
 * The first band where `value(z)` reaches `threshold` over [lo, hi] at least `MIN_DEPTH`
 * deep (thinner ones are noise), with its edges found between steps; `top` null if it
 * runs past `hi`.
 */
function firstBand(
  value: (z: number) => number,
  threshold: number,
  lo: number,
  hi: number,
): { base: number; top: number | null } | null {
  threshold -= 1e-6; // averaging equal values mustn't fall short of them
  let prevZ = lo;
  let prev = value(lo);
  let base: number | null = prev >= threshold ? lo : null;
  for (let z = lo + STEP; z <= hi + 1e-6; z += STEP) {
    const v = value(z);
    const cross = () => prevZ + ((threshold - prev) / (v - prev || 1)) * (z - prevZ);
    if (base === null && v >= threshold) base = cross();
    else if (base !== null && v < threshold) {
      const top = cross();
      if (top - base >= MIN_DEPTH) return { base, top };
      base = null;
    }
    prevZ = z;
    prev = v;
  }
  return base === null ? null : { base, top: null };
}

/** The band where `value(z)` stays at `threshold` round `z0` (itself in it), within [lo, hi]. */
function bandAround(
  value: (z: number) => number,
  threshold: number,
  z0: number,
  lo: number,
  hi: number,
): { base: number; top: number | null } {
  threshold -= 1e-6;
  const edge = (dir: 1 | -1, end: number) => {
    let prevZ = z0;
    let prev = value(z0);
    for (let z = z0 + dir * STEP; dir > 0 ? z <= end : z >= end; z += dir * STEP) {
      const v = value(z);
      if (v < threshold) return prevZ + ((threshold - prev) / (v - prev || 1)) * (z - prevZ);
      prevZ = z;
      prev = v;
    }
    return null;
  };
  return { base: edge(-1, lo) ?? lo, top: edge(1, hi) };
}

/** Pressure-level cloud over a point at a moment: (height, cloud %) bottom up. */
function levelsAt(day: WeatherDay, east: number, north: number, at: number) {
  if (day.profiles.length === 0) return null;
  let sw = 0;
  const acc = new Map<number, { height: number; cloud: number; w: number }>();
  for (const p of day.profiles) {
    const w = 1 / ((p.east - east) ** 2 + (p.north - north) ** 2 + 1e6);
    const i = hourIndex(p.time, at);
    sw += w;
    for (const l of p.levels) {
      const height = valueAt(l.height, i);
      const cloud = valueAt(l.cloud, i);
      if (Number.isNaN(height) || Number.isNaN(cloud)) continue;
      const a = acc.get(l.pressure) ?? { height: 0, cloud: 0, w: 0 };
      a.height += w * height;
      a.cloud += w * cloud;
      a.w += w;
      acc.set(l.pressure, a);
    }
  }
  if (sw === 0 || acc.size < 2) return null;
  return [...acc.values()]
    .map((a) => ({ height: a.height / a.w, cloud: a.cloud / a.w }))
    .sort((a, b) => a.height - b.height);
}

/** The first deck in pressure-level cloud above `floor`, with its thickest cover. */
function levelBand(levels: { height: number; cloud: number }[], floor: number) {
  const above = levels.filter((l) => l.height >= floor - 100);
  if (above.length < 2) return null;
  const at = (z: number) => {
    if (z <= above[0]!.height) return above[0]!.cloud;
    for (let i = 1; i < above.length; i++) {
      const a = above[i - 1]!;
      const b = above[i]!;
      if (z <= b.height) return lerp(a.cloud, b.cloud, (z - a.height) / (b.height - a.height));
    }
    return above.at(-1)!.cloud;
  };
  const band = firstBand(at, LEVEL_CLOUD, above[0]!.height, above.at(-1)!.height);
  if (!band) return null;
  const top = band.top ?? above.at(-1)!.height;
  let cover = 0;
  for (let z = band.base; z <= top; z += STEP) cover = Math.max(cover, at(z));
  return { base: band.base, top, cover: cover / 100 };
}

/** `measured`: from saturation or pressure levels, not just a cover figure. */
type SiteLayer = CloudLayer & { known: boolean; measured: boolean };

/**
 * The deck over a grid point. In order of trust:
 * 1. where its neighbourhood's humidity is saturated (the models' own clouds at the
 *    heights of real places), topped by pressure-level cloud if the band runs out of points;
 * 2. pressure-level cloud;
 * 3. low (or mid) cloud cover under a level base: the condensation level over every
 *    sample, since none of them is in it.
 * A point above its deck can't say how much of the sky below it is covered (`known` false):
 * its neighbours fill that in.
 */
function siteLayer(
  day: WeatherDay,
  f: FieldSnapshot,
  site: number,
  floor: number,
  zLo: number,
  zHi: number,
  ceiling: number,
): SiteLayer {
  const own = f.samples[site]!;
  const z0 = own.elevation;
  const base0 = profileAt(f, site, z0).humidity;
  const humidity = (z: number) =>
    clamp(profileAt(f, site, z).humidity + (own.humidity - base0) * anomaly(z - z0), 0, 100);
  const low = own.cloudLow / 100;
  const mid = own.cloudMid / 100;
  const pos = day.sites[site]!;
  const levels = levelsAt(day, pos.east, pos.north, f.at);
  const fromLevels = levels ? levelBand(levels, floor) : null;
  const none: SiteLayer = { base: NaN, top: NaN, cover: 0, mid: 0, known: true, measured: false };

  let layer: SiteLayer | null = null;
  // A point in cloud is in its own band; one under it looks for the first band above the valleys.
  const band =
    own.humidity >= SATURATED
      ? bandAround(humidity, SATURATED, z0, zLo, zHi)
      : firstBand(humidity, SATURATED, zLo, zHi);
  if (band) {
    let top = band.top;
    if (top === null) {
      top =
        fromLevels && fromLevels.top > band.base && fromLevels.base < band.base + 600
          ? fromLevels.top
          : Math.max(band.base + 300 + 700 * Math.max(low, mid), zHi + 200);
    }
    // A point under or in the band: its own cover; in it, it's overcast whatever that says.
    const inIt = z0 >= band.base && z0 <= top;
    const cover = Math.max(low, inIt ? 0.9 : 0.6);
    layer = { base: band.base, top, cover, mid: 0, known: z0 <= top + EDGE_KNOWN, measured: true };
  } else if (fromLevels && fromLevels.cover >= LEVEL_CLOUD / 100) {
    const isMid = fromLevels.base > z0 + 1500 ? 1 : 0;
    const cover = Math.max(isMid ? mid : low, fromLevels.cover * 0.9);
    layer = {
      base: fromLevels.base,
      top: fromLevels.top,
      cover,
      mid: isMid,
      known: z0 <= fromLevels.top + EDGE_KNOWN,
      measured: true,
    };
  } else if (low >= 0.3) {
    layer = {
      base: ceiling,
      top: ceiling + 250 + 900 * low,
      cover: low,
      mid: 0,
      known: true,
      measured: false,
    };
  } else if (mid >= 0.35) {
    const base = Math.max(ceiling, floor + 2000);
    layer = { base, top: base + 1200, cover: mid, mid: 1, known: true, measured: false };
  }
  if (!layer || layer.top - layer.base < MIN_DEPTH) return none;
  return layer;
}

/** A point this far over its deck's top is above it. */
const EDGE_KNOWN = 50;

/** A point a model left without temperature or humidity takes the others' (lapse-corrected). */
function fillGaps(samples: Sample[]): void {
  const ok = samples.filter((s) => !Number.isNaN(s.temperature) && !Number.isNaN(s.humidity));
  if (ok.length === samples.length) return;
  const theta = ok.reduce((a, s) => a + s.temperature - LAPSE * s.elevation, 0) / (ok.length || 1);
  const humidity = ok.reduce((a, s) => a + s.humidity, 0) / (ok.length || 1);
  for (const s of samples) {
    if (Number.isNaN(s.temperature)) s.temperature = ok.length ? theta + LAPSE * s.elevation : -5;
    if (Number.isNaN(s.humidity)) s.humidity = ok.length ? humidity : 50;
  }
}

/** Every point's values at `at`, and the deck over each grid point. */
export function sampleField(day: WeatherDay, at: number): FieldSnapshot {
  const samples = day.sites.map((s) => sampleSeries(s, at));
  fillGaps(samples);
  const weights = siteWeights(day);
  const n = day.grid.nx * day.grid.ny;
  const f: FieldSnapshot = { at, grid: day.grid, samples, layers: [], hasLayer: false, weights };
  const heights = samples.map((s) => s.elevation);
  const floor = Math.min(...heights.slice(0, n));
  const zLo = Math.min(...heights) - 300;
  const zHi = Math.max(...heights) + 300;
  // No sample is in a cloud based lower than its condensation level.
  const ceiling = Math.max(
    ...samples.map((s) => s.elevation + condensationHeight(s.temperature, s.humidity)),
  );
  const raw: SiteLayer[] = [];
  for (let s = 0; s < n; s++) raw.push(siteLayer(day, f, s, floor, zLo, zHi, ceiling));

  // A point that only has a cover figure puts its cloud where the measured decks are.
  const measured = raw.filter((l) => l.measured && l.cover > 0);
  if (measured.length > 0) {
    for (let s = 0; s < n; s++) {
      const l = raw[s]!;
      if (l.measured || l.cover === 0) continue;
      const p = day.sites[s]!;
      let sw = 0;
      let base = 0;
      let top = 0;
      let mid = 0;
      for (let k = 0; k < n; k++) {
        const o = raw[k]!;
        if (!o.measured || o.cover === 0) continue;
        const q = day.sites[k]!;
        const w = 1 / ((p.east - q.east) ** 2 + (p.north - q.north) ** 2 + 1e4);
        sw += w;
        base += w * o.base;
        top += w * o.top;
        mid += w * o.mid;
      }
      l.base = base / sw;
      l.top = top / sw;
      l.mid = mid / sw;
      l.known = samples[s]!.elevation <= l.top + EDGE_KNOWN;
    }
  }

  // A dry point higher than the cloud tops of the grid points round it is above the deck
  // (a sea of cloud below it): it can't say how much of the valley is covered either.
  const { nx, ny } = day.grid;
  for (let s = 0; s < n; s++) {
    const l = raw[s]!;
    if (l.cover > 0) continue;
    const i = s % nx;
    const j = Math.floor(s / nx);
    let top = -Infinity;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const o = raw[(j + dj) * nx + i + di];
        if (i + di < 0 || i + di >= nx || j + dj < 0 || j + dj >= ny || !o?.cover) continue;
        top = Math.max(top, o.top);
      }
    }
    if (top > -Infinity && samples[s]!.elevation > top + EDGE_KNOWN) l.known = false;
  }

  // Fill in what a point can't say from the others (inverse distance squared): a point
  // above its deck takes the cover, base and top of the points in or under one; a point
  // with no deck keeps the height of the others' (so blending a cloudy and a clear point
  // keeps the cloud where it is).
  const known = new Set(raw.filter((l) => l.known));
  const decks = new Set(raw.filter((l) => l.cover > 0));
  const seen = new Set([...decks].filter((l) => l.known));
  const levels = seen.size > 0 ? seen : decks;
  f.hasLayer = decks.size > 0;
  for (let s = 0; s < n; s++) {
    const l = raw[s]!;
    const p = day.sites[s]!;
    const idw = (from: Set<SiteLayer>, key: 'base' | 'top' | 'cover' | 'mid') => {
      let sw = 0;
      let sum = 0;
      for (let k = 0; k < n; k++) {
        const o = raw[k]!;
        if (!from.has(o)) continue;
        const q = day.sites[k]!;
        const w = 1 / ((p.east - q.east) ** 2 + (p.north - q.north) ** 2 + 1e4);
        sw += w;
        sum += w * o[key];
      }
      return sw > 0 ? sum / sw : 0;
    };
    const out: CloudLayer = { base: l.base, top: l.top, cover: l.cover, mid: l.mid };
    if (!l.known) out.cover = idw(known, 'cover');
    if ((!l.known || l.cover === 0) && f.hasLayer) {
      out.base = idw(levels, 'base');
      out.top = idw(levels, 'top');
      out.mid = idw(levels, 'mid');
    }
    f.layers.push(out);
  }
  return f;
}

// --- Where you are ------------------------------------------------------------------

/** The four grid points around a place, with their weights. */
function corners(grid: FieldGrid, east: number, north: number): [number, number][] {
  const gx = grid.nx > 1 ? ((east - grid.west) / (grid.east - grid.west)) * (grid.nx - 1) : 0;
  const gy = grid.ny > 1 ? ((north - grid.south) / (grid.north - grid.south)) * (grid.ny - 1) : 0;
  const fx = clamp(gx, 0, grid.nx - 1);
  const fy = clamp(gy, 0, grid.ny - 1);
  const i0 = Math.min(Math.max(0, grid.nx - 2), Math.floor(fx));
  const j0 = Math.min(Math.max(0, grid.ny - 2), Math.floor(fy));
  const i1 = Math.min(grid.nx - 1, i0 + 1);
  const j1 = Math.min(grid.ny - 1, j0 + 1);
  const tx = fx - i0;
  const ty = fy - j0;
  return [
    [j0 * grid.nx + i0, (1 - tx) * (1 - ty)],
    [j0 * grid.nx + i1, tx * (1 - ty)],
    [j1 * grid.nx + i0, (1 - tx) * ty],
    [j1 * grid.nx + i1, tx * ty],
  ];
}

/** The deck over a place (bilinear between grid points; beyond the grid, its edge). */
export function layerAt(f: FieldSnapshot, east: number, north: number): CloudLayer | null {
  if (!f.hasLayer) return null;
  const out: CloudLayer = { base: 0, top: 0, cover: 0, mid: 0 };
  for (const [s, w] of corners(f.grid, east, north)) {
    const l = f.layers[s]!;
    out.base += w * l.base;
    out.top += w * l.top;
    out.cover += w * l.cover;
    out.mid += w * l.mid;
  }
  return out;
}

/** The conditions at a place (local metres) and `altitude` (m). */
export function fieldConditions(
  f: FieldSnapshot,
  east: number,
  north: number,
  altitude: number,
): Conditions {
  const blend = {} as Sample;
  let visibility = 0;
  let visibilityWeight = 0;
  for (const [s, w] of corners(f.grid, east, north)) {
    if (w <= 0) continue;
    const v = sampleAtHeight(f, s, altitude);
    for (const k of Object.keys(v) as (keyof Sample)[]) {
      if (k === 'visibility') continue;
      blend[k] = (blend[k] ?? 0) + w * v[k];
    }
    if (!Number.isNaN(v.visibility)) {
      visibility += w * v.visibility;
      visibilityWeight += w;
    }
  }
  blend.visibility = visibilityWeight > 0 ? visibility / visibilityWeight : NaN;
  blend.elevation = altitude;
  return deriveConditions(blend, layerAt(f, east, north), altitude);
}

/** The grid's centre (local metres): where the menu's hours are worked out without a place. */
export function gridCentre(grid: FieldGrid): { east: number; north: number } {
  return { east: (grid.west + grid.east) / 2, north: (grid.south + grid.north) / 2 };
}

/** The conditions at a place and moment, straight from a day (the menu's hours, tests). */
export function conditionsAt(
  day: WeatherDay,
  at: number,
  altitude: number,
  east = gridCentre(day.grid).east,
  north = gridCentre(day.grid).north,
): Conditions {
  return fieldConditions(sampleField(day, at), east, north, altitude);
}
