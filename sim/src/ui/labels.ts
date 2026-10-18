import { type PerspectiveCamera, Vector3 } from 'three/webgpu';

import type { Extent } from '../resort/manifest';
import type { Lift, Peak } from '../features/types';
import { liftTypeName } from '../nav/places';

export type LabelKind = 'lift' | 'peak';

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
}

/** Lift label sits above the middle of the line, half way along its length. */
export function liftLabel(lift: Lift): LabelSpec | null {
  if (!lift.name) return null;
  const s = lift.supports;
  let total = 0;
  const lengths = s.slice(1).map((b, i) => {
    const a = s[i]!;
    const d = Math.hypot(b.east - a.east, b.north - a.north);
    total += d;
    return d;
  });
  let remaining = total / 2;
  let i = 0;
  while (i < lengths.length - 1 && remaining > lengths[i]!) remaining -= lengths[i++]!;
  const a = s[i]!;
  const b = s[i + 1]!;
  const t = lengths[i]! > 0 ? remaining / lengths[i]! : 0;
  const east = a.east + (b.east - a.east) * t;
  const north = a.north + (b.north - a.north) * t;
  const top = a.top + (b.top - a.top) * t;
  return {
    kind: 'lift',
    name: lift.name,
    detail: liftTypeName(lift.type),
    position: new Vector3(east, top + 12, -north),
    maxDistance: 7000,
    tier: 0,
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
    tier: local ? 0 : 1 + (5000 - ele) / 10_000,
  };
}

interface Label extends LabelSpec {
  el: HTMLElement;
  width: number;
  height: number;
  occluded: boolean;
  shown: boolean;
}

const OCCLUSION_SAMPLES = 40;
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
      el.innerHTML = '<span class="label-name"></span><span class="label-detail"></span>';
      el.querySelector('.label-name')!.textContent = spec.name;
      el.querySelector('.label-detail')!.textContent = spec.detail;
      el.hidden = true;
      root.appendChild(el);
      return { ...spec, el, width: 0, height: 0, occluded: false, shown: false };
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

  update(camera: PerspectiveCamera): void {
    this.refreshOcclusion(camera.position);

    const width = this.root.clientWidth;
    const height = this.root.clientHeight;
    const candidates: { label: Label; x: number; y: number; distance: number }[] = [];
    for (const label of this.labels) {
      if (!this.visible[label.kind] || label.occluded) continue;
      const distance = label.position.distanceTo(camera.position);
      if (distance > label.maxDistance) continue;
      const p = this.projected.copy(label.position).project(camera);
      if (p.z > 1 || p.x < -1.2 || p.x > 1.2 || p.y < -1.2 || p.y > 1.2) continue;
      candidates.push({
        label,
        x: (p.x * 0.5 + 0.5) * width,
        y: (-p.y * 0.5 + 0.5) * height,
        distance,
      });
    }
    candidates.sort((a, b) => a.label.tier - b.label.tier || a.distance - b.distance);

    // Greedy declutter: keep a label only if its box doesn't hit one already placed.
    const placed: { l: number; r: number; t: number; b: number }[] = [];
    const show = new Set<Label>();
    for (const { label, x, y, distance } of candidates) {
      const box = {
        l: x - label.width / 2 - GAP,
        r: x + label.width / 2 + GAP,
        t: y - label.height - GAP,
        b: y + ARROW,
      };
      if (placed.some((o) => box.l < o.r && box.r > o.l && box.t < o.b && box.b > o.t)) continue;
      placed.push(box);
      show.add(label);
      const fade = Math.min(1, (label.maxDistance - distance) / (label.maxDistance * 0.2));
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

  private refreshOcclusion(eye: Vector3): void {
    const n = Math.min(OCCLUSION_BUDGET, this.labels.length);
    for (let k = 0; k < n; k++) {
      const label = this.labels[this.cursor]!;
      this.cursor = (this.cursor + 1) % this.labels.length;
      if (this.visible[label.kind]) label.occluded = this.isOccluded(eye, label.position);
    }
  }

  /** True if terrain rises above the straight line from the eye to the anchor. */
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
