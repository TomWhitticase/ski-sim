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

import type { Lift, Terminal } from '../features/types';
import {
  cabinGeometry,
  chairGeometry,
  floorBelowGrip,
  gondolaGeometry,
  platterGeometry,
  platterGripGeometry,
  poleGeometry,
  sheaveGeometry,
  towerGeometry,
} from './carriers';
import { LoopPath, loopCorners, maxStep, type TerminalFrame } from './loop';
import { MAX_CARRIERS, type Operation, operation } from './operation';
import { createTerminals, type Obstacle, type SignMount } from './terminals';

const UP = new Vector3(0, 1, 0);
/** Depth tower bases are sunk into the ground. */
const BURY = 2;
/** Platter rides this high above the snow. */
const PLATTER_HEIGHT = 0.85;
/** Drag-lift rope height above the pad at the terminals (m). */
const DRAG_RAIL = 4;
/** How close to a loading point "press E to ride" is offered (m). */
const BOARDING_RADIUS = 35;
/** Loading zone half-extents around the loading point: along the line, across it (m). */
const ZONE_ALONG = 2.5;
const ZONE_ACROSS = 1.6;
/** Station speed of detached carriers (m/s). */
const STATION_SPEED = { chair: 1.0, gondola: 0.35 } as const;
/** Carriers farther than this from the camera aren't drawn (m). */
const DRAW_RANGE = 3500;
const X_AXIS = new Vector3(1, 0, 0);
const tilt = new Quaternion();
const q2 = new Quaternion();
const poleTop = new Vector3();
const platterAt = new Vector3();

export interface CarrierPose {
  /** +1 on the uphill track, -1 coming back down. */
  side: 1 | -1;
  inStation: boolean;
  /** A jig-back cabin standing at a station. */
  moving: boolean;
  /** Jig-back only: metres from the bottom dock. */
  distance: number;
}

/** A straight-line track between two docks (jig-back cable cars). */
class Track {
  readonly cumulative: number[] = [0];
  constructor(readonly points: Vector3[]) {
    for (let i = 1; i < points.length; i++) {
      this.cumulative.push(this.cumulative[i - 1]! + points[i]!.distanceTo(points[i - 1]!));
    }
  }
  get length(): number {
    return this.cumulative.at(-1)!;
  }
  at(d: number, out: Vector3, dir: Vector3): void {
    const c = Math.min(Math.max(d, 0), this.length);
    let i = 1;
    while (i < this.cumulative.length - 1 && this.cumulative[i]! < c) i++;
    const a = this.points[i - 1]!;
    const b = this.points[i]!;
    const span = this.cumulative[i]! - this.cumulative[i - 1]!;
    out.copy(a).lerp(b, span > 0 ? (c - this.cumulative[i - 1]!) / span : 0);
    dir.copy(b).sub(a).normalize();
  }
}

/** One lift: its terminals, haul-rope path and operating model. */
export class LiftLine {
  readonly op: Operation;
  readonly across: Vector3;
  readonly seats: number;
  readonly bottomTerminal: Terminal;
  readonly topTerminal: Terminal;
  /** Rail (haul rope) height above the pad inside the terminals. */
  readonly rail: number;
  readonly frames: [TerminalFrame, TerminalFrame];
  readonly towers: Vector3[];
  /** Continuous loop (loop lifts). */
  readonly loop: LoopPath | null = null;
  /** Up and down tracks between docks (jig-backs), both measured from the bottom. */
  readonly tracks: [Track, Track] | null = null;
  /** Seconds between carriers on the loop. */
  readonly headway: number;
  /** Loop times at which a carrier passes the loading / unloading points. */
  readonly loadTime: number = 0;
  readonly unloadTime: number = 0;
  /** World positions (on the pad) of the loading and unloading points. */
  readonly loadPoint: Vector3;
  readonly unloadPoint: Vector3;
  /**
   * Gondolas and cable cars also carry you down (some just cross a valley): boarding
   * on the down track at the top station, off at the bottom. Null for chairs and drags.
   */
  readonly down: {
    loadPoint: Vector3;
    unloadPoint: Vector3;
    /** Loop times at the down track's loading (top) and unloading (bottom) points. */
    loadTime: number;
    unloadTime: number;
  } | null = null;
  private readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number };

  constructor(readonly lift: Lift) {
    const base = operation(lift);
    const [bottomT, topT] = lift.terminals as [Terminal, Terminal];
    this.bottomTerminal = bottomT;
    this.topTerminal = topT;
    const b = new Vector3(bottomT.east, 0, -bottomT.north);
    const t = new Vector3(topT.east, 0, -topT.north);
    const along = t.clone().sub(b).setY(0).normalize();
    this.across = new Vector3().crossVectors(along, UP).normalize();
    this.seats = Math.max(1, Math.round(lift.occupancy ?? (base.kind === 'gondola' ? 8 : 4)));
    const isDrag = base.kind === 'platter' || base.kind === 'tbar';
    this.rail = isDrag ? DRAG_RAIL : floorBelowGrip(base.kind, this.seats, base.hang);

    const frame = (term: Terminal): TerminalFrame => ({
      wheel: new Vector3(term.east, term.pad + this.rail, -term.north),
      dir: new Vector3(term.dir[0], 0, -term.dir[1]),
      length: term.length,
    });
    this.frames = [frame(bottomT), frame(topT)];
    this.towers = lift.supports
      .filter((s) => s.kind !== 'station')
      .map((s) => new Vector3(s.east, s.top, -s.north));
    const [fb, ft] = this.frames;
    const r = lift.gauge / 2;
    const onPad = (term: Terminal, u: number, side: number) =>
      new Vector3(term.east, term.pad, -term.north)
        .addScaledVector(new Vector3(term.dir[0], 0, -term.dir[1]), u)
        .addScaledVector(this.across, side * r);
    this.loadPoint = onPad(bottomT, bottomT.load, 1);
    this.unloadPoint = onPad(topT, topT.unload, 1);
    const enclosed = base.kind === 'gondola' || base.kind === 'cabin';
    const downLoad = onPad(topT, topT.load, -1);
    const downUnload = onPad(bottomT, bottomT.load, -1);

    if (base.kind === 'cabin') {
      // Jig-back: two cabins shuttle between docks, one on each track.
      const dock = (f: TerminalFrame, term: Terminal, side: number) =>
        f.wheel
          .clone()
          .addScaledVector(this.across, side * r)
          .addScaledVector(f.dir, term.load);
      const track = (side: number) =>
        new Track([
          dock(fb, bottomT, side),
          ...this.towers.map((p) => p.clone().addScaledVector(this.across, side * r)),
          dock(ft, topT, side),
        ]);
      this.tracks = [track(1), track(-1)];
      this.op = { ...base, length: this.tracks[0].length, carriers: 2 };
      this.headway = 0;
      // Cabin 1 docks at the top (on the -across track) while cabin 0 boards below.
      this.down = { loadPoint: downLoad, unloadPoint: downUnload, loadTime: 0, unloadTime: 0 };
    } else {
      const stationSpeed =
        bottomT.detachable && (base.kind === 'chair' || base.kind === 'gondola')
          ? STATION_SPEED[base.kind]
          : base.speed;
      this.loop = new LoopPath(
        loopCorners(fb, ft, this.towers, this.across, lift.gauge),
        base.speed,
        stationSpeed,
      );
      const carriers = Math.min(
        MAX_CARRIERS,
        Math.max(2, Math.round(this.loop.period / Math.max(base.headway, 1))),
      );
      this.headway = this.loop.period / carriers;
      this.op = { ...base, carriers };
      // Up-track samples are the first half of the loop; search there only.
      const half = Math.floor(this.loop.points.length / 2);
      const rail = (p: Vector3) => p.clone().setY(p.y + this.rail);
      this.loadTime = this.loop.timeAt(this.loop.nearestIndex(rail(this.loadPoint), 0, half));
      this.unloadTime = this.loop.timeAt(
        this.loop.nearestIndex(rail(this.unloadPoint), 0, this.loop.points.length),
      );
      if (enclosed) {
        const n = this.loop.points.length;
        this.down = {
          loadPoint: downLoad,
          unloadPoint: downUnload,
          loadTime: this.loop.timeAt(this.loop.nearestIndex(rail(downLoad), half, n)),
          unloadTime: this.loop.timeAt(this.loop.nearestIndex(rail(downUnload), half, n)),
        };
      }
    }

    const xs = [fb.wheel.x, ft.wheel.x, ...this.towers.map((p) => p.x)];
    const zs = [fb.wheel.z, ft.wheel.z, ...this.towers.map((p) => p.z)];
    this.bounds = {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minZ: Math.min(...zs),
      maxZ: Math.max(...zs),
    };
  }

  get name(): string {
    return this.lift.name ?? 'Unnamed lift';
  }

  get bottom(): Vector3 {
    return this.frames[0].wheel;
  }

  get top(): Vector3 {
    return this.frames[1].wheel;
  }

  /** Horizontal distance from a point to the line's bounding box (m). */
  distanceTo(p: Vector3): number {
    const b = this.bounds;
    return Math.hypot(
      Math.max(b.minX - p.x, 0, p.x - b.maxX),
      Math.max(b.minZ - p.z, 0, p.z - b.maxZ),
    );
  }

  /** Grip position and travel direction of carrier `ci` at lift time `time`. */
  pose(ci: number, time: number, out: Vector3, dir: Vector3): CarrierPose {
    if (this.tracks) {
      const s = jigBack(this.op, ci, time);
      this.tracks[ci === 0 ? 0 : 1].at(s.distance, out, dir);
      if (s.towardTop === false) dir.negate();
      return {
        side: ci === 0 ? 1 : -1,
        inStation: !s.moving,
        moving: s.moving,
        distance: s.distance,
      };
    }
    const loop = this.loop!;
    const tau = time + ci * this.headway;
    const { index, inStation } = loop.at(tau, out, dir);
    return {
      side: index < loop.points.length / 2 ? 1 : -1,
      inStation,
      moving: true,
      distance: 0,
    };
  }

  /** Loop time of carrier `ci` (loop lifts), wrapped to one period. */
  loopTime(ci: number, time: number): number {
    const p = this.loop!.period;
    return (((time + ci * this.headway) % p) + p) % p;
  }

  /** The carrier that next reaches the loading point (`down`: the top one), and when. */
  nextToLoad(time: number, down = false): { carrier: number; inSeconds: number } {
    if (this.tracks) return { carrier: down ? 1 : 0, inSeconds: nextDeparture(this.op, time) };
    // Carrier ci is at loop time (time + ci·h). It reaches loadTime after
    // δ = (loadTime − time − ci·h) mod period seconds; the smallest δ is next.
    const p = this.loop!.period;
    const mark = down ? this.down!.loadTime : this.loadTime;
    const x = (((mark - time) % p) + p) % p;
    const carrier = Math.min(Math.floor(x / this.headway), this.op.carriers - 1);
    return { carrier, inSeconds: x - carrier * this.headway };
  }

  /** Whether carrier `ci` passed loop time `mark` between lift times `from` and `to`. */
  passed(ci: number, mark: number, from: number, to: number): boolean {
    const p = this.loop!.period;
    const travelled = to - from;
    const sinceMark = (((this.loopTime(ci, to) - mark) % p) + p) % p;
    return travelled > 0 && sinceMark <= travelled;
  }

  /**
   * Where you stand to board (world, on the pad): on the loading line for chairs and
   * drags, beside the track for gondolas and cable cars (cabins pass alongside).
   */
  loadingSpot(down = false): Vector3 {
    const t = down ? this.topTerminal : this.bottomTerminal;
    const r = t.gauge / 2;
    const enclosed = this.op.kind === 'gondola' || this.op.kind === 'cabin';
    return new Vector3(t.east, t.pad, -t.north)
      .addScaledVector(new Vector3(t.dir[0], 0, -t.dir[1]), t.load)
      .addScaledVector(this.across, (enclosed ? r + 1.4 : r) * (down ? -1 : 1));
  }

  /** Whether a world point is in this lift's loading zone (on the pad by the loading point). */
  inLoadingZone(p: Vector3): boolean {
    const t = this.bottomTerminal;
    const dx = p.x - this.loadPoint.x;
    const dz = p.z - this.loadPoint.z;
    const along = dx * t.dir[0] - dz * t.dir[1];
    const across = dx * this.across.x + dz * this.across.z;
    // Gondola and cable car riders stand beside the track (cabins pass alongside).
    const enclosed = this.op.kind === 'gondola' || this.op.kind === 'cabin';
    const acrossMin = -ZONE_ACROSS;
    const acrossMax = enclosed ? ZONE_ACROSS + 2.5 : ZONE_ACROSS;
    return (
      Math.abs(along) <= ZONE_ALONG &&
      across >= acrossMin &&
      across <= acrossMax &&
      Math.abs(p.y - this.loadPoint.y) < 2
    );
  }
}

/** Jig-back schedule: cabin 0 waits at the bottom, travels, waits at the top, returns. */
function jigBack(
  op: Operation,
  ci: number,
  t: number,
): { distance: number; moving: boolean; towardTop: boolean | null } {
  const L = op.length;
  const travel = L / op.speed;
  const period = 2 * (travel + op.dwell);
  const phase = ((t % period) + period) % period;
  let d: number;
  let moving = true;
  let up: boolean | null = true;
  if (phase < op.dwell) {
    d = 0;
    moving = false;
    up = null;
  } else if (phase < op.dwell + travel) {
    d = (phase - op.dwell) * op.speed;
  } else if (phase < 2 * op.dwell + travel) {
    d = L;
    moving = false;
    up = null;
  } else {
    d = L - (phase - 2 * op.dwell - travel) * op.speed;
    up = false;
  }
  if (ci === 0) return { distance: d, moving, towardTop: up };
  return { distance: L - d, moving, towardTop: up === null ? null : !up };
}

/** Seconds until the uphill cabin next leaves (0 while boarding). */
export function nextDeparture(op: Operation, t: number): number {
  const period = 2 * (op.length / op.speed + op.dwell);
  const phase = ((t % period) + period) % period;
  return phase < op.dwell ? 0 : period - phase;
}

interface CarrierGroup {
  mesh: InstancedMesh;
  /** [line index, carrier index] per instance. */
  members: [number, number][];
}

/** Tower columns' size: stout for cabins, slim for drags. */
function towerScale(op: Operation): number {
  return op.kind === 'cabin' ? 1.6 : op.kind === 'platter' || op.kind === 'tbar' ? 0.35 : 0.6;
}

const m = new Matrix4();
const q = new Quaternion();
const pos = new Vector3();
const dir = new Vector3();
const scale = new Vector3();
const ONE = new Vector3(1, 1, 1);

/**
 * Every lift in the resort: generated terminals, towers, sheaves and ropes, plus carriers
 * that run round each lift's loop at its real speeds. All instanced; carriers are one
 * draw call per carrier type.
 */
export class LiftSystem {
  readonly root = new Group();
  readonly lines: LiftLine[];
  /** Collision obstacles from the terminals (walls, huts, footings). */
  readonly obstacles: Obstacle[];
  /** Name-board mounts on each line's [bottom, top] terminal. */
  readonly signMounts: SignMount[][][];
  /** Lift clock (s). Runs faster while the rider fast-forwards. */
  time = 0;
  /** The lift clock at the previous update (for "did a carrier pass this point?"). */
  previousTime = 0;
  /** Time multiplier for the lift clock. */
  rate = 1;
  /** [line, carrier] left out of the instanced carriers (the rider draws its own cabin). */
  hidden: [number, number] | null = null;
  /**
   * The lift you just got off. Riding a gondola down leaves you in its loading zone, so
   * it doesn't scoop you up again until you've left that zone.
   */
  steppedOff: number | null = null;
  /** Problems found by the load-time checks (also logged as console errors). */
  readonly problems: string[] = [];
  private readonly groups = new Map<string, CarrierGroup>();
  private readonly poles: CarrierGroup;
  private readonly platters: CarrierGroup;
  private readonly tbars: CarrierGroup;

  constructor(
    lifts: Lift[],
    private readonly groundHeight: (x: number, z: number) => number,
  ) {
    this.root.name = 'lifts';
    this.lines = lifts
      .filter((l) => l.supports.length >= 2 && l.terminals?.length === 2)
      .map((l) => new LiftLine(l));
    const vertexColoured = () =>
      new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.25 });
    const terminals = createTerminals(
      this.lines.flatMap((line) =>
        [line.bottomTerminal, line.topTerminal].map((terminal) => ({ terminal, rail: line.rail })),
      ),
      groundHeight,
    );
    // Two terminals per line, in order: [bottom mounts, top mounts].
    this.signMounts = this.lines.map((_, i) => [
      terminals.signs[2 * i] ?? [],
      terminals.signs[2 * i + 1] ?? [],
    ]);
    this.obstacles = terminals.obstacles;
    this.root.add(terminals.mesh);
    this.buildStatics(vertexColoured());
    this.check();

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
    this.previousTime = this.time;
    this.time += dt * this.rate;
    // Only carriers near the camera are drawn: beyond DRAW_RANGE they're sub-pixel, and
    // a big resort has >10k of them (each drawn in the main pass and every shadow
    // cascade). Visible carriers are packed at the front of each instance buffer.
    const near = this.lines.map((line) => !camera || line.distanceTo(camera) < DRAW_RANGE);
    const close = (p: Vector3) => !camera || p.distanceToSquared(camera) < DRAW_RANGE ** 2;
    for (const g of this.groups.values()) {
      let k = 0;
      for (const [li, ci] of g.members) {
        if (!near[li] || (li === this.hidden?.[0] && ci === this.hidden[1])) continue;
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
      const pose = line.pose(ci, this.time, pos, dir);
      if (!close(pos)) continue;
      const placed = this.platterPose(pos, dir, pose.side);
      m.compose(poleTop, q2, scale.set(1, placed.length, 1));
      this.poles.mesh.setMatrixAt(poles++, m);
      const key = line.op.kind === 'tbar' ? 'tbars' : 'platters';
      m.compose(platterAt, q, ONE);
      this[key].mesh.setMatrixAt(platterCount[key]++, m);
    }
    this.poles.mesh.count = poles;
    this.platters.mesh.count = platterCount.platters;
    this.tbars.mesh.count = platterCount.tbars;
    for (const g of [this.poles, this.platters, this.tbars]) {
      if (g.mesh.count) g.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * Drag-lift pole from a grip at `grip`: sets `poleTop`/`q2` (pole transform) and
   * `platterAt`/`q` (platter). Uphill the pole trails back to a skier.
   */
  platterPose(grip: Vector3, travel: Vector3, side: 1 | -1): { length: number; platter: Vector3 } {
    const ground = this.groundHeight(grip.x, grip.z);
    const length = Math.max(0.3, grip.y - 0.6 - (ground + PLATTER_HEIGHT));
    q.setFromAxisAngle(UP, Math.atan2(-travel.x, -travel.z));
    const lean = side === 1 ? 0.45 : 0;
    tilt.setFromAxisAngle(X_AXIS, -lean);
    poleTop.copy(grip).setY(grip.y - 0.6);
    q2.copy(q).multiply(tilt);
    platterAt
      .set(0, -length, length * Math.tan(lean))
      .applyQuaternion(q)
      .add(poleTop);
    return { length: length / Math.cos(lean), platter: platterAt };
  }

  /** World transform of a carrier's grip (origin on the cable, -z = travel direction). */
  carrierMatrix(li: number, ci: number, out: Matrix4): CarrierPose {
    const pose = this.lines[li]!.pose(ci, this.time, pos, dir);
    q.setFromAxisAngle(UP, Math.atan2(-dir.x, -dir.z));
    out.compose(pos, q, ONE);
    return pose;
  }

  /** Horizontal distance to the nearest terminal of any lift (m). */
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

  /** The lift whose loading point is nearest (x, z), within BOARDING_RADIUS. */
  boardingNear(x: number, z: number): { line: number; down: boolean } | null {
    let best: { line: number; down: boolean } | null = null;
    let bestDistance = BOARDING_RADIUS;
    const consider = (p: Vector3, line: number, down: boolean) => {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bestDistance) {
        bestDistance = d;
        best = { line, down };
      }
    };
    this.lines.forEach((line, li) => {
      consider(line.loadPoint, li, false);
      if (line.down) consider(line.down.loadPoint, li, true);
    });
    return best;
  }

  /**
   * Manual boarding: if `feet` is in a lift's loading zone and a carrier has just reached
   * the loading point (a chair scooping you up, a cabin's door alongside), return it.
   */
  scoop(feet: Vector3): { line: number; carrier: number } | null {
    const off = this.steppedOff;
    if (off !== null && !this.lines[off]?.inLoadingZone(feet)) this.steppedOff = null;
    for (let li = 0; li < this.lines.length; li++) {
      if (li === this.steppedOff) continue;
      const line = this.lines[li]!;
      if (Math.abs(line.loadPoint.x - feet.x) > 8 || Math.abs(line.loadPoint.z - feet.z) > 8)
        continue;
      if (!line.inLoadingZone(feet)) continue;
      if (line.tracks) {
        const s = jigBack(line.op, 0, this.time);
        if (!s.moving && s.distance === 0) return { line: li, carrier: 0 };
        continue;
      }
      const { carrier } = line.nextToLoad(this.previousTime);
      if (line.passed(carrier, line.loadTime, this.previousTime, this.time)) {
        return { line: li, carrier };
      }
    }
    return null;
  }

  /**
   * Every tower's column as a solid (an octagon around its base), for things that collide
   * with towers (the snowmobile). The skier doesn't, so they aren't in `obstacles`.
   */
  towerObstacles(): Obstacle[] {
    const solids: Obstacle[] = [];
    for (const line of this.lines) {
      // The column tapers out to 0.85 × its scale at the foot (towerGeometry).
      const r = 0.85 * towerScale(line.op);
      for (const s of line.lift.supports) {
        if (s.kind === 'station') continue;
        const ring: [number, number][] = [];
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          ring.push([s.east + r * Math.cos(a), s.north + r * Math.sin(a)]);
        }
        solids.push({ ring, base: s.ground - BURY, top: s.top });
      }
    }
    return solids;
  }

  /** Distances up the line of each tower on a lift (for the sheave clack). */
  towerPoints(li: number): Vector3[] {
    return this.lines[li]!.towers;
  }

  /** Load-time invariants: continuous paths, loading points on their pads. */
  private check(): void {
    for (const line of this.lines) {
      if (line.loop && maxStep(line.loop) > 1) {
        this.problems.push(`${line.name}: haul rope path has a gap`);
      }
      for (const [point, term, label] of [
        [line.loadPoint, line.bottomTerminal, 'loading'],
        [line.unloadPoint, line.topTerminal, 'unloading'],
      ] as const) {
        const ground = this.groundHeight(point.x, point.z);
        // Top chair/drag ramps start dropping at the unload point; allow for that.
        const tolerance = label === 'unloading' && term.ramp ? 0.6 : 0.35;
        if (Math.abs(ground - term.pad) > tolerance) {
          this.problems.push(
            `${line.name}: ${label} point ${(ground - term.pad).toFixed(2)} m off its pad`,
          );
        }
      }
    }
    if (this.problems.length) console.error(`Lift checks failed:\n${this.problems.join('\n')}`);
  }

  private buildStatics(material: MeshStandardNodeMaterial): void {
    const towers: Matrix4[] = [];
    const arms: Matrix4[] = [];
    const sheaves: Matrix4[] = [];
    const cables: Matrix4[] = [];
    const cableMaterial = new MeshStandardNodeMaterial({ color: 0x1d1f22, roughness: 0.6 });
    const rope = (a: Vector3, b: Vector3, thickness: number) => {
      const span = b.clone().sub(a);
      if (span.lengthSq() < 1e-6) return;
      cables.push(
        m
          .compose(
            a.clone().lerp(b, 0.5),
            new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), span.clone().normalize()),
            scale.set(thickness, thickness, span.length()),
          )
          .clone(),
      );
    };

    for (const line of this.lines) {
      const { lift, op } = line;
      const heavy = op.kind === 'cabin';
      const yaw = Math.atan2(-(line.top.x - line.bottom.x), -(line.top.z - line.bottom.z));
      q.setFromAxisAngle(UP, yaw);
      const radius = towerScale(op);
      const r = lift.gauge / 2;

      lift.supports.forEach((s) => {
        if (s.kind === 'station') return; // terminals are generated separately
        const top = new Vector3(s.east, s.top, -s.north);
        const base = s.ground - BURY;
        const armY = top.y + 0.35;
        pos.set(top.x, base, top.z);
        towers.push(m.compose(pos, q, scale.set(radius, armY - base, radius)).clone());
        pos.set(top.x, armY + 0.2, top.z);
        arms.push(m.compose(pos, q, scale.set(lift.gauge + 1.2, 0.35, 0.45)).clone());
        for (const side of [1, -1]) {
          pos.copy(top).addScaledVector(line.across, side * r);
          sheaves.push(m.compose(pos, q, ONE).clone());
        }
      });

      // Ropes along the haul-rope path (round the bullwheels for loops).
      const thickness = heavy ? 0.12 : 0.06;
      if (line.loop) {
        // One segment per span between corners (towers, station ends, bullwheel arcs).
        const corners = line.loop.corners;
        for (let i = 0; i < corners.length; i++) {
          rope(corners[i]!.position, corners[(i + 1) % corners.length]!.position, thickness);
        }
      } else {
        for (const track of line.tracks!) {
          for (let i = 0; i < track.points.length - 1; i++) {
            rope(track.points[i]!, track.points[i + 1]!, thickness);
          }
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
    // Sheaves are a few cm thick: shadows wouldn't show but would cost every shadow
    // cascade thousands of instances.
    add(sheaveGeometry(), material, sheaves, false);
    add(new BoxGeometry(1, 1, 1), cableMaterial, cables, false);
  }
}
