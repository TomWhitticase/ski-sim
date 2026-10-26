import type { Road, RoadClass } from '../features/types';

/**
 * Roads on the world map in a map style, as the pipeline's minimap draws them
 * (`minimap.draw_roads`): a casing and a fill, yellow for main roads and white for the
 * rest, minor ones under main ones; snow-covered roads and tracks a thin dashed line;
 * tunnels dashed grey; bridges with a darker casing.
 */
export const ROAD_COLOURS = {
  casing: '#80766c',
  bridge: '#3f3934',
  main: '#f7d776',
  minor: '#ffffff',
  snow: '#8a7c6e',
  tunnel: '#787878',
  label: '#3d3630',
} as const;

/** Map rank by class: 0 motorways .. 6 tracks (pipeline `roads.CLASSES`). */
const RANK: Record<RoadClass, number> = {
  motorway: 0,
  trunk: 0,
  motorway_link: 0,
  trunk_link: 0,
  primary: 1,
  primary_link: 1,
  secondary: 2,
  secondary_link: 2,
  tertiary: 3,
  tertiary_link: 3,
  unclassified: 4,
  residential: 4,
  living_street: 4,
  service: 5,
  track: 6,
};
/** Shown from this zoom in (metres per pixel), by rank. */
const SHOW_MPP = [Infinity, Infinity, Infinity, 30, 16, 8, 6];
/** Snow roads that are through roads or streets (closed in winter) show from further out. */
const SNOW_MAIN_MPP = 20;
/** Narrowest fill (px), by rank; zoomed in a road is its ground width. */
const MIN_PX = [3, 2.6, 2.6, 2.2, 1.8, 1.3, 1];
/** Road names from this zoom in; refs (D 915) on main roads from this. */
export const ROAD_NAMES_MPP = 3;
const ROAD_REFS_MPP = 12;

export function roadRank(cls: RoadClass): number {
  return RANK[cls] ?? 5;
}

/** Whether a road is drawn at this zoom. */
export function roadShown(road: Pick<Road, 'class' | 'winter'>, mpp: number): boolean {
  const rank = roadRank(road.class);
  if (road.winter === 'snow') return mpp < (rank <= 4 ? SNOW_MAIN_MPP : SHOW_MPP[6]!);
  return mpp < SHOW_MPP[rank]!;
}

/** A road's fill width on screen (px): its ground width, never under its rank's minimum. */
export function roadPx(rank: number, width: number, mpp: number): number {
  return Math.max(MIN_PX[rank]!, width / mpp);
}

interface Label {
  text: string;
  ref: boolean;
  rank: number;
  /** Middle of the way, its direction there (radians from east, counter-clockwise) and
   *  its length (m). */
  at: [number, number];
  angle: number;
  length: number;
}

/** Roads are cut into cells this big (m) so a frame strokes only what's in view. */
const CELL = 750;
/** Snow roads and tunnels are dashed from this zoom in (finer, solid and fainter beyond:
 *  dashing every track in a valley costs more than the rest of the map together). */
const DASH_MPP = 4;
/** Roads narrower than this (px) are a single grey line, not a cased white one. */
const CASED = 2.2;

/**
 * One style's roads in one cell, as a path in world metres (drawn through the world
 * map's world transform), with their bounds for culling.
 */
interface Group {
  path: Path2D;
  rank: number;
  width: number;
  kind: 'cleared' | 'bridge' | 'snow' | 'tunnel';
  box: [number, number, number, number];
}

/** The road layer, built once: cached paths per style and cell, so a pan strokes only the
 *  few in view. */
export class RoadLayer {
  private readonly groups: Group[] = [];
  readonly labels: Label[] = [];
  readonly has = { cleared: false, main: false, snow: false, tunnel: false, bridge: false };

  constructor(roads: Road[]) {
    const byKey = new Map<string, Group>();
    for (const road of roads) {
      if (road.line.length < 2) continue;
      const rank = roadRank(road.class);
      const kind =
        road.structure === 'tunnel'
          ? 'tunnel'
          : road.winter === 'snow'
            ? 'snow'
            : road.structure === 'bridge'
              ? 'bridge'
              : 'cleared';
      // Widths are bucketed to 2 m: one path per class and width in a cell, not per road.
      const width = Math.max(2, Math.round(road.width / 2) * 2);
      const showRank = road.winter === 'snow' && rank <= 4 ? -1 : rank;
      const es = road.line.map((p) => p[0]);
      const ns = road.line.map((p) => p[1]);
      const box: Group['box'] = [
        Math.min(...es),
        Math.min(...ns),
        Math.max(...es),
        Math.max(...ns),
      ];
      const cell = `${Math.floor((box[0] + box[2]) / 2 / CELL)},${Math.floor((box[1] + box[3]) / 2 / CELL)}`;
      const key = `${kind}:${showRank}:${width}:${cell}`;
      let group = byKey.get(key);
      if (!group) {
        group = { path: new Path2D(), rank: showRank, width, kind, box: [...box] };
        byKey.set(key, group);
      }
      const g = group;
      g.box = [
        Math.min(g.box[0], box[0]),
        Math.min(g.box[1], box[1]),
        Math.max(g.box[2], box[2]),
        Math.max(g.box[3], box[3]),
      ];
      road.line.forEach(([e, n], i) => (i ? g.path.lineTo(e, n) : g.path.moveTo(e, n)));
      this.has[kind] = true;
      if (kind === 'cleared' && rank <= 2) this.has.main = true;
      const text = road.name ?? (rank <= 3 ? road.ref : null);
      if (text && kind !== 'tunnel' && rank <= 4) this.labels.push(label(road, text, rank));
    }
    // Minor roads first, so main roads draw over them.
    this.groups = [...byKey.values()].sort((a, b) => b.rank - a.rank);
  }

  /**
   * Strokes the roads shown at `mpp` within `view` (west, south, east, north); the
   * context is already in world metres (so a screen px is `mpp` metres).
   */
  draw(ctx: CanvasRenderingContext2D, mpp: number, view: [number, number, number, number]): void {
    const m = mpp;
    // Round joins only where a road is wide enough to show them: they're most of the
    // cost of stroking thousands of densely drawn ways.
    const round = mpp < DASH_MPP;
    ctx.lineCap = round ? 'round' : 'butt';
    ctx.lineJoin = round ? 'round' : 'miter';
    ctx.miterLimit = 2;
    const pad = 10 * mpp + 15;
    const shown = (g: Group) =>
      (g.rank < 0
        ? mpp < SNOW_MAIN_MPP
        : mpp < (g.kind === 'snow' ? SHOW_MPP[6]! : SHOW_MPP[g.rank]!)) &&
      g.box[0] < view[2] + pad &&
      g.box[2] > view[0] - pad &&
      g.box[1] < view[3] + pad &&
      g.box[3] > view[1] - pad;
    const visible = this.groups.filter(shown);
    const dashed = mpp < DASH_MPP;
    ctx.setLineDash(dashed ? [5 * m, 3.5 * m] : []);
    ctx.globalAlpha = dashed ? 1 : 0.7;
    for (const g of visible) {
      if (g.kind !== 'snow' && g.kind !== 'tunnel') continue;
      ctx.strokeStyle = g.kind === 'snow' ? ROAD_COLOURS.snow : ROAD_COLOURS.tunnel;
      const px = g.rank < 0 ? 1.8 : g.kind === 'tunnel' ? 1.4 : 1.2;
      ctx.lineWidth = Math.max(px, (g.width / mpp) * 0.5) * m;
      ctx.stroke(g.path);
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    const ground = visible.filter((g) => g.kind === 'cleared' || g.kind === 'bridge');
    for (const g of ground) {
      const fill = roadPx(g.rank, g.width, mpp);
      if (g.kind === 'bridge') {
        ctx.strokeStyle = ROAD_COLOURS.bridge;
        ctx.lineWidth = (fill + 3) * m;
        const cap: CanvasLineCap = ctx.lineCap;
        ctx.lineCap = 'butt';
        ctx.stroke(g.path);
        ctx.lineCap = cap;
      } else if (fill >= CASED) {
        ctx.strokeStyle = ROAD_COLOURS.casing;
        ctx.lineWidth = (fill + 1.6) * m;
        ctx.stroke(g.path);
      }
    }
    for (const g of ground) {
      const fill = roadPx(g.rank, g.width, mpp);
      ctx.strokeStyle =
        g.rank <= 2 ? ROAD_COLOURS.main : fill >= CASED ? ROAD_COLOURS.minor : ROAD_COLOURS.casing;
      ctx.lineWidth = fill * m;
      ctx.stroke(g.path);
    }
  }

  /**
   * Names along roads (zoomed in), and refs on main roads in a small yellow tag (from
   * further out), where there's room. `toScreen` maps world to screen px.
   */
  drawLabels(
    ctx: CanvasRenderingContext2D,
    mpp: number,
    toScreen: (east: number, north: number) => [number, number],
    view: { w: number; h: number },
    tryPlace: (cx: number, top: number, w: number, h: number) => boolean,
  ): void {
    if (mpp >= ROAD_REFS_MPP) return;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Main roads' labels first.
    for (const l of this.labels) {
      const name = !l.ref;
      if (name && mpp >= ROAD_NAMES_MPP) continue;
      if (!roadShown({ class: rankClass(l.rank), winter: 'cleared' }, mpp)) continue;
      const [x, y] = toScreen(l.at[0], l.at[1]);
      if (x < -50 || y < -50 || x > view.w + 50 || y > view.h + 50) continue;
      ctx.font = name ? 'italic 600 11px system-ui, sans-serif' : '700 10px system-ui, sans-serif';
      const width = ctx.measureText(l.text).width;
      if (name) {
        if (l.length / mpp < width + 24) continue;
        // Upright: never upside down.
        let a = -l.angle;
        if (a > Math.PI / 2) a -= Math.PI;
        if (a < -Math.PI / 2) a += Math.PI;
        const bw = Math.abs(Math.cos(a)) * width + Math.abs(Math.sin(a)) * 12;
        const bh = Math.abs(Math.sin(a)) * width + Math.abs(Math.cos(a)) * 12;
        if (!tryPlace(x, y - bh / 2, bw, bh)) continue;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(a);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.strokeText(l.text, 0, 0);
        ctx.fillStyle = ROAD_COLOURS.label;
        ctx.fillText(l.text, 0, 0);
        ctx.restore();
      } else {
        const w = width + 8;
        if (!tryPlace(x, y - 7, w, 14)) continue;
        ctx.fillStyle = ROAD_COLOURS.main;
        ctx.strokeStyle = ROAD_COLOURS.casing;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(x - w / 2, y - 7, w, 14, 3);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = ROAD_COLOURS.label;
        ctx.fillText(l.text, x, y + 0.5);
      }
    }
  }
}

function rankClass(rank: number): RoadClass {
  return (['motorway', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'track'][
    rank
  ] ?? 'service') as RoadClass;
}

/** A road's label at the middle of its line. */
function label(road: Road, text: string, rank: number): Label {
  const pts = road.line;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1]!, pts[i]!];
    cum.push(cum[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const length = cum[cum.length - 1]!;
  let i = 1;
  while (i < pts.length - 1 && cum[i]! < length / 2) i++;
  const [a, b] = [pts[i - 1]!, pts[i]!];
  const t = (length / 2 - cum[i - 1]!) / (cum[i]! - cum[i - 1]! || 1);
  return {
    text,
    ref: !road.name,
    rank,
    at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
    angle: Math.atan2(b[1] - a[1], b[0] - a[0]),
    length,
  };
}
