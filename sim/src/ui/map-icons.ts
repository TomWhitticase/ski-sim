import type { Border } from '../features/types';

/** Restaurant colour, shared with the in-world labels (style.css .label-restaurant). */
export const RESTAURANT_COLOUR = '#963e1a';

/**
 * A restaurant badge for the 2D maps: a round marker with a white knife and fork,
 * centred on (x, y), `r` pixels in radius.
 */
export function drawRestaurantIcon(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = RESTAURANT_COLOUR;
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, r * 0.18);
  ctx.strokeStyle = '#fff';
  ctx.stroke();

  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  ctx.lineCap = 'round';
  const top = y - r * 0.55;
  const bottom = y + r * 0.58;
  const line = Math.max(1, r * 0.13);
  // Fork (left): three tines over a short neck, then the handle.
  const fx = x - r * 0.3;
  ctx.lineWidth = line * 0.8;
  for (const dx of [-0.17, 0, 0.17]) {
    ctx.beginPath();
    ctx.moveTo(fx + dx * r, top);
    ctx.lineTo(fx + dx * r, top + r * 0.32);
    ctx.stroke();
  }
  ctx.lineWidth = line;
  ctx.beginPath();
  ctx.moveTo(fx - r * 0.17, top + r * 0.32);
  ctx.quadraticCurveTo(fx, top + r * 0.55, fx + r * 0.17, top + r * 0.32);
  ctx.moveTo(fx, top + r * 0.45);
  ctx.lineTo(fx, bottom);
  ctx.stroke();
  // Knife (right): a blade rounded on its back edge, then the handle.
  const kx = x + r * 0.3;
  ctx.beginPath();
  ctx.moveTo(kx - r * 0.06, top);
  ctx.quadraticCurveTo(kx + r * 0.26, top + r * 0.2, kx + r * 0.12, top + r * 0.62);
  ctx.lineTo(kx - r * 0.06, top + r * 0.62);
  ctx.closePath();
  ctx.fill();
  ctx.lineWidth = line;
  ctx.beginPath();
  ctx.moveTo(kx, top + r * 0.55);
  ctx.lineTo(kx, bottom);
  ctx.stroke();
  ctx.restore();
}

/**
 * National borders for the 2D maps: a purple dash-dot line over a soft white halo, the
 * usual atlas style. `toScreen` maps local (east, north) to canvas pixels; `scale` is
 * the device pixel ratio the canvas is drawn at.
 */
export function drawBorders(
  ctx: CanvasRenderingContext2D,
  borders: Border[],
  toScreen: (east: number, north: number) => [number, number],
  scale: number,
): void {
  if (!borders.length) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const border of borders) {
    ctx.beginPath();
    border.line.forEach(([e, n], i) => {
      const [x, y] = toScreen(e, n);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.setLineDash([]);
    ctx.lineWidth = 5 * scale;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.stroke();
    ctx.setLineDash([9 * scale, 4 * scale, 2 * scale, 4 * scale]);
    ctx.lineWidth = 2 * scale;
    ctx.strokeStyle = '#862e9c';
    ctx.stroke();
  }
  ctx.restore();
}
