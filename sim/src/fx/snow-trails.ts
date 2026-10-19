import { cameraPosition, float, positionWorld, smoothstep } from 'three/tsl';
import {
  Color,
  InstancedMesh,
  Matrix4,
  MeshStandardNodeMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three/webgpu';

const CAPACITY = 8000;
/** Lay a new mark after this much travel (m). */
const SPACING = 0.35;
/** Marks sit just above the snow to avoid z-fighting. */
const LIFT = 0.03;
const OPACITY = 0.6;
/** Marks fade out between these camera distances (m). */
const FADE: [number, number] = [70, 160];

const CARVE = new Color(0.6, 0.66, 0.77); // compacted groove, catches a little shadow
const SKID = new Color(0.76, 0.81, 0.89); // scraped smear, lighter
/** A snowmobile track's trench: packed down and in its own shadow, so darker. */
export const SLED_TRENCH = new Color(0.42, 0.48, 0.6);

interface Track {
  last: Vector3 | null;
}

/** Skis leave one mark each; a snowmobile leaves its track's trench and two ski grooves. */
export type TrackName = 'left' | 'right' | 'sled' | 'sledLeftSki' | 'sledRightSki';

/**
 * Tracks left in the snow by each ski (or a snowmobile): a ring buffer of thin quads laid along the path,
 * thin when carving and wide when skidding. The oldest marks are recycled, so cost is
 * fixed; only the instances written each frame are uploaded to the GPU.
 */
export class SnowTrails {
  readonly mesh: InstancedMesh;
  private readonly tracks: Record<TrackName, Track> = {
    left: { last: null },
    right: { last: null },
    sled: { last: null },
    sledLeftSki: { last: null },
    sledRightSki: { last: null },
  };
  private next = 0;
  private written: number[] = [];
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly basis = new Matrix4();
  private readonly mid = new Vector3();
  private readonly along = new Vector3();
  private readonly side = new Vector3();
  private readonly up = new Vector3();
  private readonly scale = new Vector3();
  private readonly colour = new Color();

  constructor() {
    const geometry = new PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2); // lie flat, facing up; length along z
    const material = new MeshStandardNodeMaterial({
      transparent: true,
      depthWrite: false,
      roughness: 1,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const distance = cameraPosition.distance(positionWorld);
    material.opacityNode = float(OPACITY).mul(smoothstep(FADE[1], FADE[0], distance));
    this.mesh = new InstancedMesh(geometry, material, CAPACITY);
    this.mesh.name = 'snow-trails';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    // Make the colour buffer exist up front.
    this.mesh.setColorAt(0, CARVE);
  }

  /** Forget the current tracks (e.g. after a teleport or leaving the snow). */
  break(): void {
    for (const track of Object.values(this.tracks)) track.last = null;
  }

  /**
   * Extend a track to `at` on a surface with normal `normal`. `width` in metres,
   * `skid` 0..1 shades it from `base` (a carved groove by default) to a smear.
   */
  extend(
    name: TrackName,
    at: Vector3,
    normal: Vector3,
    width: number,
    skid: number,
    base: Color = CARVE,
  ) {
    const track = this.tracks[name];
    if (!track.last) {
      track.last = at.clone();
      return;
    }
    const length = track.last.distanceTo(at);
    if (length < SPACING) return;
    if (length > 5) {
      // Teleported or flew off: start a new track rather than drawing a long streak.
      track.last.copy(at);
      return;
    }

    this.mid.copy(track.last).add(at).multiplyScalar(0.5).addScaledVector(normal, LIFT);
    this.along.copy(at).sub(track.last).normalize();
    this.side.crossVectors(normal, this.along).normalize();
    // along × side = normal (facing up); side × up = along, so the basis is right-handed.
    this.up.crossVectors(this.along, this.side).normalize();
    this.basis.makeBasis(this.side, this.up, this.along);
    this.q.setFromRotationMatrix(this.basis);
    this.scale.set(width, 1, length + 0.05);
    this.m.compose(this.mid, this.q, this.scale);

    const i = this.next;
    this.mesh.setMatrixAt(i, this.m);
    this.mesh.setColorAt(i, this.colour.copy(base).lerp(SKID, skid));
    this.written.push(i);
    this.next = (this.next + 1) % CAPACITY;
    this.mesh.count = Math.max(this.mesh.count, i + 1);
    track.last.copy(at);
  }

  /** Upload this frame's new marks. */
  flush(): void {
    if (this.written.length === 0) return;
    const matrices = this.mesh.instanceMatrix;
    const colours = this.mesh.instanceColor!;
    matrices.clearUpdateRanges();
    colours.clearUpdateRanges();
    // Usually a single contiguous run; split where the ring wraps.
    let start = this.written[0]!;
    let prev = start;
    const push = (from: number, to: number) => {
      matrices.addUpdateRange(from * 16, (to - from + 1) * 16);
      colours.addUpdateRange(from * 3, (to - from + 1) * 3);
    };
    for (const i of this.written.slice(1)) {
      if (i !== prev + 1) {
        push(start, prev);
        start = i;
      }
      prev = i;
    }
    push(start, prev);
    matrices.needsUpdate = true;
    colours.needsUpdate = true;
    this.written = [];
  }
}
