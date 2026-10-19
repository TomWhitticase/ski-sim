import type { Lift, Peak } from '../features/types';
import type { Place } from '../nav/places';
import { type PisteRecord, pisteColour, pisteTitle } from '../pistes/pistes';
import type { Pose } from '../nav/pose';
import type { Extent } from '../resort/manifest';

export interface WorldMapData {
  resortName: string;
  image: HTMLImageElement;
  /** Ground area the image covers. */
  imageExtent: Extent;
  lifts: Lift[];
  peaks: Peak[];
  pistes: PisteRecord[];
  places: Place[];
  groundHeight: (east: number, north: number) => number;
  toLatLon: (east: number, north: number) => { lat: number; lon: number };
}

const LIFT_COLOURS: Record<string, string> = {
  cable_car: '#c92a2a',
  gondola: '#e8590c',
  mixed_lift: '#e8590c',
  chair_lift: '#1864ab',
};
const DRAG_COLOUR = '#7048e8';

const MIN_MPP = 0.5; // metres per CSS pixel, fully zoomed in
const MAX_MPP = 40;
const CLICK_SLOP = 4; // px of movement before a press becomes a drag

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Fullscreen resort map: pan (drag), zoom (wheel), hover for coordinates and elevation,
 * click anywhere or pick a place from the list to teleport.
 */
export class WorldMap {
  isOpen = false;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly cursorInfo: HTMLElement;
  private readonly list: HTMLUListElement;
  private readonly search: HTMLInputElement;
  private readonly here: HTMLElement;
  private readonly scaleBar: HTMLElement;
  private readonly show = { lift: true, peak: true, piste: true };

  private centerEast = 0;
  private centerNorth = 0;
  private mpp = 8;
  private player: Pose = { east: 0, north: 0, altitude: 0, heading: 0, pitch: 0 };
  private hoverPlace: Place | null = null;
  private drag: { x: number; y: number; east: number; north: number; moved: boolean } | null = null;
  private frameRequested = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly data: WorldMapData,
    private readonly onTeleport: (pose: Pose, lookAt?: Place['lookAt']) => void,
    private readonly onClose: () => void,
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
    this.search.addEventListener('input', () => this.filterList());
    root.querySelector('.map-close')!.addEventListener('click', () => this.onClose());
    for (const box of root.querySelectorAll<HTMLInputElement>('[data-show]')) {
      box.addEventListener('change', () => {
        this.show[box.dataset.show as 'lift' | 'peak' | 'piste'] = box.checked;
        this.requestDraw();
      });
    }

    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointerleave', () => (this.cursorInfo.hidden = true));
    window.addEventListener('resize', () => this.isOpen && this.requestDraw());
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
    ctx.fillStyle = '#1b222d';
    ctx.fillRect(0, 0, w, h);

    const e = data.imageExtent;
    const [x0, y0] = this.toScreen(e.west, e.north);
    const [x1, y1] = this.toScreen(e.east, e.south);
    ctx.imageSmoothingEnabled = this.mpp > 2;
    ctx.drawImage(data.image, x0, y0, x1 - x0, y1 - y0);

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

    this.drawPlayer();
    if (this.show.lift) this.drawLifts(tryPlace);
    if (this.show.piste && this.mpp < 6) this.drawPisteNames(tryPlace);
    if (this.show.peak) this.drawPeaks(tryPlace);
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
    }
    // Names after all lines so they sit on top.
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const lift of this.data.lifts) {
      if (!lift.name) continue;
      const mid = lift.supports[Math.floor(lift.supports.length / 2)]!;
      const [x, y] = this.toScreen(mid.east, mid.north);
      const width = ctx.measureText(lift.name).width + 12;
      if (!tryPlace(x, y - 9, width, 18)) continue;
      ctx.fillStyle = LIFT_COLOURS[lift.type] ?? DRAG_COLOUR;
      this.pill(x - width / 2, y - 9, width, 18);
      ctx.fillStyle = '#fff';
      ctx.fillText(lift.name, x, y);
    }
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

  private drawHighlight(pose: Pose): void {
    const { ctx } = this;
    const [x, y] = this.toScreen(pose.east, pose.north);
    ctx.strokeStyle = '#fab005';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    ctx.stroke();
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

  // --- place list ---

  private buildList(): void {
    const icons = { start: '⌂', lift: '⇡', peak: '▲', piste: '●' };
    for (const place of this.data.places) {
      const li = document.createElement('li');
      li.className = `map-place map-place-${place.kind}`;
      li.dataset.search = fold(`${place.name} ${place.detail}`);
      li.innerHTML =
        '<span class="map-place-icon"></span><span class="map-place-name"></span><span class="map-place-detail"></span>';
      const icon = li.querySelector<HTMLElement>('.map-place-icon')!;
      icon.textContent = icons[place.kind];
      if (place.colour) icon.style.color = place.colour;
      li.querySelector('.map-place-name')!.textContent = place.name;
      li.querySelector('.map-place-detail')!.textContent = place.detail;
      li.addEventListener('click', () => this.onTeleport(place.pose, place.lookAt));
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
      li.hidden = q !== '' && !li.dataset.search!.includes(q);
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
    this.drag = {
      x: e.offsetX,
      y: e.offsetY,
      east: this.centerEast,
      north: this.centerNorth,
      moved: false,
    };
  };

  private readonly onPointerMove = (e: PointerEvent) => {
    if (this.drag) {
      const dx = e.offsetX - this.drag.x;
      const dy = e.offsetY - this.drag.y;
      if (Math.hypot(dx, dy) > CLICK_SLOP) this.drag.moved = true;
      if (this.drag.moved) {
        this.centerEast = this.drag.east - dx * this.mpp;
        this.centerNorth = this.drag.north + dy * this.mpp;
        this.clampCenter();
        this.requestDraw();
      }
    }
    this.updateCursorInfo(e.offsetX, e.offsetY);
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    const drag = this.drag;
    this.drag = null;
    if (!drag || drag.moved) return;
    const [east, north] = this.toGround(e.offsetX, e.offsetY);
    if (!this.inMap(east, north)) return;
    this.onTeleport({
      east,
      north,
      altitude: this.data.groundHeight(east, north), // grounded by the handler
      heading: this.player.heading,
      pitch: 0,
    });
  };

  private updateCursorInfo(x: number, y: number): void {
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
    info.textContent = `${lat.toFixed(5)}°, ${lon.toFixed(5)}°\n${elevation} m · click to teleport`;
    info.style.transform = `translate(${x + 16}px, ${y + 16}px)`;
    info.hidden = false;
  }
}
