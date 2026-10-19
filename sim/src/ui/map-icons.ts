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
