import type { Airfields, Border, Lift, Peak, Restaurant } from '../features/types';
import type { Place } from '../nav/places';
import { RESTAURANT_COLOUR, drawBorders, drawRestaurantIcon } from './map-icons';
import {
  DIFFICULTY,
  FREERIDE,
  type PisteRecord,
  pisteColour,
  pisteTitle,
  RUN_TYPES,
} from '../pistes/pistes';
import type { Pose } from '../nav/pose';
import type { Extent } from '../resort/manifest';
import { classifyPress, pinchScale, PRESS } from '../controls/touch-input';

export interface WorldMapData {
  resortName: string;
  image: HTMLImageElement;
  /**
   * The same extent with the relief alone, loaded when first zoomed in past the image's
   * resolution: then runs and buildings are drawn as shapes on it (lifts always are).
   */
  baseUrl?: string;
  /** Ground area the image covers. */
  imageExtent: Extent;
  lifts: Lift[];
  peaks: Peak[];
  pistes: PisteRecord[];
  restaurants: Restaurant[];
  /** Footprints, drawn as shapes over the bare relief (optional for tests). */
  buildings?: { footprint: [number, number][]; raised?: boolean }[];
  /** Towns, villages and hamlets to label (pipeline `map_places`; older builds: the
   *  resort's start villages). */
  mapPlaces?: MapPlace[];
  borders: Border[];
  /** Runways, taxiways, aprons and helipads (missing in older builds). */
  airfields?: Airfields;
  places: Place[];
  groundHeight: (east: number, north: number) => number;
  toLatLon: (east: number, north: number) => { lat: number; lon: number };
}

/** A named settlement for a map label. */
export interface MapPlace {
  name: string;
  kind: 'town' | 'village' | 'suburb' | 'hamlet' | 'neighbourhood';
  east: number;
  north: number;
}

/** Place labels: from how far out (metres per pixel) each kind shows, and its type. */
const PLACE_STYLE: Record<MapPlace['kind'], { mpp: number; font: string }> = {
  town: { mpp: 41, font: '700 15px system-ui, sans-serif' },
  village: { mpp: 41, font: '700 13px system-ui, sans-serif' },
  suburb: { mpp: 14, font: '600 12px system-ui, sans-serif' },
  hamlet: { mpp: 7, font: '600 11px system-ui, sans-serif' },
  neighbourhood: { mpp: 3, font: '600 11px system-ui, sans-serif' },
};
/** Lift names show from this zoom in (the whole resort's would bury the village names). */
const LIFT_NAMES_MPP = 22;
/** Restaurants are only marked once zoomed in this far (beyond it they bury the lifts). */
const RESTAURANT_ICONS_MPP = 12;
/** Direction arrows on runs and lifts from this zoom in, about this far apart on screen. */
const ARROWS_MPP = 9;
const ARROW_SPACING = 170;

const LIFT_COLOURS: Record<string, string> = {
  cable_car: '#c92a2a',
  gondola: '#e8590c',
  mixed_lift: '#e8590c',
  chair_lift: '#1864ab',
};
const DRAG_COLOUR = '#7048e8';
const BORDER_TEXT = '#862e9c';
/** Airfield surfaces: paved (cleared) and snow, as the pipeline's minimap draws them. */
export const AIRFIELD_COLOURS = { paved: '#4e5056', snow: '#b2bac6', label: '#2f3a4a' };
/** Airfield names show from this zoom in; heliports' from closer. */
const AIRFIELD_NAMES_MPP = 30;
const HELIPORT_NAMES_MPP = 8;
/** Restaurant names appear once zoomed in this far (metres per pixel); dots before that. */
const RESTAURANT_NAMES_MPP = 5;

const MIN_MPP = 0.5; // metres per CSS pixel, fully zoomed in
const MAX_MPP = 40;
const CLICK_SLOP = 4; // px of movement before a press becomes a drag

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Fullscreen resort map: pan (drag), zoom (wheel), hover for coordinates and elevation,
 * right click anywhere or pick a place from the list to teleport, left click to drop a guide
 * marker (shown in the world and on the minimap; click it again to remove it). By touch:
 * drag to pan, pinch to zoom, tap for the marker, touch and hold to teleport.
 */
interface WorldPaths {
  buildings: Path2D;
  /** Per piste, in `data.pistes` order. */
  areas: Path2D[];
  lines: Path2D[];
  downhill: { pts: [number, number][]; box: readonly [number, number, number, number] }[][];
}

export class WorldMap {
  isOpen = false;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly cursorInfo: HTMLElement;
  private readonly list: HTMLUListElement;
  private readonly search: HTMLInputElement;
  private readonly here: HTMLElement;
  private readonly scaleBar: HTMLElement;
  private readonly show = { lift: true, peak: true, piste: true, restaurant: true };

  private centerEast = 0;
  private centerNorth = 0;
  private mpp = 8;
  private player: Pose = { east: 0, north: 0, altitude: 0, heading: 0, pitch: 0 };
  private hoverPlace: Place | null = null;
  private drag: {
    x: number;
    y: number;
    east: number;
    north: number;
    moved: boolean;
    at: number;
    touch: boolean;
  } | null = null;
  /** Fingers (or the mouse) on the map, by pointer id. */
  private readonly pointers = new Map<number, { x: number; y: number }>();
  /** Two fingers: the zoom and spread they started at, and the ground under their middle. */
  private pinch: { mpp: number; spread: number; east: number; north: number } | null = null;
  /** A pinch or a long press has used this gesture: lifting the fingers does nothing. */
  private gestureUsed = false;
  private longPress = 0;
  private frameRequested = false;
  private paths?: WorldPaths;
  /** The bare relief (`WorldMapData.baseUrl`), once asked for; null if it failed. */
  private base: HTMLImageElement | null | undefined;
  /** The guide marker, if one is placed. */
  marker: { east: number; north: number } | null = null;
  /**
   * Teleporting is off under the game's rules: why (said where you click), or null. Picking
   * a place then just shows it on the map.
   */
  teleportOff: string | null = null;
  /** Other players in a multiplayer game (set every frame; redrawn while the map is open). */
  private others: { east: number; north: number; colour: string; name: string }[] = [];

  constructor(
    private readonly root: HTMLElement,
    private readonly data: WorldMapData,
    private readonly onTeleport: (pose: Pose, lookAt?: Place['lookAt']) => void,
    private readonly onClose: () => void,
    private readonly onMarker: (marker: { east: number; north: number } | null) => void = () => {},
  ) {
    this.canvas = root.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.cursorInfo = root.querySelector('.map-cursor')!;
    this.list = root.querySelector('.map-places')!;
    this.search = root.querySelector('.map-search')!;
    this.here = root.querySelector('.map-here')!;
    this.scaleBar = root.querySelector('.map-scale')!;
    root.querySelector('.map-title')!.textContent = data.resortName;

    this.buildList();
    this.buildKey(root.querySelector('.map-key-list'));
    // A phone upright: the key would cover the top of the map, so it starts folded.
    if (window.matchMedia('(max-width: 760px)').matches) {
      root.querySelector<HTMLDetailsElement>('.map-key')!.open = false;
    }
    this.search.addEventListener('input', () => this.filterList());
    root.querySelector('.map-close')!.addEventListener('click', () => this.onClose());
    for (const box of root.querySelectorAll<HTMLInputElement>('[data-show]')) {
      box.addEventListener('change', () => {
        this.show[box.dataset.show as keyof typeof this.show] = box.checked;
        this.filterList();
        this.requestDraw();
      });
    }

    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerCancel);
    this.canvas.addEventListener('pointerleave', () => (this.cursorInfo.hidden = true));
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('resize', () => this.isOpen && this.requestDraw());
  }

  /** Other players' positions; redraws an open map when anyone has moved on screen. */
  setPlayers(players: { east: number; north: number; colour: string; name: string }[]): void {
    const moved =
      players.length !== this.others.length ||
      players.some((p, i) => {
        const o = this.others[i]!;
        return o.name !== p.name || Math.hypot(o.east - p.east, o.north - p.north) > this.mpp;
      });
    if (!moved) return;
    this.others = players.map((p) => ({ ...p }));
    if (this.isOpen) this.requestDraw();
  }

  open(player: Pose): void {
    this.player = player;
    this.centerEast = player.east;
    this.centerNorth = player.north;
    this.mpp = 6;
    this.isOpen = true;
    this.root.hidden = false;
    this.search.value = '';
    this.filterList();
    const { lat, lon } = this.data.toLatLon(player.east, player.north);
    this.here.textContent = `You: ${lat.toFixed(5)}°, ${lon.toFixed(5)}° · ${Math.round(player.altitude).toLocaleString('en-GB')} m`;
    this.requestDraw();
  }

  close(): void {
    this.isOpen = false;
    this.root.hidden = true;
    this.cursorInfo.hidden = true;
  }

  // --- coordinate transforms (CSS pixels) ---

  private toScreen(east: number, north: number): [number, number] {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    return [
      (east - this.centerEast) / this.mpp + w / 2,
      (this.centerNorth - north) / this.mpp + h / 2,
    ];
  }

  private toGround(x: number, y: number): [number, number] {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    return [this.centerEast + (x - w / 2) * this.mpp, this.centerNorth - (y - h / 2) * this.mpp];
  }

  private inMap(east: number, north: number): boolean {
    const e = this.data.imageExtent;
    return east >= e.west && east <= e.east && north >= e.south && north <= e.north;
  }

  private clampCenter(): void {
    const e = this.data.imageExtent;
    this.centerEast = Math.min(Math.max(this.centerEast, e.west), e.east);
    this.centerNorth = Math.min(Math.max(this.centerNorth, e.south), e.north);
  }

  // --- drawing ---

  private requestDraw(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      if (this.isOpen) this.draw();
    });
  }

  private draw(): void {
    const { canvas, ctx, data } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#e1e8ef'; // beyond the map: light, like the menus
    ctx.fillRect(0, 0, w, h);

    const e = data.imageExtent;
    const [x0, y0] = this.toScreen(e.west, e.north);
    const [x1, y1] = this.toScreen(e.east, e.south);
    // The bare relief, with runs, lifts and buildings drawn as shapes on it: sharp at any
    // zoom, and the Lifts / Pistes switches really take them off. Older builds have only
    // the full image (everything baked in); then shapes go on top when zoomed past it.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const cell = (e.east - e.west) / data.image.width;
    if (data.baseUrl && this.base === undefined) {
      this.base = new Image();
      this.base.src = data.baseUrl;
      this.base.decode().then(
        () => this.requestDraw(),
        () => (this.base = null),
      );
    }
    const bare = !!(this.base?.complete && this.base.naturalWidth > 0);
    ctx.drawImage(bare ? this.base! : data.image, x0, y0, x1 - x0, y1 - y0);
    const shapes = bare || this.mpp < cell;
    if (shapes) this.drawAirfields();
    if (shapes) this.drawBuildings();
    if (shapes && this.show.piste) this.drawPisteLines(cell, bare);
    if (bare && this.show.piste && this.mpp < ARROWS_MPP) this.drawRunArrows(cell);

    // Treat the side panel as occupied so names aren't drawn underneath it.
    const panel = this.root.querySelector('.map-panel')!.getBoundingClientRect();
    const placed: [number, number, number, number][] = [
      [panel.left, panel.top, panel.right, panel.bottom],
    ];
    const tryPlace = (cx: number, top: number, width: number, height: number) => {
      const box: [number, number, number, number] = [
        cx - width / 2,
        top,
        cx + width / 2,
        top + height,
      ];
      const hit = placed.some(
        (o) => box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1],
      );
      if (!hit) placed.push(box);
      return !hit;
    };

    drawBorders(ctx, data.borders, (e, n) => this.toScreen(e, n), 1);
    this.drawBorderNames(tryPlace);
    this.drawPlayer();
    this.drawMarker();
    this.drawPlaceNames(tryPlace);
    this.drawAirfieldNames(tryPlace);
    if (this.show.lift) this.drawLifts(tryPlace);
    if (this.show.piste && this.mpp < 6) this.drawPisteNames(tryPlace);
    if (this.show.peak) this.drawPeaks(tryPlace);
    if (this.show.restaurant && this.mpp < RESTAURANT_ICONS_MPP) this.drawRestaurants(tryPlace);
    this.drawOthers();
    if (this.hoverPlace) this.drawHighlight(this.hoverPlace.pose);
    this.updateScaleBar();
  }

  private drawLifts(tryPlace: (cx: number, top: number, w: number, h: number) => boolean): void {
    const { ctx } = this;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const lift of this.data.lifts) {
      const colour = LIFT_COLOURS[lift.type] ?? DRAG_COLOUR;
      const pts = lift.supports.map((s) => this.toScreen(s.east, s.north));
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 5;
      this.polyline(pts);
      ctx.strokeStyle = colour;
      ctx.lineWidth = 2.5;
      this.polyline(pts);
      ctx.fillStyle = colour;
      for (const [x, y] of [pts[0]!, pts[pts.length - 1]!]) {
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      // Which way it goes: up from the bottom station (two-way cabins too).
      if (this.mpp < ARROWS_MPP * 2) {
        const first = lift.supports[0]!;
        const last = lift.supports[lift.supports.length - 1]!;
        const up = last.ground >= first.ground ? pts : [...pts].reverse();
        this.arrows(up, colour, 4, ARROW_SPACING * 1.4);
      }
    }
    // Names after all lines so they sit on top; the longest lifts claim space first.
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const byLength =
      this.mpp < LIFT_NAMES_MPP ? [...this.data.lifts].sort((a, b) => b.length - a.length) : [];
    for (const lift of byLength) {
      if (!lift.name) continue;
      const mid = lift.supports[Math.floor(lift.supports.length / 2)]!;
      const [x, y] = this.toScreen(mid.east, mid.north);
      if (
        x < -100 ||
        y < -20 ||
        x > this.canvas.clientWidth + 100 ||
        y > this.canvas.clientHeight + 20
      )
        continue;
      const width = ctx.measureText(lift.name).width + 12;
      if (!tryPlace(x, y - 9, width, 18)) continue;
      ctx.fillStyle = LIFT_COLOURS[lift.type] ?? DRAG_COLOUR;
      this.pill(x - width / 2, y - 9, width, 18);
      ctx.fillStyle = '#fff';
      ctx.fillText(lift.name, x, y);
    }
  }

  /**
   * Small chevrons along a polyline (screen px) pointing from its first point to its last,
   * about `spacing` apart and none on a line shorter than that: a white mark with a
   * coloured edge, like a printed piste map's.
   */
  private arrows(pts: [number, number][], colour: string, size: number, spacing: number): void {
    const { ctx } = this;
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      total += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
    }
    if (total < spacing * 0.6) return;
    const count = Math.max(1, Math.floor(total / spacing));
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    let k = 0;
    let along = 0;
    for (let i = 1; i < pts.length && k < count; i++) {
      const [ax, ay] = pts[i - 1]!;
      const [bx, by] = pts[i]!;
      const seg = Math.hypot(bx - ax, by - ay);
      while (k < count && (total * (k + 0.5)) / count <= along + seg) {
        const t = ((total * (k + 0.5)) / count - along) / (seg || 1);
        const x = ax + (bx - ax) * t;
        const y = ay + (by - ay) * t;
        k++;
        if (x < -10 || y < -10 || x > w + 10 || y > h + 10) continue;
        const a = Math.atan2(by - ay, bx - ax);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(a);
        ctx.beginPath();
        ctx.moveTo(-size * 0.7, -size);
        ctx.lineTo(size * 0.8, 0);
        ctx.lineTo(-size * 0.7, size);
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.strokeStyle = colour;
        ctx.lineWidth = 3.4;
        ctx.stroke();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.6;
        ctx.stroke();
        ctx.restore();
      }
      along += seg;
    }
  }

  /** Chevrons down each run (from its higher end to its lower). */
  private drawRunArrows(cell: number): void {
    // As big as the run's line is wide (it widens with the zoom), at least a clear mark.
    const size = Math.max(3.5, Math.min(9, ((3 * cell) / this.mpp) * 0.45));
    const [w, s, e, n] = this.screenBox(ARROW_SPACING);
    const { downhill } = this.worldPaths();
    this.data.pistes.forEach((piste, i) => {
      for (const { pts, box } of downhill[i]!) {
        if (box[2] < w || box[0] > e || box[3] < s || box[1] > n) continue;
        this.arrows(
          pts.map(([pe, pn]) => this.toScreen(pe, pn)),
          pisteColour(piste),
          size,
          ARROW_SPACING,
        );
      }
    });
  }

  /** Town, village and hamlet names, as on a printed map: dark text with a white halo. */
  private drawPlaceNames(
    tryPlace: (cx: number, top: number, w: number, h: number) => boolean,
  ): void {
    const { ctx } = this;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const place of this.data.mapPlaces ?? []) {
      const style = PLACE_STYLE[place.kind];
      if (!style || this.mpp > style.mpp) continue;
      const [x, y] = this.toScreen(place.east, place.north);
      if (
        x < -100 ||
        y < -20 ||
        x > this.canvas.clientWidth + 100 ||
        y > this.canvas.clientHeight + 20
      )
        continue;
      ctx.font = style.font;
      const width = ctx.measureText(place.name).width + 6;
      if (!tryPlace(x, y - 9, width, 18)) continue;
      ctx.lineJoin = 'round';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
      ctx.strokeText(place.name, x, y);
      ctx.fillStyle = '#2b2f36';
      ctx.fillText(place.name, x, y);
    }
  }

  /**
   * Runways, taxiways and aprons as shapes at their ground width (never under 2 px), and
   * helipads as a ringed H (a dot zoomed out).
   */
  private drawAirfields(): void {
    const fields = this.data.airfields;
    if (!fields) return;
    const { ctx } = this;
    const colour = (w: string) =>
      w === 'cleared' ? AIRFIELD_COLOURS.paved : AIRFIELD_COLOURS.snow;
    for (const apron of fields.aprons) {
      ctx.fillStyle = colour(apron.winter);
      ctx.beginPath();
      apron.ring.forEach(([e, n], i) => {
        const [x, y] = this.toScreen(e, n);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.closePath();
      ctx.fill();
    }
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    for (const strip of [...fields.taxiways, ...fields.runways]) {
      ctx.strokeStyle = colour(strip.winter);
      ctx.lineWidth = Math.max(2, strip.width / this.mpp);
      this.polyline(strip.line.map(([e, n]) => this.toScreen(e, n)));
    }
    // A runway's centreline, once it's wide enough to show one.
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1;
    for (const r of fields.runways) {
      if (r.width / this.mpp < 6) continue;
      this.polyline(r.line.map(([e, n]) => this.toScreen(e, n)));
    }
    ctx.setLineDash([]);
    ctx.lineCap = 'round';
    for (const pad of fields.helipads) {
      const [x, y] = this.toScreen(pad.east, pad.north);
      const r = Math.max(4, pad.size / 2 / this.mpp);
      ctx.fillStyle = pad.winter === 'cleared' ? AIRFIELD_COLOURS.paved : '#fff';
      ctx.strokeStyle = pad.winter === 'cleared' ? '#fff' : '#c92a2a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (r < 6) continue;
      const h = r * 0.55;
      ctx.beginPath();
      ctx.moveTo(x - h * 0.6, y - h);
      ctx.lineTo(x - h * 0.6, y + h);
      ctx.moveTo(x + h * 0.6, y - h);
      ctx.lineTo(x + h * 0.6, y + h);
      ctx.moveTo(x - h * 0.6, y);
      ctx.lineTo(x + h * 0.6, y);
      ctx.stroke();
    }
  }

  /** "Altiport de Courchevel": airfields from AIRFIELD_NAMES_MPP in, heliports closer. */
  private drawAirfieldNames(
    tryPlace: (cx: number, top: number, w: number, h: number) => boolean,
  ): void {
    const { ctx } = this;
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const a of this.data.airfields?.aerodromes ?? []) {
      if (this.mpp > (a.kind === 'heliport' ? HELIPORT_NAMES_MPP : AIRFIELD_NAMES_MPP)) continue;
      const [x, y] = this.toScreen(a.east, a.north);
      const name = `${a.kind === 'heliport' ? 'Ⓗ' : '✈'} ${a.name}`;
      const width = ctx.measureText(name).width + 12;
      if (!tryPlace(x, y - 26, width, 18)) continue;
      ctx.fillStyle = AIRFIELD_COLOURS.label;
      this.pill(x - width / 2, y - 26, width, 18);
      ctx.fillStyle = '#fff';
      ctx.fillText(name, x, y - 17);
    }
  }

  /** Building footprints as shapes (the minimap's colour): one fill of a cached path. */
  private drawBuildings(): void {
    const { ctx } = this;
    ctx.save();
    this.worldTransform();
    ctx.fillStyle = 'rgb(112, 104, 100)';
    ctx.fill(this.worldPaths().buildings);
    ctx.restore();
  }

  /**
   * Shapes in world metres, built once. Drawn through `worldTransform`, a pan or zoom then
   * costs one fill or stroke per shape instead of projecting every point in JS (19,600
   * footprints and 50,000 run points in the 3 Vallées took ~75 ms a frame to drag).
   */
  private worldPaths(): WorldPaths {
    if (this.paths) return this.paths;
    const ring = (path: Path2D, pts: [number, number][], close: boolean) => {
      pts.forEach(([e, n], i) => (i ? path.lineTo(e, n) : path.moveTo(e, n)));
      if (close) path.closePath();
    };
    const buildings = new Path2D();
    for (const b of this.data.buildings ?? []) {
      // A piece above a cut: its ground-floor piece is drawn.
      if (!b.raised && b.footprint.length >= 3) ring(buildings, b.footprint, true);
    }
    const areas = this.data.pistes.map((piste) => {
      const path = new Path2D();
      for (const area of piste.areas) ring(path, area, true);
      return path;
    });
    const lines = this.data.pistes.map((piste) => {
      const path = new Path2D();
      for (const line of piste.lines) ring(path, line, false);
      return path;
    });
    // Down each run from its higher end, with its bounds for culling.
    const downhill = this.data.pistes.map((piste) =>
      piste.lines
        .filter((line) => line.length >= 2)
        .map((line) => {
          const a = line[0]!;
          const b = line[line.length - 1]!;
          const pts =
            this.data.groundHeight(a[0], a[1]) >= this.data.groundHeight(b[0], b[1])
              ? line
              : [...line].reverse();
          const es = pts.map((p) => p[0]);
          const ns = pts.map((p) => p[1]);
          return {
            pts,
            box: [Math.min(...es), Math.min(...ns), Math.max(...es), Math.max(...ns)] as const,
          };
        }),
    );
    this.paths = { buildings, areas, lines, downhill };
    return this.paths;
  }

  /** Maps world metres (east, north) to the screen, for `worldPaths`; line widths and
   *  dashes are then in metres (screen px × mpp). */
  private worldTransform(): void {
    const dpr = window.devicePixelRatio || 1;
    const k = dpr / this.mpp;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.ctx.setTransform(
      k,
      0,
      0,
      -k,
      dpr * (w / 2) - k * this.centerEast,
      dpr * (h / 2) + k * this.centerNorth,
    );
  }

  /** The world (west, south, east, north) on screen, plus `pad` px. */
  private screenBox(pad: number): [number, number, number, number] {
    const half = (px: number) => (px / 2 + pad) * this.mpp;
    const dx = half(this.canvas.clientWidth);
    const dy = half(this.canvas.clientHeight);
    return [
      this.centerEast - dx,
      this.centerNorth - dy,
      this.centerEast + dx,
      this.centerNorth + dy,
    ];
  }

  /**
   * Runs as shapes, matching the pipeline's minimap (`draw_pistes`): lines 3 px of `cell`
   * m wide (2 for cross-country, connections and dashed routes), and on the bare relief
   * (`withAreas`) the translucent areas too. Slightly wider over the full image, so they
   * cover the baked line's soft edge.
   */
  private drawPisteLines(cell: number, withAreas: boolean): void {
    const { ctx } = this;
    const scale = cell / this.mpp;
    const { areas, lines } = this.worldPaths();
    const m = this.mpp; // px to metres, under the world transform
    ctx.save();
    this.worldTransform();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (withAreas) {
      this.data.pistes.forEach((piste, i) => {
        if (!piste.areas.length) return;
        ctx.fillStyle = pisteColour(piste);
        ctx.globalAlpha = piste.type === 'snow_park' ? 0.59 : 0.27;
        ctx.fill(areas[i]!);
      });
    }
    this.data.pistes.forEach((piste, i) => {
      const route =
        piste.difficulty === FREERIDE || piste.type === 'skitour' || piste.type === 'hike';
      const thin = route || piste.type === 'nordic' || piste.type === 'connection';
      ctx.strokeStyle = pisteColour(piste);
      // Solid: translucent, each segment's round end would show darker where they meet.
      ctx.globalAlpha = 1;
      // Their ground width when zoomed in; never thinner than a clear line zoomed out.
      ctx.lineWidth = Math.max(thin ? 1.6 : 2.4, (thin ? 2 : 3) * scale + (withAreas ? 0 : 1)) * m;
      ctx.setLineDash(route ? [Math.max(6, 7 * scale) * m, Math.max(4, 5 * scale) * m] : []);
      ctx.stroke(lines[i]!);
    });
    ctx.restore();
  }

  private drawPisteNames(
    tryPlace: (cx: number, top: number, w: number, h: number) => boolean,
  ): void {
    const { ctx } = this;
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const piste of this.data.pistes) {
      if (!piste.name) continue;
      const [x, y] = this.toScreen(piste.label.east, piste.label.north);
      const name = pisteTitle(piste);
      const width = ctx.measureText(name).width + 10;
      if (!tryPlace(x, y - 8, width, 16)) continue;
      ctx.fillStyle = pisteColour(piste);
      ctx.globalAlpha = 0.9;
      this.pill(x - width / 2, y - 8, width, 16);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#fff';
      ctx.fillText(name, x, y);
    }
  }

  private drawRestaurants(
    tryPlace: (cx: number, top: number, w: number, h: number) => boolean,
  ): void {
    const { ctx } = this;
    const named = this.mpp < RESTAURANT_NAMES_MPP;
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const r of this.data.restaurants) {
      const [x, y] = this.toScreen(r.east, r.north);
      if (
        x < -50 ||
        y < -50 ||
        x > this.canvas.clientWidth + 50 ||
        y > this.canvas.clientHeight + 50
      )
        continue;
      const r0 = named ? 9 : 7;
      if (!tryPlace(x, y - r0, 2 * r0, 2 * r0)) continue; // icons don't pile up on others
      drawRestaurantIcon(ctx, x, y, r0);
      if (!named) continue;
      const width = ctx.measureText(r.name).width + 10;
      if (!tryPlace(x, y - 28, width, 16)) continue;
      ctx.fillStyle = RESTAURANT_COLOUR;
      this.pill(x - width / 2, y - 28, width, 16);
      ctx.fillStyle = '#fff';
      ctx.fillText(r.name, x, y - 20);
    }
  }

  private drawPeaks(tryPlace: (cx: number, top: number, w: number, h: number) => boolean): void {
    const { ctx } = this;
    const peaks = [...this.data.peaks].sort((a, b) => (b.ele ?? b.ground) - (a.ele ?? a.ground));
    for (const peak of peaks) {
      const [x, y] = this.toScreen(peak.east, peak.north);
      if (
        x < -50 ||
        y < -50 ||
        x > this.canvas.clientWidth + 50 ||
        y > this.canvas.clientHeight + 50
      )
        continue;
      const ele = `${Math.round(peak.ele ?? peak.ground).toLocaleString('en-GB')} m`;
      ctx.font = '600 12px system-ui, sans-serif';
      const width = Math.max(ctx.measureText(peak.name).width, 40) + 8;
      if (!tryPlace(x, y - 36, width, 44)) continue;
      ctx.fillStyle = '#1e1e24';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y - 7);
      ctx.lineTo(x + 6, y + 4);
      ctx.lineTo(x - 6, y + 4);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeText(peak.name, x, y - 22);
      ctx.fillText(peak.name, x, y - 22);
      ctx.font = '11px system-ui, sans-serif';
      ctx.strokeText(ele, x, y - 10);
      ctx.fillText(ele, x, y - 10);
    }
  }

  private drawPlayer(): void {
    const { ctx } = this;
    const [x, y] = this.toScreen(this.player.east, this.player.north);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((this.player.heading * Math.PI) / 180);
    ctx.fillStyle = 'rgba(232, 64, 47, 0.18)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 60, -Math.PI / 2 - 0.6, -Math.PI / 2 + 0.6);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#e8402f';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(9, 10);
    ctx.lineTo(0, 5);
    ctx.lineTo(-9, 10);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    ctx.restore();
  }

  /** Other players: a dot in their colour with their name, always on top. */
  private drawOthers(): void {
    const { ctx } = this;
    ctx.save();
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const p of this.others) {
      const [x, y] = this.toScreen(p.east, p.north);
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fillStyle = p.colour;
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
      ctx.strokeText(p.name, x, y - 10);
      ctx.fillStyle = '#fff';
      ctx.fillText(p.name, x, y - 10);
    }
    ctx.restore();
  }

  private drawMarker(): void {
    if (!this.marker) return;
    const { ctx } = this;
    const [x, y] = this.toScreen(this.marker.east, this.marker.north);
    ctx.save();
    ctx.fillStyle = '#ff8a1f';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    // A map pin: round head, point at the spot.
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.bezierCurveTo(x - 4, y - 8, x - 10, y - 13, x - 10, y - 20);
    ctx.arc(x, y - 20, 10, Math.PI, 0);
    ctx.bezierCurveTo(x + 10, y - 13, x + 4, y - 8, x, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(x, y - 20, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawHighlight(pose: Pose): void {
    const { ctx } = this;
    const [x, y] = this.toScreen(pose.east, pose.north);
    ctx.strokeStyle = '#fab005';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    ctx.stroke();
  }

  /**
   * Country names either side of each border, a little in from its middle, where they
   * fit. The line is OSM's: where countries disagree about a border, it's one version.
   */
  private drawBorderNames(
    tryPlace: (cx: number, top: number, w: number, h: number) => boolean,
  ): void {
    const { ctx } = this;
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const border of this.data.borders) {
      const pts = border.line.map(([e, n]) => this.toScreen(e, n));
      const [x, y, dx, dy] = onScreenMiddle(pts, this.canvas.clientWidth, this.canvas.clientHeight);
      if (Number.isNaN(x)) continue;
      // Left of the line's direction on screen (y down) is (dy, -dx).
      for (const [name, side] of [
        [border.left, 1],
        [border.right, -1],
      ] as const) {
        if (!name) continue;
        const label = name.toUpperCase();
        const width = ctx.measureText(label).width + 10;
        const lx = x + side * dy * (width / 2 + 10);
        const ly = y - side * dx * 22;
        if (!tryPlace(lx, ly - 8, width, 16)) continue;
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.strokeText(label, lx, ly);
        ctx.fillStyle = BORDER_TEXT;
        ctx.fillText(label, lx, ly);
      }
    }
  }

  private polyline(pts: [number, number][]): void {
    const { ctx } = this;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  }

  private pill(x: number, y: number, w: number, h: number): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, h / 2);
    ctx.fill();
  }

  private updateScaleBar(): void {
    // Pick a round distance that is roughly 120 px long.
    const target = this.mpp * 120;
    const steps = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];
    const metres = steps.find((s) => s >= target) ?? steps[steps.length - 1]!;
    this.scaleBar.style.width = `${metres / this.mpp}px`;
    this.scaleBar.textContent = metres >= 1000 ? `${metres / 1000} km` : `${metres} m`;
  }

  // --- key ---

  /**
   * What the colours and marks mean: only what this resort has (a run type it has no
   * runs of isn't listed), in the order a printed piste map's key goes.
   */
  private buildKey(list: HTMLUListElement | null): void {
    if (!list) return;
    const has = (test: (p: PisteRecord) => boolean) => this.data.pistes.some(test);
    const route = (p: PisteRecord) =>
      p.difficulty === FREERIDE || p.type === 'skitour' || p.type === 'hike';
    const rows: [string, string, string][] = []; // [swatch class, colour, label]
    for (const code of [1, 2, 3, 4] as const) {
      if (
        has(
          (p) =>
            (p.type ?? 'downhill') === 'downhill' &&
            (p.difficulty === code || (code === 4 && p.difficulty === 5)),
        )
      )
        rows.push(['line', DIFFICULTY[code].colour, `${DIFFICULTY[code].name} piste`]);
    }
    if (has((p) => p.difficulty === FREERIDE))
      rows.push(['dash', DIFFICULTY[FREERIDE].colour, 'Off-piste itinerary']);
    for (const type of [
      'skitour',
      'hike',
      'nordic',
      'snow_park',
      'sled',
      'playground',
      'connection',
    ] as const) {
      if (has((p) => p.type === type && !(type !== 'skitour' && type !== 'hike' && route(p))))
        rows.push([
          type === 'skitour' || type === 'hike' ? 'dash' : type === 'snow_park' ? 'area' : 'line',
          RUN_TYPES[type].colour!,
          RUN_TYPES[type].name,
        ]);
    }
    const lifts = new Set(this.data.lifts.map((l) => (l.type in LIFT_COLOURS ? l.type : 'drag')));
    const liftNames: Record<string, string> = {
      cable_car: 'Cable car',
      gondola: 'Gondola',
      mixed_lift: 'Gondola and chairs',
      chair_lift: 'Chairlift',
      drag: 'Drag lift',
    };
    for (const type of ['cable_car', 'gondola', 'mixed_lift', 'chair_lift', 'drag']) {
      if (lifts.has(type)) rows.push(['lift', LIFT_COLOURS[type] ?? DRAG_COLOUR, liftNames[type]!]);
    }
    rows.push(['arrow', '#2b2f36', 'Direction of travel']);
    const fields = this.data.airfields;
    const strips = [...(fields?.runways ?? []), ...(fields?.taxiways ?? [])];
    if (strips.some((r) => r.winter === 'cleared'))
      rows.push(['runway', AIRFIELD_COLOURS.paved, 'Runway, cleared']);
    if (strips.some((r) => r.winter !== 'cleared'))
      rows.push(['runway', AIRFIELD_COLOURS.snow, 'Snow runway']);
    if (fields?.helipads.length) rows.push(['helipad', AIRFIELD_COLOURS.paved, 'Helipad']);
    if (this.data.restaurants.length) rows.push(['restaurant', RESTAURANT_COLOUR, 'Restaurant']);
    if (this.data.peaks.length) rows.push(['peak', '#1e1e24', 'Summit']);
    if (this.data.borders.length) rows.push(['border', BORDER_TEXT, 'National border']);
    for (const [swatch, colour, label] of rows) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="map-key-swatch"></span><span></span>';
      const sw = li.firstElementChild as HTMLElement;
      sw.classList.add(`map-key-${swatch}`);
      sw.style.setProperty('--swatch', colour);
      li.lastElementChild!.textContent = label;
      list.appendChild(li);
    }
  }

  // --- place list ---

  private buildList(): void {
    const icons = {
      start: '⌂',
      lift: '⇡',
      peak: '▲',
      piste: '●',
      restaurant: '🍴',
      airfield: '✈',
    };
    for (const place of this.data.places) {
      const li = document.createElement('li');
      li.className = `map-place map-place-${place.kind}`;
      li.dataset.kind = place.kind;
      li.dataset.search = fold(`${place.name} ${place.detail}`);
      li.innerHTML =
        '<span class="map-place-icon"></span><span class="map-place-name"></span><span class="map-place-detail"></span>';
      const icon = li.querySelector<HTMLElement>('.map-place-icon')!;
      icon.textContent = icons[place.kind];
      if (place.colour) icon.style.color = place.colour;
      li.querySelector('.map-place-name')!.textContent = place.name;
      li.querySelector('.map-place-detail')!.textContent = place.detail;
      li.addEventListener('click', () => {
        if (!this.teleportOff) return this.onTeleport(place.pose, place.lookAt);
        this.centerEast = place.pose.east;
        this.centerNorth = place.pose.north;
        this.clampCenter();
        this.requestDraw();
      });
      li.addEventListener('mouseenter', () => {
        this.hoverPlace = place;
        this.requestDraw();
      });
      li.addEventListener('mouseleave', () => {
        this.hoverPlace = null;
        this.requestDraw();
      });
      this.list.appendChild(li);
    }
  }

  private filterList(): void {
    const q = fold(this.search.value.trim());
    for (const li of this.list.children as HTMLCollectionOf<HTMLElement>) {
      // Switching a kind off takes it off the list as well as the map (starts always stay).
      const kind = li.dataset.kind as keyof typeof this.show;
      const shown = !(kind in this.show) || this.show[kind];
      li.hidden = !shown || (q !== '' && !li.dataset.search!.includes(q));
    }
  }

  // --- input ---

  private readonly onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const [east, north] = this.toGround(e.offsetX, e.offsetY);
    const factor = Math.pow(1.0015, e.deltaY);
    this.mpp = Math.min(Math.max(this.mpp * factor, MIN_MPP), MAX_MPP);
    // Keep the point under the cursor fixed while zooming.
    const [east2, north2] = this.toGround(e.offsetX, e.offsetY);
    this.centerEast += east - east2;
    this.centerNorth += north - north2;
    this.clampCenter();
    this.requestDraw();
  };

  private readonly onPointerDown = (e: PointerEvent) => {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    clearTimeout(this.longPress);
    if (this.pointers.size === 2) {
      // A second finger: pinch zoom about the middle of the two.
      const [a, b] = [...this.pointers.values()] as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      const [east, north] = this.toGround((a.x + b.x) / 2, (a.y + b.y) / 2);
      this.pinch = { mpp: this.mpp, spread: Math.hypot(a.x - b.x, a.y - b.y), east, north };
      this.drag = null;
      this.gestureUsed = true;
      this.cursorInfo.hidden = true;
      return;
    }
    if (this.pointers.size > 2) return;
    this.gestureUsed = false;
    const touch = e.pointerType !== 'mouse';
    this.drag = {
      x: e.offsetX,
      y: e.offsetY,
      east: this.centerEast,
      north: this.centerNorth,
      moved: false,
      at: performance.now(),
      touch,
    };
    if (touch) {
      // Touch and hold: teleport there (the readout says so while you hold).
      this.updateCursorInfo(e.offsetX, e.offsetY);
      this.longPress = window.setTimeout(() => {
        const drag = this.drag;
        if (!drag || drag.moved || this.pointers.size !== 1) return;
        this.gestureUsed = true;
        navigator.vibrate?.(15);
        this.teleportTo(drag.x, drag.y);
      }, PRESS.longMs);
    }
  };

  private readonly onPointerMove = (e: PointerEvent) => {
    if (this.pointers.has(e.pointerId))
      this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()] as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      this.mpp = pinchScale(
        this.pinch.mpp,
        this.pinch.spread,
        Math.hypot(a.x - b.x, a.y - b.y),
        MIN_MPP,
        MAX_MPP,
      );
      // Keep the ground that was under the fingers' middle under it (zoom and pan at once).
      this.centerEast = this.pinch.east - (mx - this.canvas.clientWidth / 2) * this.mpp;
      this.centerNorth = this.pinch.north + (my - this.canvas.clientHeight / 2) * this.mpp;
      this.clampCenter();
      this.requestDraw();
      return;
    }
    if (this.drag) {
      const dx = e.offsetX - this.drag.x;
      const dy = e.offsetY - this.drag.y;
      if (Math.hypot(dx, dy) > (this.drag.touch ? PRESS.slop : CLICK_SLOP)) {
        this.drag.moved = true;
        clearTimeout(this.longPress);
      }
      if (this.drag.moved) {
        this.centerEast = this.drag.east - dx * this.mpp;
        this.centerNorth = this.drag.north + dy * this.mpp;
        this.clampCenter();
        this.requestDraw();
      }
    }
    if (e.pointerType === 'mouse' || this.drag) this.updateCursorInfo(e.offsetX, e.offsetY);
  };

  private readonly onPointerCancel = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    clearTimeout(this.longPress);
    this.drag = null;
    this.pinch = null;
    this.cursorInfo.hidden = true;
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    clearTimeout(this.longPress);
    const drag = this.drag;
    this.drag = null;
    if (drag?.touch) this.cursorInfo.hidden = true;
    if (!drag || this.gestureUsed) return;
    const travel = Math.hypot(e.offsetX - drag.x, e.offsetY - drag.y);
    const press = drag.moved ? 'drag' : classifyPress(performance.now() - drag.at, travel, true);
    if (press === 'drag') return;
    const [east, north] = this.toGround(e.offsetX, e.offsetY);
    if (!this.inMap(east, north)) return;
    if (e.button === 2 || (drag.touch && press === 'long-press')) {
      this.teleportTo(e.offsetX, e.offsetY);
      return;
    }
    if (e.button !== 0) return;
    // Left click drops the guide marker; clicking the marker again removes it.
    let next: { east: number; north: number } | null = { east, north };
    if (this.marker) {
      const [mx, my] = this.toScreen(this.marker.east, this.marker.north);
      const reach = drag.touch ? 24 : 16;
      if (Math.hypot(e.offsetX - mx, e.offsetY - (my - 14)) < reach) next = null;
    }
    this.marker = next;
    this.onMarker(next);
    this.requestDraw();
    if (!drag.touch) this.updateCursorInfo(e.offsetX, e.offsetY);
  };

  /** Teleport to the ground under screen point (x, y), if it's on the map. */
  private teleportTo(x: number, y: number): void {
    const [east, north] = this.toGround(x, y);
    if (!this.inMap(east, north)) return;
    if (this.teleportOff) {
      // Say so right where you clicked (the HUD's notices are under the map).
      this.updateCursorInfo(x, y, this.teleportOff);
      return;
    }
    this.cursorInfo.hidden = true;
    this.onTeleport({
      east,
      north,
      altitude: this.data.groundHeight(east, north), // grounded by the handler
      heading: this.player.heading,
      pitch: 0,
    });
  }

  private updateCursorInfo(x: number, y: number, note?: string): void {
    const [east, north] = this.toGround(x, y);
    const info = this.cursorInfo;
    if (!this.inMap(east, north) || this.drag?.moved) {
      info.hidden = true;
      this.canvas.style.cursor = this.drag?.moved ? 'grabbing' : 'default';
      return;
    }
    this.canvas.style.cursor = 'crosshair';
    const { lat, lon } = this.data.toLatLon(east, north);
    const elevation = Math.round(this.data.groundHeight(east, north)).toLocaleString('en-GB');
    const touch = this.drag?.touch;
    const how =
      note ??
      (this.teleportOff
        ? `${touch ? 'tap' : 'left click'}: marker`
        : touch
          ? 'hold: teleport · tap: marker'
          : 'left click: marker · right click: teleport');
    info.textContent = `${lat.toFixed(5)}°, ${lon.toFixed(5)}°\n${elevation} m · ${how}`;
    // Above a finger (which hides what's under it), beside a mouse pointer.
    info.style.transform = touch
      ? `translate(calc(${x}px - 50%), ${y - 90}px)`
      : `translate(${x + 16}px, ${y + 16}px)`;
    info.hidden = false;
  }
}

/**
 * A point near the middle of the part of a screen polyline that's in view, and the unit
 * direction of the line there; NaNs if none of it is.
 */
export function onScreenMiddle(
  pts: [number, number][],
  width: number,
  height: number,
): [number, number, number, number] {
  const inside = (p: [number, number]) => p[0] >= 0 && p[1] >= 0 && p[0] <= width && p[1] <= height;
  const segs: { a: [number, number]; b: [number, number]; len: number }[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (!inside(a) || !inside(b)) continue;
    const len = Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
    if (len < 1e-6) continue;
    segs.push({ a, b, len });
    total += len;
  }
  let left = total / 2;
  for (const { a, b, len } of segs) {
    if (left <= len) {
      const t = left / len;
      return [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        (b[0] - a[0]) / len,
        (b[1] - a[1]) / len,
      ];
    }
    left -= len;
  }
  return [NaN, NaN, NaN, NaN];
}
