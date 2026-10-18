/** A camera pose in the resort's local frame. */
export interface Pose {
  east: number;
  north: number;
  /** Metres above sea level. */
  altitude: number;
  /** Degrees clockwise from north. */
  heading: number;
  /** Degrees; negative looks down. */
  pitch: number;
}

const VERSION = 1;

function key(resortId: string): string {
  return `mountain-map.pose.${resortId}`;
}

/** The last saved pose for a resort, or null if none (or it's unusable). */
export function loadPose(storage: Storage, resortId: string): Pose | null {
  try {
    const raw = JSON.parse(storage.getItem(key(resortId)) ?? 'null') as
      (Pose & { v: number }) | null;
    if (!raw || raw.v !== VERSION) return null;
    const { east, north, altitude, heading, pitch } = raw;
    if (![east, north, altitude, heading, pitch].every(Number.isFinite)) return null;
    return { east, north, altitude, heading, pitch };
  } catch {
    return null;
  }
}

export function savePose(storage: Storage, resortId: string, pose: Pose): void {
  const rounded = {
    v: VERSION,
    east: Math.round(pose.east * 10) / 10,
    north: Math.round(pose.north * 10) / 10,
    altitude: Math.round(pose.altitude * 10) / 10,
    heading: Math.round(pose.heading * 10) / 10,
    pitch: Math.round(pose.pitch * 10) / 10,
  };
  try {
    storage.setItem(key(resortId), JSON.stringify(rounded));
  } catch {
    // Storage full or disabled (private browsing): losing the pose is harmless.
  }
}

export function clearPose(storage: Storage, resortId: string): void {
  storage.removeItem(key(resortId));
}
