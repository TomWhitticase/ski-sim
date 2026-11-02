import { type PerspectiveCamera, Vector3 } from 'three/webgpu';

import type { Extent } from '../resort/manifest';
import type { Aerodrome, Building, Lift, Peak, Restaurant } from '../features/types';
import { liftTypeName } from '../nav/places';

export type LabelKind = 'lift' | 'peak' | 'restaurant' | 'airfield';

export interface LabelSpec {
  kind: LabelKind;
  name: string;
  detail: string;
  /** World-space anchor. */
  position: Vector3;
  /** Hidden beyond this distance (m). */
  maxDistance: number;
  /** Labels with a lower tier win overlaps first; ties go to the nearer label. */
  tier: number;
  /** Tier to use beyond NEAR_DISTANCE, if different (distant lifts yield to big peaks). */
  farTier?: number;
  /** Icon at the tag's left (theme in style.css): what kind of place this is. */
  icon?: LabelIcon;
  /**
   * Reach and rank while flying (a plane, helicopter or the drone), if they differ: an
   * airfield is something to navigate to from far off. `distance` adds the range to the
   * detail ("Airfield · LFLJ · 2,006 m · 12.4 km").
   */
  flying?: { maxDistance: number; tier: number; distance?: boolean };
}

/** How far a label reaches and how it ranks right now (`distance` from the camera, m). */
export function labelRule(
  label: LabelSpec,
  distance: number,
  flying: boolean,
): { maxDistance: number; tier: number; showDistance: boolean } {
  if (flying && label.flying) {
    const f = label.flying;
    return { maxDistance: f.maxDistance, tier: f.tier, showDistance: f.distance ?? false };
  }
  const tier = distance > NEAR_DISTANCE ? (label.farTier ?? label.tier) : label.tier;
  return { maxDistance: label.maxDistance, tier, showDistance: false };
}

/** "850 m", "4.2 km", "18 km": a range on a label (to 100 m under 10 km). */
export function rangeText(metres: number): string {
  if (metres < 1000) return `${Math.max(0, Math.round(metres / 10) * 10)} m`;
  if (metres < 9950) return `${(metres / 1000).toFixed(1)} km`;
  return `${Math.round(metres / 1000)} km`;
}

export type LabelIcon =
  'peak' | 'restaurant' | 'chair' | 'gondola' | 'cable-car' | 'drag' | 'airfield' | 'heliport';

/** The icon for a lift type: chairs, gondolas (and mixed), cable cars, and the drags. */
export function liftIcon(type: string): LabelIcon {
  if (type === 'chair_lift') return 'chair';
  if (type === 'gondola' || type === 'mixed_lift') return 'gondola';
  if (type === 'cable_car') return 'cable-car';
  return 'drag';
}

/** Lift label sits just above the bottom station, where you'd board. */
export function liftLabel(lift: Lift): LabelSpec | null {
  if (!lift.name) return null;
  const station = lift.terminals.find((t) => t.end === 'bottom');
  let east: number, north: number, top: number;
  if (station) {
    // Over the hall, a little in front of the bullwheel.
    const ahead = Math.max(0, station.length / 2 - station.back / 2);
    east = station.east + station.dir[0] * ahead;
    north = station.north + station.dir[1] * ahead;
    top = station.pad + station.roofTop;
  } else {
    // No generated terminal: the lower end of the line, above the cable.
    const s = lift.supports;
    const end = s[0]!.ground <= s[s.length - 1]!.ground ? s[0]! : s[s.length - 1]!;
    ({ east, north } = end);
    top = Math.max(end.top, end.ground);
  }
  return {
    kind: 'lift',
    name: lift.name,
    detail: liftTypeName(lift.type),
    icon: liftIcon(lift.type),
    position: new Vector3(east, top + 6, -north),
    maxDistance: 7000,
    tier: 0,
    farTier: 2,
  };
}

/** Peaks in the resort area are always candidates; distant giants rank by elevation. */
export function peakLabel(peak: Peak, resortExtent: Extent): LabelSpec {
  const e = resortExtent;
  const local =
    peak.east >= e.west && peak.east <= e.east && peak.north >= e.south && peak.north <= e.north;
  const ele = peak.ele ?? peak.ground;
  return {
    kind: 'peak',
    name: peak.name,
    detail: `${Math.round(ele).toLocaleString('en-GB')} m`,
    position: new Vector3(peak.east, peak.ground + 25, -peak.north),
    maxDistance: local ? 20_000 : 150_000,
    // The great 4000 m peaks on the horizon (Mont Blanc...) always get their label.
    // Among them, the higher summit wins an overlap (Mont Blanc over its satellites).
    tier: ele >= 4000 && !local ? -1 - (ele - 4000) / 1000 : local ? 0 : 1 + (5000 - ele) / 10_000,
  };
}

/**
 * Restaurant tags float over the roof and only show up close (you see the hut you're
 * heading for, not every one in the valley). Lifts and local peaks win overlaps.
 */
export function restaurantLabel(r: Restaurant, building?: Building): LabelSpec {
  const top = building ? building.top + (building.roof?.rise ?? 0) : r.ground + 6;
  // Over the middle of the building, not wherever its OSM point happens to be.
  const [east, north] = building ? centroid(building.footprint) : [r.east, r.north];
  return {
    kind: 'restaurant',
    name: r.name,
    detail: 'Restaurant',
    position: new Vector3(east, top + 3, -north),
    maxDistance: 2200,
    tier: 0.5,
  };
}

/** "Airfield · LFLJ · 2,006 m", "Heliport · 1,850 m". */
export function aerodromeDetail(a: Aerodrome): string {
  const ele = `${Math.round(a.ele ?? a.ground).toLocaleString('en-GB')} m`;
  return [a.kind === 'heliport' ? 'Heliport' : 'Airfield', a.icao, ele].filter(Boolean).join(' · ');
}

/** How far airfield and heliport names reach on foot, and while flying (m). */
export const AERODROME_REACH = {
  airfield: { ground: 7000, flying: 25_000 },
  heliport: { ground: 3000, flying: 12_000 },
};

/**
 * Airfield and heliport names (5): over the runway's middle. On the ground they reach
 * as far as a lift's and rank like one; flying (an aircraft or the drone) they reach much
 * further (heliports nearer than runways), win every overlap and show their range, so you
 * can navigate to one.
 */
export function aerodromeLabel(a: Aerodrome): LabelSpec {
  const reach = AERODROME_REACH[a.kind === 'heliport' ? 'heliport' : 'airfield'];
  return {
    kind: 'airfield',
    name: a.name,
    detail: aerodromeDetail(a),
    icon: a.kind === 'heliport' ? 'heliport' : 'airfield',
    position: new Vector3(a.east, a.ground + 12, -a.north),
    maxDistance: reach.ground,
    // Like a lift's: the nearer of the two wins an overlap.
    tier: 0,
    farTier: 2,
    // Ahead of the 4000 m horizon peaks (tier -1 and below); airfields before heliports.
    flying: { maxDistance: reach.flying, tier: a.kind === 'heliport' ? -2.5 : -3, distance: true },
  };
}

function centroid(ring: [number, number][]): [number, number] {
  let e = 0;
  let n = 0;
  for (const [x, y] of ring) [e, n] = [e + x, n + y];
  return [e / ring.length, n / ring.length];
}

interface Label extends LabelSpec {
  el: HTMLElement;
  detailEl: HTMLElement;
  /** The detail text showing (with or without the range). */
  shownDetail: string;
  width: number;
  height: number;
  occluded: boolean;
  shown: boolean;
}

const OCCLUSION_SAMPLES = 40;
/** Beyond this, labels use their `farTier` (m). */
const NEAR_DISTANCE = 3000;
/** Recheck terrain occlusion for a slice of labels each frame to spread the cost. */
const OCCLUSION_BUDGET = 40;
/** The pointer arrow below each tag, plus breathing room between tags (px). */
const ARROW = 5;
const GAP = 3;

/**
 * Screen-space name tags anchored to world positions. Hidden behind terrain (ray-marched
 * against the heightmap), beyond their max distance, or when they'd overlap a
 * higher-priority label.
 */
export class Labels {
  private readonly labels: Label[];
  private readonly visible: Record<LabelKind, boolean>;
  private readonly projected = new Vector3();
  private cursor = 0;
  private flying = false;

  constructor(
    private readonly root: HTMLElement,
    specs: LabelSpec[],
    private readonly groundHeight: (x: number, z: number) => number,
    visible: Record<LabelKind, boolean>,
  ) {
    this.visible = { ...visible };
    this.labels = specs.map((spec) => {
      const el = document.createElement('div');
      el.className = `label label-${spec.kind}`;
      el.dataset.icon = spec.icon ?? spec.kind;
      el.innerHTML = '<span class="label-name"></span><span class="label-detail"></span>';
      el.querySelector('.label-name')!.textContent = spec.name;
      const detailEl = el.querySelector<HTMLElement>('.label-detail')!;
      detailEl.textContent = spec.detail;
      el.hidden = true;
      root.appendChild(el);
      const shownDetail = spec.detail;
      return {
        ...spec,
        el,
        detailEl,
        shownDetail,
        width: 0,
        height: 0,
        occluded: false,
        shown: false,
      };
    });
    // Measure once, all at the same time, to avoid repeated layout.
    for (const label of this.labels) label.el.hidden = false;
    for (const label of this.labels) {
      label.width = label.el.offsetWidth;
      label.height = label.el.offsetHeight;
    }
    for (const label of this.labels) label.el.hidden = true;
  }

  isVisible(kind: LabelKind): boolean {
    return this.visible[kind];
  }

  setVisible(kind: LabelKind, on: boolean): void {
    this.visible[kind] = on;
  }

  /** In a plane or helicopter, or flying the drone: airfields reach further (`labelRule`). */
  setFlying(on: boolean): void {
    this.flying = on;
  }

  update(camera: PerspectiveCamera): void {
    this.refreshOcclusion(camera.position);

    const width = this.root.clientWidth;
    const height = this.root.clientHeight;
    const candidates: {
      label: Label;
      tier: number;
      reach: number;
      range: boolean;
      x: number;
      y: number;
      distance: number;
    }[] = [];
    for (const label of this.labels) {
      if (!this.visible[label.kind] || label.occluded) continue;
      const distance = label.position.distanceTo(camera.position);
      const rule = labelRule(label, distance, this.flying);
      if (distance > rule.maxDistance) continue;
      // Cull behind the camera in view space: projected depth can't be used for this
      // because its range depends on the depth-buffer convention (reversed-Z here).
      const view = this.projected.copy(label.position).applyMatrix4(camera.matrixWorldInverse);
      if (view.z > -camera.near) continue;
      const p = view.applyMatrix4(camera.projectionMatrix);
      if (p.x < -1.2 || p.x > 1.2 || p.y < -1.2 || p.y > 1.2) continue;
      candidates.push({
        label,
        tier: rule.tier,
        reach: rule.maxDistance,
        range: rule.showDistance,
        x: (p.x * 0.5 + 0.5) * width,
        y: (-p.y * 0.5 + 0.5) * height,
        distance,
      });
    }
    candidates.sort((a, b) => a.tier - b.tier || a.distance - b.distance);

    // Greedy declutter: keep a label only if its box doesn't hit one already placed.
    const placed: { l: number; r: number; t: number; b: number }[] = [];
    const show = new Set<Label>();
    for (const { label, x, y, distance, reach, range } of candidates) {
      this.setDetail(label, range ? `${label.detail} · ${rangeText(distance)}` : label.detail);
      const box = {
        l: x - label.width / 2 - GAP,
        r: x + label.width / 2 + GAP,
        t: y - label.height - GAP,
        b: y + ARROW,
      };
      if (placed.some((o) => box.l < o.r && box.r > o.l && box.t < o.b && box.b > o.t)) continue;
      placed.push(box);
      show.add(label);
      const fade = Math.min(1, (reach - distance) / (reach * 0.2));
      label.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
      label.el.style.opacity = fade.toFixed(2);
    }
    for (const label of this.labels) {
      const on = show.has(label);
      if (on !== label.shown) {
        label.el.hidden = !on;
        label.shown = on;
      }
    }
  }

  /** Change a tag's detail, re-measuring it (only when the text changes). */
  private setDetail(label: Label, text: string): void {
    if (label.shownDetail === text) return;
    label.shownDetail = text;
    label.detailEl.textContent = text;
    const hidden = label.el.hidden;
    label.el.hidden = false;
    label.width = label.el.offsetWidth;
    label.height = label.el.offsetHeight;
    label.el.hidden = hidden;
  }

  private refreshOcclusion(eye: Vector3): void {
    const n = Math.min(OCCLUSION_BUDGET, this.labels.length);
    for (let k = 0; k < n; k++) {
      const label = this.labels[this.cursor]!;
      this.cursor = (this.cursor + 1) % this.labels.length;
      if (this.visible[label.kind]) label.occluded = this.isOccluded(eye, label.position);
    }
  }

  /** True if terrain rises above the straight line from the eye to the anchor. */
  /**
   * Is any tag of this kind (shown or not) on screen within `range` m and not behind
   * the terrain? For the context hints: "Press 2 for peak names" when a summit's in view.
   */
  anyInView(kind: LabelKind, camera: PerspectiveCamera, range: number): boolean {
    for (const label of this.labels) {
      if (label.kind !== kind) continue;
      if (label.position.distanceTo(camera.position) > Math.min(range, label.maxDistance)) continue;
      const view = this.projected.copy(label.position).applyMatrix4(camera.matrixWorldInverse);
      if (view.z > -camera.near) continue;
      const p = view.applyMatrix4(camera.projectionMatrix);
      if (Math.abs(p.x) > 0.85 || Math.abs(p.y) > 0.85) continue;
      if (!this.isOccluded(camera.position, label.position)) return true;
    }
    return false;
  }

  private isOccluded(eye: Vector3, target: Vector3): boolean {
    for (let i = 1; i < OCCLUSION_SAMPLES; i++) {
      const t = i / OCCLUSION_SAMPLES;
      const x = eye.x + (target.x - eye.x) * t;
      const y = eye.y + (target.y - eye.y) * t;
      const z = eye.z + (target.z - eye.z) * t;
      if (this.groundHeight(x, z) > y + 1) return true;
    }
    return false;
  }
}
