import { Group, Vector3 } from 'three/webgpu';

import { type AircraftParts, animateAircraft, createAircraft } from '../controls/aircraft-model';
import { aircraftType } from '../controls/aircraft-types';
import { groundOrientation } from '../controls/plane-physics';
import type { ParkingSpot } from './aircraft-parking';

/** Parked aircraft show within this of the camera (m). */
const DRAW_DISTANCE = 6000;

/**
 * The aircraft waiting at the airfields (`parkingSpots`): a model on each spot, cold and
 * dark, drawn only near the camera. One you've taken is hidden until you leave it
 * somewhere else (it's yours then: `AircraftControls` draws it).
 */
export class ParkedFleet {
  readonly root = new Group();
  private readonly models: (AircraftParts | null)[];
  private taken = new Set<number>();

  constructor(
    readonly spots: ParkingSpot[],
    private readonly groundHeight: (x: number, z: number) => number,
  ) {
    this.root.name = 'parked-aircraft';
    this.models = spots.map(() => null);
  }

  /** The nearest free spot of a kind within `range` (m) of a world point, if any. */
  nearest(at: Vector3, range: number, type?: string): number | null {
    let best: number | null = null;
    let bestD = range;
    this.spots.forEach((s, i) => {
      if (this.taken.has(i) || (type && s.type !== type)) return;
      const d = Math.hypot(s.east - at.x, -s.north - at.z);
      if (d < bestD && Math.abs(s.ground - at.y) < 8) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  /** Take a spot's aircraft (it's hidden here); `release` gives every other back. */
  take(index: number | null, type: string): void {
    // Your aircraft of this type is now this one: the one you had goes back to its spot.
    for (const i of this.taken) if (this.spots[i]!.type === type) this.taken.delete(i);
    if (index !== null) this.taken.add(index);
    this.models.forEach((m, i) => {
      if (m) m.root.visible = !this.taken.has(i);
    });
  }

  update(camera: Vector3): void {
    this.spots.forEach((s, i) => {
      const near = Math.hypot(s.east - camera.x, -s.north - camera.z) < DRAW_DISTANCE;
      let model = this.models[i];
      if (!near && !model) return;
      if (!model) {
        const type = aircraftType(s.type)!;
        model = createAircraft(type);
        model.root.position.set(s.east, s.ground, -s.north);
        // Planes sit tail down on their tailwheel on the runway's slope; helicopters
        // level on their pad.
        const yaw = (-s.heading * Math.PI) / 180;
        const x = s.east;
        const z = -s.north;
        const h = this.groundHeight;
        const normal =
          type.kind === 'plane'
            ? new Vector3(h(x - 3, z) - h(x + 3, z), 6, h(x, z - 3) - h(x, z + 3)).normalize()
            : new Vector3(0, 1, 0);
        const pitch = type.kind === 'plane' ? type.ground.threePoint : 0;
        groundOrientation(yaw, normal, pitch, model.root.quaternion);
        // Blades parked across, lights off.
        animateAircraft(model, type, 0, 0, 0, false);
        model.rotor.rotation.y = 0.4;
        this.models[i] = model;
        this.root.add(model.root);
      }
      model.root.visible = near && !this.taken.has(i);
    });
  }
}
