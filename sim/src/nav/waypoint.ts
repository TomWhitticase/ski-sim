/** A guide marker placed on the map (left click), shown in the world and on the minimap. */
export interface Waypoint {
  east: number;
  north: number;
}

const key = (resortId: string) => `ski-sim.waypoint.${resortId}`;

export function loadWaypoint(storage: Pick<Storage, 'getItem'>, resortId: string): Waypoint | null {
  try {
    const w = JSON.parse(storage.getItem(key(resortId)) ?? 'null') as Partial<Waypoint> | null;
    return w && Number.isFinite(w.east) && Number.isFinite(w.north)
      ? { east: w.east!, north: w.north! }
      : null;
  } catch {
    return null;
  }
}

export function saveWaypoint(
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  resortId: string,
  w: Waypoint | null,
): void {
  if (w)
    storage.setItem(
      key(resortId),
      JSON.stringify({ east: Math.round(w.east), north: Math.round(w.north) }),
    );
  else storage.removeItem(key(resortId));
}

export interface ScreenPlacement {
  x: number;
  y: number;
  onScreen: boolean;
  /** Direction from the screen centre to the marker (rad, 0 = right, π/2 = down). */
  angle: number;
}

/**
 * Where to draw the marker for a point in view space (camera looks down -z): projected
 * when it's in front and inside the screen (less `margin`), otherwise pinned to the
 * screen edge in its direction, so it still points the way when behind you.
 */
export function placeOnScreen(
  view: { x: number; y: number; z: number },
  fovYDeg: number,
  aspect: number,
  width: number,
  height: number,
  margin: number,
): ScreenPlacement {
  const t = Math.tan((fovYDeg * Math.PI) / 360);
  let dx: number, dy: number;
  if (view.z < -1e-3) {
    const nx = view.x / -view.z / (t * aspect);
    const ny = view.y / -view.z / t;
    const x = ((nx + 1) / 2) * width;
    const y = ((1 - ny) / 2) * height;
    if (x >= margin && x <= width - margin && y >= margin && y <= height - margin) {
      return { x, y, onScreen: true, angle: Math.atan2(y - height / 2, x - width / 2) };
    }
    dx = nx;
    dy = -ny;
  } else {
    // Behind: steer by which side it's on; straight behind goes to the bottom edge.
    dx = view.x / (t * aspect);
    dy = -view.y / t;
    if (Math.abs(dx) < 1e-6 && dy <= 0) dy = 1;
    if (dy < 0) dy = Math.abs(dx) > 1e-6 ? 0 : 1; // never pin a point behind you to the top
  }
  const hw = width / 2 - margin;
  const hh = height / 2 - margin;
  // Scale in pixels (the aspect is in the pixel conversion).
  const px = dx * (width / 2);
  const py = dy * (height / 2);
  const s = Math.min(hw / Math.max(Math.abs(px), 1e-9), hh / Math.max(Math.abs(py), 1e-9));
  return {
    x: width / 2 + px * s,
    y: height / 2 + py * s,
    onScreen: false,
    angle: Math.atan2(py, px),
  };
}

/** "850 m" / "2.4 km". */
export function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}
