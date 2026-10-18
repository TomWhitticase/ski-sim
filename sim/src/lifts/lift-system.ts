import {
  BoxGeometry,
  type BufferGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';

import type { Lift } from '../features/types';
import {
  bullwheelGeometry,
  cabinGeometry,
  chairGeometry,
  gondolaGeometry,
  platterGeometry,
  platterGripGeometry,
  poleGeometry,
  sheaveGeometry,
  towerGeometry,
} from './carriers';
import { type CarrierState, carrierAt, type Operation, operation } from './operation';

const UP = new Vector3(0, 1, 0);
/** Depth tower and station bases are sunk into the ground. */
const BURY = 2;
/** Platter rides this high above the snow. */
const PLATTER_HEIGHT = 0.85;
/** How close to a bottom station you must be to board (m). */
const BOARDING_RADIUS = 35;
/** Carriers farther than this from the camera aren't drawn (m). */
const DRAW_RANGE = 3500;
const X_AXIS = new Vector3(1, 0, 0);
const tilt = new Quaternion();
const q2 = new Quaternion();
const poleTop = new Vector3();
const bottom = new Vector3();

/** One lift line: supports in world space plus its operating model. */
export class LiftLine {
  readonly op: Operation;
  readonly points: Vector3[];
  readonly cumulative: number[];
  readonly across: Vector3;
  readonly seats: number;

  constructor(readonly lift: Lift) {
    this.op = operation(lift);
    this.points = lift.supports.map((s) => new Vector3(s.east, s.top, -s.north));
    this.cumulative = [0];
    for (let i = 1; i < this.points.length; i++) {
      this.cumulative.push(
        this.cumulative[i - 1]! + this.points[i]!.distanceTo(this.points[i - 1]!),
      );
    }
    const first = this.points[0]!;
    const last = this.points[this.points.length - 1]!;
    const along = last.clone().sub(first).setY(0).normalize();
    this.across = new Vector3().crossVectors(along, UP).normalize();
    this.seats = Math.max(1, Math.round(lift.occupancy ?? (this.op.kind === 'gondola' ? 8 : 4)));
  }

  get name(): string {
    return this.lift.name ?? 'Unnamed lift';
  }

  /** Cable point `distance` m up the line on `side`, with the direction of travel. */
  cablePoint(distance: number, side: 1 | -1, out: Vector3, direction?: Vector3): Vector3 {
    const total = this.cumulative[this.cumulative.length - 1]!;
    const d = Math.min(Math.max(distance * (total / this.op.length), 0), total);
    let lo = 0;
    let hi = this.cumulative.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cumulative[mid]! <= d) lo = mid;
      else hi = mid;
    }
    const a = this.points[lo]!;
    const b = this.points[hi]!;
    const span = this.cumulative[hi]! - this.cumulative[lo]!;
    out.copy(a).lerp(b, span > 0 ? (d - this.cumulative[lo]!) / span : 0);
    out.addScaledVector(this.across, (side * this.lift.gauge) / 2);
    if (direction) direction.copy(b).sub(a).normalize().multiplyScalar(side);
    return out;
  }

  /** Horizontal distance from a point to the line's bounding box (m). */
  distanceTo(p: Vector3): number {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const q of this.points) {
      minX = Math.min(minX, q.x);
      maxX = Math.max(maxX, q.x);
      minZ = Math.min(minZ, q.z);
      maxZ = Math.max(maxZ, q.z);
    }
    const dx = Math.max(minX - p.x, 0, p.x - maxX);
    const dz = Math.max(minZ - p.z, 0, p.z - maxZ);
    return Math.hypot(dx, dz);
  }

  /** Bottom station position (cable height). */
  get bottom(): Vector3 {
    return this.points[0]!;
  }

  get top(): Vector3 {
    return this.points[this.points.length - 1]!;
  }
}

interface CarrierGroup {
  mesh: InstancedMesh;
  /** [line index, carrier index] per instance. */
  members: [number, number][];
}

const m = new Matrix4();
const q = new Quaternion();
const pos = new Vector3();
const dir = new Vector3();
const scale = new Vector3();
const ONE = new Vector3(1, 1, 1);

/**
 * Every lift in the resort: static towers, sheaves, bullwheels, cables and stations,
 * plus carriers that run at each lift's real line speed. All instanced; carriers are
 * one draw call per carrier type.
 */
export class LiftSystem {
  readonly root = new Group();
  readonly lines: LiftLine[];
  /** Lift clock (s). Runs faster while the rider fast-forwards. */
  time = 0;
  /** Time multiplier for the lift clock. */
  rate = 1;
  private readonly groups = new Map<string, CarrierGroup>();
  private readonly poles: CarrierGroup;
  private readonly platters: CarrierGroup;
  private readonly tbars: CarrierGroup;

  constructor(
    lifts: Lift[],
    private readonly groundHeight: (x: number, z: number) => number,
  ) {
    this.root.name = 'lifts';
    this.lines = lifts.filter((l) => l.supports.length >= 2).map((l) => new LiftLine(l));
    const vertexColoured = () =>
      new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.25 });
    this.buildStatics(vertexColoured());

    const material = vertexColoured();
    const group = (key: string, geometry: () => BufferGeometry) => {
      if (!this.groups.has(key)) {
        const mesh = new InstancedMesh(geometry(), material, 1);
        mesh.name = `carriers-${key}`;
        this.groups.set(key, { mesh, members: [] });
      }
      return this.groups.get(key)!;
    };
    const make = (key: string, geometry: () => BufferGeometry) => ({
      mesh: new InstancedMesh(geometry(), material, 1),
      members: [] as [number, number][],
      key,
    });
    this.poles = make('poles', poleGeometry);
    this.platters = make('platters', () => platterGeometry(false));
    this.tbars = make('tbars', () => platterGeometry(true));

    this.lines.forEach((line, li) => {
      const { kind, hang } = line.op;
      for (let ci = 0; ci < line.op.carriers; ci++) {
        if (kind === 'chair') {
          group(`chair-${line.seats}`, () => chairGeometry(line.seats, hang)).members.push([
            li,
            ci,
          ]);
        } else if (kind === 'gondola') {
          group(`gondola-${line.seats}`, () => gondolaGeometry(line.seats, hang)).members.push([
            li,
            ci,
          ]);
        } else if (kind === 'cabin') {
          group(`cabin-${line.seats}`, () => cabinGeometry(line.seats, hang)).members.push([
            li,
            ci,
          ]);
        } else {
          group('grips', platterGripGeometry).members.push([li, ci]);
          this.poles.members.push([li, ci]);
          (kind === 'tbar' ? this.tbars : this.platters).members.push([li, ci]);
        }
      }
    });

    for (const g of [...this.groups.values(), this.poles, this.platters, this.tbars]) {
      const count = g.members.length;
      if (count === 0) continue;
      const mesh = new InstancedMesh(g.mesh.geometry, material, count);
      mesh.name = g.mesh.name || 'carriers';
      mesh.castShadow = true;
      mesh.frustumCulled = false; // carriers move along kilometres of line
      g.mesh = mesh;
      this.root.add(mesh);
    }
    this.update(0);
  }

  /** Advance the lift clock and move every carrier. */
  update(dt: number, camera?: Vector3): void {
    this.time += dt * this.rate;
    // Only carriers near the camera are drawn: beyond DRAW_RANGE they're sub-pixel, and
    // a big resort has >10k of them (each drawn in the main pass and every shadow
    // cascade). Visible carriers are packed at the front of each instance buffer.
    const near = this.lines.map((line) => !camera || line.distanceTo(camera) < DRAW_RANGE);
    const close = (p: Vector3) => !camera || p.distanceToSquared(camera) < DRAW_RANGE ** 2;
    for (const g of this.groups.values()) {
      let k = 0;
      for (const [li, ci] of g.members) {
        if (!near[li]) continue;
        this.carrierMatrix(li, ci, m);
        if (!close(pos)) continue;
        g.mesh.setMatrixAt(k++, m);
      }
      g.mesh.count = k;
      if (k) g.mesh.instanceMatrix.needsUpdate = true;
    }
    // Drag lifts: pole from the grip down to the skier's platter, just above the snow.
    let poles = 0;
    const platterCount = { platters: 0, tbars: 0 };
    for (const [li, ci] of this.poles.members) {
      const line = this.lines[li]!;
      if (!near[li]) continue;
      const state = carrierAt(line.op, ci, this.time);
      line.cablePoint(state.distance, state.side, pos, dir);
      if (!close(pos)) continue;
      const ground = this.groundHeight(pos.x, pos.z);
      const length = Math.max(0.3, pos.y - 0.6 - (ground + PLATTER_HEIGHT));
      q.setFromAxisAngle(UP, Math.atan2(-dir.x, -dir.z));
      // Uphill the pole trails back to a skier; on the return it hangs straight.
      const lean = state.side === 1 ? 0.45 : 0;
      tilt.setFromAxisAngle(X_AXIS, -lean);
      poleTop.copy(pos).setY(pos.y - 0.6);
      m.compose(poleTop, q2.copy(q).multiply(tilt), scale.set(1, length / Math.cos(lean), 1));
      this.poles.mesh.setMatrixAt(poles++, m);
      bottom
        .set(0, -length, length * Math.tan(lean))
        .applyQuaternion(q)
        .add(poleTop);
      const key = line.op.kind === 'tbar' ? 'tbars' : 'platters';
      m.compose(bottom, q, ONE);
      this[key].mesh.setMatrixAt(platterCount[key]++, m);
    }
    this.poles.mesh.count = poles;
    this.platters.mesh.count = platterCount.platters;
    this.tbars.mesh.count = platterCount.tbars;
    for (const g of [this.poles, this.platters, this.tbars]) {
      if (g.mesh.count) g.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** World transform of a carrier's grip (origin on the cable, -z = travel direction). */
  carrierMatrix(li: number, ci: number, out: Matrix4): CarrierState {
    const line = this.lines[li]!;
    const state = carrierAt(line.op, ci, this.time);
    line.cablePoint(state.distance, state.side, pos, dir);
    q.setFromAxisAngle(UP, Math.atan2(-dir.x, -dir.z));
    out.compose(pos, q, ONE);
    return state;
  }

  carrierState(li: number, ci: number): CarrierState {
    return carrierAt(this.lines[li]!.op, ci, this.time);
  }

  /** Horizontal distance to the nearest station (bottom or top) of any lift (m). */
  nearestStation(x: number, z: number): number {
    let best = Infinity;
    for (const line of this.lines) {
      best = Math.min(
        best,
        Math.hypot(line.bottom.x - x, line.bottom.z - z),
        Math.hypot(line.top.x - x, line.top.z - z),
      );
    }
    return best;
  }

  /** Distances up the line of each tower (not stations) on a lift. */
  towerDistances(li: number): number[] {
    const line = this.lines[li]!;
    const scale = line.op.length / line.cumulative.at(-1)!;
    return line.lift.supports
      .map((s, i) => (s.kind === 'station' ? -1 : line.cumulative[i]! * scale))
      .filter((d) => d >= 0);
  }

  /** The nearest lift you could board from (x, z), if any bottom station is close. */
  boardingNear(x: number, z: number): number | null {
    let best: number | null = null;
    let bestDistance = BOARDING_RADIUS;
    this.lines.forEach((line, li) => {
      const d = Math.hypot(line.bottom.x - x, line.bottom.z - z);
      if (d < bestDistance) {
        bestDistance = d;
        best = li;
      }
    });
    return best;
  }

  /** The uphill carrier nearest the bottom station (the next one you'd load onto). */
  nextCarrier(li: number): number {
    const op = this.lines[li]!.op;
    let best = 0;
    let bestDistance = Infinity;
    for (let ci = 0; ci < op.carriers; ci++) {
      const s = carrierAt(op, ci, this.time);
      if (s.side === 1 && s.distance < bestDistance) {
        bestDistance = s.distance;
        best = ci;
      }
    }
    return best;
  }

  private buildStatics(material: MeshStandardNodeMaterial): void {
    const towers: Matrix4[] = [];
    const arms: Matrix4[] = [];
    const sheaves: Matrix4[] = [];
    const wheels: Matrix4[] = [];
    const cables: Matrix4[] = [];
    const stations: Matrix4[] = [];
    const boxSites: Vector3[] = [];
    const cableMaterial = new MeshStandardNodeMaterial({ color: 0x1d1f22, roughness: 0.6 });
    const stationMaterial = new MeshStandardNodeMaterial({ color: 0x8a8d93, roughness: 0.8 });

    for (const line of this.lines) {
      const { lift, op } = line;
      const heavy = op.kind === 'cabin';
      const yaw = Math.atan2(-(line.top.x - line.bottom.x), -(line.top.z - line.bottom.z));
      q.setFromAxisAngle(UP, yaw);
      const radius = heavy ? 1.6 : op.kind === 'platter' || op.kind === 'tbar' ? 0.35 : 0.6;

      lift.supports.forEach((s, i) => {
        const top = line.points[i]!;
        if (s.kind === 'station') {
          // Bullwheel at cable height, the loop the carriers turn around.
          wheels.push(m.compose(top, q, scale.set(lift.gauge / 2, 1, lift.gauge / 2)).clone());
          // Lifts often share a station; one placeholder box per site, or the
          // coincident roofs and walls z-fight.
          const shared = boxSites.some((p) => Math.hypot(p.x - top.x, p.z - top.z) < 20);
          if (!s.stationBuilding && !shared) {
            boxSites.push(top.clone());
            const size = heavy ? [lift.gauge + 8, 10, 16] : [lift.gauge + 4, 6, 10];
            const base = s.ground - BURY;
            const roof = Math.max(top.y + 1.5, s.ground + size[1]!);
            pos.set(top.x, (base + roof) / 2, top.z);
            stations.push(m.compose(pos, q, scale.set(size[0]!, roof - base, size[2]!)).clone());
          }
          return;
        }
        const base = s.ground - BURY;
        const armY = top.y + 0.35;
        pos.set(top.x, base, top.z);
        towers.push(m.compose(pos, q, scale.set(radius, armY - base, radius)).clone());
        pos.set(top.x, armY + 0.2, top.z);
        arms.push(m.compose(pos, q, scale.set(lift.gauge + 1.2, 0.35, 0.45)).clone());
        for (const side of [1, -1] as const) {
          line.cablePoint(line.cumulative[i]! * (op.length / line.cumulative.at(-1)!), side, pos);
          sheaves.push(m.compose(pos, q, ONE).clone());
        }
      });

      // Haul rope on each side, span by span.
      for (const side of [1, -1] as const) {
        for (let i = 0; i < line.points.length - 1; i++) {
          const a = line.points[i]!.clone().addScaledVector(line.across, (side * lift.gauge) / 2);
          const b = line.points[i + 1]!.clone().addScaledVector(
            line.across,
            (side * lift.gauge) / 2,
          );
          const span = b.clone().sub(a);
          const thickness = heavy ? 0.12 : 0.06;
          cables.push(
            m
              .compose(
                a.clone().lerp(b, 0.5),
                new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), span.clone().normalize()),
                scale.set(thickness, thickness, span.length()),
              )
              .clone(),
          );
        }
      }
    }

    const add = (
      geometry: BufferGeometry,
      mat: MeshStandardNodeMaterial,
      list: Matrix4[],
      shadows = true,
    ) => {
      if (list.length === 0) return;
      const mesh = new InstancedMesh(geometry, mat, list.length);
      list.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
      mesh.castShadow = shadows;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      this.root.add(mesh);
    };
    add(towerGeometry(), material, towers);
    add(
      new BoxGeometry(1, 1, 1),
      new MeshStandardNodeMaterial({ color: 0x6c7076, metalness: 0.5, roughness: 0.45 }),
      arms,
    );
    // Sheaves and bullwheels are a few cm thick: shadows wouldn't show but would cost
    // every shadow cascade thousands of instances.
    add(sheaveGeometry(), material, sheaves, false);
    add(bullwheelGeometry(), material, wheels, false);
    add(new BoxGeometry(1, 1, 1), cableMaterial, cables, false);
    add(new BoxGeometry(1, 1, 1), stationMaterial, stations);
  }
}
