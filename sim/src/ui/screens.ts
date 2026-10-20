/**
 * The menus' screens and how you move between them: a stack. Forward pushes a screen,
 * Esc (or ← in the corner) pops back to the one before, and some moments reset the
 * stack (the game starting makes Pause the bottom of it). Pure, so it's unit-tested;
 * `ui/main-menu.ts` draws whichever screen is on top.
 */

export type ScreenId = 'title' | 'resorts' | 'resort' | 'loading' | 'pause' | 'multiplayer';

/** What ← says it goes back to. */
export const SCREEN_NAMES: Record<ScreenId, string> = {
  title: 'Main menu',
  resorts: 'Resorts',
  resort: 'Start points',
  loading: 'Loading',
  pause: 'Paused',
  multiplayer: 'Multiplayer',
};

export class ScreenStack {
  private stack: ScreenId[];

  constructor(first: ScreenId) {
    this.stack = [first];
  }

  get current(): ScreenId {
    return this.stack[this.stack.length - 1]!;
  }

  /** The screen back would return to (null at the bottom). */
  get previous(): ScreenId | null {
    return this.stack[this.stack.length - 2] ?? null;
  }

  /** Forward to `id`. If it's already further down, go back to it instead (no loops). */
  push(id: ScreenId): void {
    const at = this.stack.indexOf(id);
    if (at >= 0) this.stack.length = at + 1;
    else this.stack.push(id);
  }

  /** Start over from `id` (e.g. loading starts, or the game begins). */
  reset(id: ScreenId): void {
    this.stack = [id];
  }

  /** Back one screen; false if there's nowhere to go. */
  back(): boolean {
    if (this.stack.length < 2) return false;
    this.stack.pop();
    return true;
  }
}

/** A start point's place on the menu's map, as fractions of the map image. */
export interface MapView {
  /** Image size relative to the box (1 = the box's width or height). */
  width: number;
  height: number;
  /** Image offset inside the box, as fractions of the box. */
  left: number;
  top: number;
}

/**
 * Frame the start points on the resort's preview map: the smallest view (at least
 * `minSpan` metres across) that holds them all with a margin, in a box of `aspect`
 * (width / height), centred on them and kept inside the image where possible.
 */
export function frameStarts(
  extent: { west: number; east: number; south: number; north: number },
  points: { east: number; north: number }[],
  aspect: number,
  minSpan = 6000,
  margin = 0.18,
): MapView {
  const fullW = extent.east - extent.west;
  const fullH = extent.north - extent.south;
  if (!points.length) {
    // The whole map, fitted to the box.
    const span = Math.max(fullW, fullH * aspect);
    return place(
      extent,
      (extent.west + extent.east) / 2,
      (extent.south + extent.north) / 2,
      span,
      aspect,
    );
  }
  let w = Infinity;
  let e = -Infinity;
  let s = Infinity;
  let n = -Infinity;
  for (const p of points) {
    w = Math.min(w, p.east);
    e = Math.max(e, p.east);
    s = Math.min(s, p.north);
    n = Math.max(n, p.north);
  }
  const pad = 1 + margin * 2;
  // Metres across the box: enough for the points' width, and their height at this aspect.
  let span = Math.max(minSpan, (e - w) * pad, (n - s) * pad * aspect);
  span = Math.min(span, Math.max(fullW, fullH * aspect));
  return place(extent, (w + e) / 2, (s + n) / 2, span, aspect);
}

function place(
  extent: { west: number; east: number; south: number; north: number },
  centreE: number,
  centreN: number,
  span: number,
  aspect: number,
): MapView {
  const fullW = extent.east - extent.west;
  const fullH = extent.north - extent.south;
  const spanN = span / aspect;
  // Keep the view inside the image where it's big enough to.
  const clamp = (c: number, half: number, lo: number, hi: number) =>
    hi - lo <= half * 2 ? (lo + hi) / 2 : Math.min(hi - half, Math.max(lo + half, c));
  const cE = clamp(centreE, span / 2, extent.west, extent.east);
  const cN = clamp(centreN, spanN / 2, extent.south, extent.north);
  return {
    width: fullW / span,
    height: fullH / spanN,
    left: (extent.west - (cE - span / 2)) / span,
    top: (cN + spanN / 2 - extent.north) / spanN,
  };
}

/** Where a point sits in the box (fractions), given the view. */
export function pinAt(
  extent: { west: number; east: number; south: number; north: number },
  view: MapView,
  p: { east: number; north: number },
): { x: number; y: number } {
  const fx = (p.east - extent.west) / (extent.east - extent.west);
  const fy = (extent.north - p.north) / (extent.north - extent.south);
  return { x: view.left + fx * view.width, y: view.top + fy * view.height };
}

/**
 * The shape (width / height) of map that suits a resort's start points: their spread,
 * kept between portrait and landscape limits so the panel never gets silly.
 */
export function startsAspect(
  extent: { west: number; east: number; south: number; north: number },
  points: { east: number; north: number }[],
  minSpan = 6000,
): number {
  const xs = points.map((p) => p.east);
  const ys = points.map((p) => p.north);
  const w = points.length ? Math.max(...xs) - Math.min(...xs) : extent.east - extent.west;
  const h = points.length ? Math.max(...ys) - Math.min(...ys) : extent.north - extent.south;
  return Math.min(1.8, Math.max(0.6, Math.max(w, minSpan) / Math.max(h, minSpan)));
}
