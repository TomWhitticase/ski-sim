import { MINIMAP } from '../config';
import type { Extent } from '../resort/manifest';
import { drawRestaurantIcon } from './map-icons';

/**
 * North-up map centred on the player, drawn from the pipeline's minimap image.
 * Zoom with - and = .
 */
export class Minimap {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly scaleLabel: HTMLElement;
  private zoomIndex: number = MINIMAP.defaultZoom;
  private lastKey = '';
  /** Mountain restaurants (east, north), drawn as knife-and-fork badges. */
  restaurants: { east: number; north: number }[] = [];
  /** The map's guide marker (orange dot; on the edge when out of range). */
  waypoint: { east: number; north: number } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    readonly image: HTMLImageElement,
    private readonly extent: Extent,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.scaleLabel = canvas.parentElement!.querySelector<HTMLElement>('.minimap-scale')!;
    document.addEventListener('keydown', this.onKeyDown);
  }

  static async load(canvas: HTMLCanvasElement, url: string, extent: Extent): Promise<Minimap> {
    const image = new Image();
    image.src = url;
    await image.decode();
    return new Minimap(canvas, image, extent);
  }

  /** `heading` in degrees clockwise from north. */
  draw(east: number, north: number, heading: number): void {
    const { canvas, ctx, image, extent } = this;
    const dpr = window.devicePixelRatio || 1;
    const size = Math.round(canvas.clientWidth * dpr);
    // Skip the redraw unless something visible changed (sub-pixel moves don't count).
    const span = MINIMAP.zoomLevels[this.zoomIndex]!;
    const metresPerPixel = span / size;
    const w = this.waypoint;
    const key = `${w ? `${w.east},${w.north}:` : ''}${Math.round(east / metresPerPixel)},${Math.round(north / metresPerPixel)},${Math.round(heading)},${span},${size}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    if (canvas.width !== size || canvas.height !== size) {
      canvas.width = size;
      canvas.height = size;
    }

    // Image pixels per metre (the image exactly covers `extent`).
    const ix = image.naturalWidth / (extent.east - extent.west);
    const iy = image.naturalHeight / (extent.north - extent.south);

    ctx.fillStyle = '#2b3442';
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
      image,
      (east - span / 2 - extent.west) * ix,
      (extent.north - (north + span / 2)) * iy,
      span * ix,
      span * iy,
      0,
      0,
      size,
      size,
    );

    const c = size / 2;
    const scale = size / span;
    for (const r of this.restaurants) {
      const x = c + (r.east - east) * scale;
      const y = c - (r.north - north) * scale;
      if (x < -10 || y < -10 || x > size + 10 || y > size + 10) continue;
      drawRestaurantIcon(ctx, x, y, 6.5 * dpr);
    }
    if (w) {
      // The guide marker, pinned to the edge when it's off the map.
      let x = (w.east - east) * scale;
      let y = -(w.north - north) * scale;
      const edge = c - 9 * dpr;
      const k = Math.max(Math.abs(x), Math.abs(y)) / edge;
      if (k > 1) {
        x /= k;
        y /= k;
      }
      ctx.fillStyle = '#ff8a1f';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.arc(c + x, c + y, 6 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate((heading * Math.PI) / 180);
    // View cone
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, size * 0.28, -Math.PI / 2 - 0.6, -Math.PI / 2 + 0.6);
    ctx.closePath();
    ctx.fill();
    // Player arrow
    const a = 9 * dpr;
    ctx.fillStyle = '#e8402f';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(0, -a);
    ctx.lineTo(a * 0.7, a * 0.8);
    ctx.lineTo(0, a * 0.35);
    ctx.lineTo(-a * 0.7, a * 0.8);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    ctx.restore();

    // North marker
    ctx.font = `bold ${12 * dpr}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 3 * dpr;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.strokeText('N', c, 5 * dpr);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('N', c, 5 * dpr);

    const label = span >= 1000 ? `${span / 1000} km` : `${span} m`;
    if (this.scaleLabel.textContent !== label) this.scaleLabel.textContent = label;
  }

  dispose(): void {
    document.removeEventListener('keydown', this.onKeyDown);
  }

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (e.code === 'Equal' || e.code === 'NumpadAdd') {
      this.zoomIndex = Math.max(this.zoomIndex - 1, 0);
    } else if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
      this.zoomIndex = Math.min(this.zoomIndex + 1, MINIMAP.zoomLevels.length - 1);
    }
  };
}
