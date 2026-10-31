import {
  Euler,
  Group,
  Matrix4,
  type PerspectiveCamera,
  Quaternion,
  type Scene,
  Vector3,
} from 'three/webgpu';

import { type AircraftParts, animateAircraft, createAircraft } from '../controls/aircraft-model';
import { AIRCRAFT_TYPES, type AircraftType, H125, PC6 } from '../controls/aircraft-types';
import { Drone } from '../controls/drone-model';
import { createGliderRig, type GliderRig, poseGlider } from '../controls/glider-controls';
import { SkierModel } from '../controls/ski-model';
import { createSkydiveRig, poseSkydiver, type SkydiveRig } from '../controls/skydive-controls';
import { initialStance } from '../controls/ski-stance';
import { createSnowmobile, type SnowmobileParts } from '../controls/snowmobile-model';
import { createState, Flag, SLOT, slotsToStance } from './codec';
import type { Player } from './session';

/** Name tags hide beyond this (m). */
const TAG_DISTANCE = 4000;
/** Tag height above the feet (m); a pilot's goes above the wing. */
const TAG_HEIGHT = 2.4;
const GLIDER_TAG_HEIGHT = 9;
const AIRCRAFT_TAG_HEIGHT = 4.5;
const OCCLUSION_SAMPLES = 32;
const grip = new Matrix4();
const gripQ = new Quaternion();

/** A carrier's grip (world) on this lift system, false if there's no such carrier. */
export type CarrierFrame = (line: number, carrier: number, out: Matrix4) => boolean;

/** Tag and minimap colours, by player number. */
export const PLAYER_COLOURS = [
  '#e8402f',
  '#1c7ed6',
  '#2f9e44',
  '#f59f00',
  '#ae3ec9',
  '#0c8599',
  '#e64980',
  '#5c940d',
  '#d9480f',
  '#3b5bdb',
  '#099268',
  '#c2255c',
  '#7048e8',
  '#f08c00',
  '#1098ad',
  '#495057',
];

export const playerColour = (player: number) => PLAYER_COLOURS[player % PLAYER_COLOURS.length]!;

/** One remote player: models built on first use for each mode, and a floating name tag. */
class RemoteAvatar {
  readonly root = new Group();
  readonly state = createState();
  readonly tag: HTMLElement;
  private readonly stance = initialStance();
  private skier?: SkierModel;
  private glider?: GliderRig;
  private sled?: { parts: SnowmobileParts; rider: SkierModel };
  private drone?: Drone;
  private aircraft?: { parts: AircraftParts; pilot: SkierModel; type: AircraftType };
  private skydiver?: SkydiveRig;
  private time = 0;
  private readonly up = new Vector3();
  private readonly position = new Vector3();
  private readonly velocity = new Vector3();
  private readonly rotation = new Quaternion();
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly spirit = new Vector3();
  /** Anchor for the tag (world). */
  readonly head = new Vector3();
  visible = false;
  occluded = false;

  constructor(
    readonly player: number,
    name: string,
    tags: HTMLElement,
  ) {
    this.root.name = `player-${player}`;
    this.tag = document.createElement('div');
    this.tag.className = 'label label-player';
    this.tag.style.setProperty('--player', playerColour(player));
    this.tag.innerHTML = '<span class="label-name"></span>';
    this.tag.hidden = true;
    tags.append(this.tag);
    this.rename(name);
  }

  get name(): string {
    return this.tag.querySelector('.label-name')!.textContent ?? '';
  }

  rename(name: string): void {
    const el = this.tag.querySelector('.label-name')!;
    if (el.textContent !== name) el.textContent = name;
  }

  /** Pose whichever model this mode uses from `this.state`; hide the rest. */
  pose(
    dt: number,
    groundHeight: (x: number, z: number) => number,
    carrierFrame: CarrierFrame,
  ): void {
    const { pose, mode, flags } = this.state;
    this.position.fromArray(pose, SLOT.position);
    this.velocity.fromArray(pose, SLOT.velocity);
    this.rotation.fromArray(pose, SLOT.rotation);
    const c = SLOT.carrier;
    if (flags & Flag.OnCarrier) {
      if (carrierFrame(pose[c]!, pose[c + 1]!, grip)) {
        // On our own copy of their carrier, so they move exactly with it.
        this.position.fromArray(pose, c + 3).applyMatrix4(grip);
        this.position.toArray(pose, SLOT.position);
        this.rotation.premultiply(gripQ.setFromRotationMatrix(grip));
      } else {
        this.rotation.identity(); // not a lift we know: their interpolated position
      }
    }
    this.up.fromArray(pose, SLOT.up);
    if (this.up.lengthSq() < 0.5) this.up.set(0, 1, 0);
    else this.up.normalize();
    slotsToStance(pose, flags, this.stance);
    if (mode === 'ski') {
      // Extrapolated past the last packet, don't sink into the slope.
      this.position.y = Math.max(this.position.y, groundHeight(this.position.x, this.position.z));
    }

    const skier = mode === 'ski' || mode === 'ride' ? (this.skier ??= this.addSkier()) : null;
    const glider = mode === 'glide' ? (this.glider ??= this.addGlider()) : null;
    const sled = mode === 'sled' ? (this.sled ??= this.addSled()) : null;
    const flying = mode === 'plane' || mode === 'heli';
    const type = flying
      ? (AIRCRAFT_TYPES[pose[SLOT.carrier]!] ?? (mode === 'plane' ? PC6 : H125))
      : null;
    if (type && this.aircraft?.type !== type) {
      this.aircraft?.parts.root.removeFromParent();
      this.aircraft = this.addAircraft(type);
    }
    const aircraft = type ? this.aircraft! : null;
    const diving =
      mode === 'freefall' || mode === 'canopy' ? (this.skydiver ??= this.addSkydiver()) : null;
    this.time += dt;
    // Flying: their drone. Out of body, their skier stands holding its controller.
    const spirit = (flags & Flag.Spirit) !== 0;
    const drone = mode === 'fly' || spirit ? (this.drone ??= this.addDrone()) : null;
    if (this.skier) this.skier.root.visible = !!skier;
    if (this.glider) this.glider.root.visible = !!glider;
    if (this.sled) this.sled.parts.root.visible = !!sled;
    if (this.aircraft) this.aircraft.parts.root.visible = !!aircraft;
    if (this.skydiver) this.skydiver.root.visible = !!diving;
    if (drone && spirit) {
      // Only its position is sent; the drone works out its velocity (to tilt) from that.
      this.spirit.fromArray(pose, SLOT.spirit).add(this.position);
      drone.update(dt, this.spirit, pose[SLOT.spirit + 3]!);
    } else if (drone) {
      const yaw = this.euler.setFromQuaternion(this.rotation, 'YXZ').y;
      drone.update(dt, this.position, yaw, this.velocity);
    } else {
      this.drone?.hide();
    }

    let tagHeight = TAG_HEIGHT;
    if (skier) {
      skier.root.position.copy(this.position);
      skier.root.quaternion.copy(this.rotation);
      skier.setSnowboard((flags & Flag.Snowboard) !== 0);
      skier.setStowed((flags & Flag.Stowed) !== 0);
      skier.setFlyingDrone(spirit);
      skier.apply(this.stance, this.up);
    } else if (glider) {
      const heading = this.euler.setFromQuaternion(this.rotation, 'YXZ').y;
      poseGlider(glider, this.position, heading, pose[SLOT.extra]!);
      glider.pilot.setFlyingDrone(spirit);
      glider.pilot.apply(this.stance, this.up);
      tagHeight = GLIDER_TAG_HEIGHT;
    } else if (sled) {
      const { parts, rider } = sled;
      parts.root.position.copy(this.position);
      parts.root.quaternion.copy(this.rotation);
      const steer = pose[SLOT.extra]!;
      parts.bars.rotation.y = steer * 0.8;
      for (const ski of parts.skis) ski.rotation.y = steer;
      parts.body.position.y = pose[SLOT.extra + 1]!;
      rider.setFlyingDrone(spirit);
      rider.apply(this.stance, this.up);
    } else if (diving) {
      // Their body's orientation as sent; the canopy along their heading.
      poseSkydiver(
        diving,
        this.position,
        pose[SLOT.spirit + 3]!,
        0,
        pose[SLOT.extra]!,
        pose[SLOT.extra + 1]!,
      );
      diving.pivot.quaternion.copy(this.rotation);
      diving.skier.apply(this.stance, this.up);
      tagHeight = pose[SLOT.extra]! > 0.5 ? 6.5 : TAG_HEIGHT;
    } else if (aircraft) {
      const { parts, pilot } = aircraft;
      parts.root.position.copy(this.position);
      parts.root.quaternion.copy(this.rotation);
      animateAircraft(parts, aircraft.type, pose[SLOT.extra]!, this.time, dt, true);
      pilot.setFlyingDrone(spirit);
      pilot.apply(this.stance, this.up);
      tagHeight = AIRCRAFT_TAG_HEIGHT;
    } else {
      tagHeight = 0.5; // just above the drone
    }
    this.head.copy(this.position);
    this.head.y += tagHeight;
  }

  private addSkier(): SkierModel {
    const skier = new SkierModel();
    skier.setJacket(playerColour(this.player));
    this.root.add(skier.root);
    return skier;
  }

  private addGlider(): GliderRig {
    const rig = createGliderRig();
    rig.pilot.setJacket(playerColour(this.player));
    this.root.add(rig.root);
    return rig;
  }

  private addSled(): { parts: SnowmobileParts; rider: SkierModel } {
    const parts = createSnowmobile();
    const rider = new SkierModel();
    rider.setJacket(playerColour(this.player));
    rider.setStowed(true);
    parts.seat.add(rider.root);
    this.root.add(parts.root);
    return { parts, rider };
  }

  private addSkydiver(): SkydiveRig {
    const rig = createSkydiveRig();
    rig.skier.setJacket(playerColour(this.player));
    this.root.add(rig.root);
    return rig;
  }

  private addAircraft(type: AircraftType): {
    parts: AircraftParts;
    pilot: SkierModel;
    type: AircraftType;
  } {
    const parts = createAircraft(type);
    const pilot = new SkierModel();
    pilot.setJacket(playerColour(this.player));
    pilot.setStowed(true);
    parts.seat.add(pilot.root);
    this.root.add(parts.root);
    return { parts, pilot, type };
  }

  /** Their plane or helicopter, while they're flying one: its kind, revs and power. */
  get flyingAircraft(): { root: Group; kind: 'plane' | 'heli'; rpm: number; load: number } | null {
    const a = this.aircraft;
    if (!a?.parts.root.visible) return null;
    const p = this.state.pose;
    return {
      root: a.parts.root,
      kind: a.type.kind,
      rpm: p[SLOT.extra]!,
      load: a.type.kind === 'heli' ? p[SLOT.extra + 1]! : Math.min(1, this.velocity.length() / 60),
    };
  }

  private addDrone(): Drone {
    const drone = new Drone();
    this.root.add(drone.root);
    return drone;
  }

  /** Their drone, while they're flying one (and drawn). */
  get flyingDrone(): Drone | null {
    return this.drone?.root.visible ? this.drone : null;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.tag.remove();
  }
}

/**
 * Everyone else in the room, drawn where they were ~100 ms ago (interpolated, or carried
 * on along their velocity if packets are late), with a name tag and a minimap dot.
 */
export class RemotePlayers {
  private readonly avatars = new Map<number, RemoteAvatar>();
  private readonly projected = new Vector3();
  private cursor = 0;

  constructor(
    private readonly scene: Scene,
    private readonly tags: HTMLElement,
    private readonly groundHeight: (x: number, z: number) => number,
    private readonly carrierFrame: CarrierFrame,
  ) {}

  /** Positions for the minimap and world map: (east, north), colour and name. */
  get dots(): { east: number; north: number; colour: string; name: string }[] {
    const out: { east: number; north: number; colour: string; name: string }[] = [];
    for (const a of this.avatars.values()) {
      if (!a.visible) continue;
      const p = a.state.pose;
      out.push({ east: p[0]!, north: -p[2]!, colour: playerColour(a.player), name: a.name });
    }
    return out;
  }

  /** What each player is doing (ski, glide, sled...), for tests. */
  get modes(): string[] {
    return [...this.avatars.values()].filter((a) => a.visible).map((a) => a.state.mode);
  }

  /** What a player is doing (avatar mode; 'fly' out of body too), if they've been seen. */
  modeOf(player: number): string | null {
    const a = this.avatars.get(player);
    if (!a?.visible) return null;
    return (a.state.flags & Flag.Spirit) !== 0 ? 'fly' : a.state.mode;
  }

  /** The nearest drone someone else is flying: how far it is from `from` (m) and its speed. */
  nearestDrone(from: Vector3): { distance: number; speed: number } | null {
    let best: { distance: number; speed: number } | null = null;
    for (const a of this.avatars.values()) {
      const drone = a.visible ? a.flyingDrone : null;
      if (!drone) continue;
      const distance = drone.root.position.distanceTo(from);
      if (!best || distance < best.distance) best = { distance, speed: drone.speed };
    }
    return best;
  }

  /** The nearest plane or helicopter someone else is flying: distance from `from` (m), kind, revs, load. */
  nearestAircraft(
    from: Vector3,
  ): { distance: number; kind: 'plane' | 'heli'; rpm: number; load: number } | null {
    let best: { distance: number; kind: 'plane' | 'heli'; rpm: number; load: number } | null = null;
    for (const a of this.avatars.values()) {
      const air = a.visible ? a.flyingAircraft : null;
      if (!air) continue;
      const distance = air.root.position.distanceTo(from);
      if (!best || distance < best.distance)
        best = { distance, kind: air.kind, rpm: air.rpm, load: air.load };
    }
    return best;
  }

  /** Where a player is (world), if they've been seen. */
  positionOf(player: number): Vector3 | null {
    const a = this.avatars.get(player);
    return a?.visible ? new Vector3().fromArray(a.state.pose, SLOT.position) : null;
  }

  update(players: Map<number, Player>, dt: number, now: number, camera: PerspectiveCamera): void {
    for (const [n, avatar] of this.avatars) {
      if (!players.has(n)) {
        avatar.dispose();
        this.avatars.delete(n);
      }
    }
    for (const p of players.values()) {
      let avatar = this.avatars.get(p.player);
      if (!avatar) {
        avatar = new RemoteAvatar(p.player, p.name, this.tags);
        this.avatars.set(p.player, avatar);
        this.scene.add(avatar.root);
      }
      avatar.rename(p.name);
      avatar.visible = p.interp.sample(now, avatar.state);
      avatar.root.visible = avatar.visible;
      if (avatar.visible) avatar.pose(dt, this.groundHeight, this.carrierFrame);
    }
    this.updateTags(camera);
  }

  clear(): void {
    for (const a of this.avatars.values()) a.dispose();
    this.avatars.clear();
  }

  private updateTags(camera: PerspectiveCamera): void {
    camera.updateMatrixWorld(); // this frame's view (tags are placed before the render)
    const list = [...this.avatars.values()];
    // One terrain-occlusion check per frame, round robin.
    if (list.length) {
      const a = list[this.cursor++ % list.length]!;
      a.occluded = this.isOccluded(camera.position, a.head);
    }
    const width = this.tags.clientWidth;
    const height = this.tags.clientHeight;
    for (const a of list) {
      let show = a.visible && !a.occluded;
      const distance = a.head.distanceTo(camera.position);
      if (show && distance > TAG_DISTANCE) show = false;
      if (show) {
        const view = this.projected.copy(a.head).applyMatrix4(camera.matrixWorldInverse);
        if (view.z > -camera.near) show = false;
        else {
          const p = view.applyMatrix4(camera.projectionMatrix);
          const x = (p.x * 0.5 + 0.5) * width;
          const y = (-p.y * 0.5 + 0.5) * height;
          show = p.x > -1.1 && p.x < 1.1 && p.y > -1.1 && p.y < 1.1;
          a.tag.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
        }
      }
      if (a.tag.hidden === show) a.tag.hidden = !show;
    }
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
