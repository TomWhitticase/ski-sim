/**
 * On-mountain signposts from the pipeline's `signposts.json`
 * (pipeline/src/ski_sim_pipeline/signposts.py). Variants, picked with
 * `?signs=hybrid|fingerpost|board|marker|off` (default hybrid: boards at lift tops,
 * fingerposts at junctions); `?signstyle=eu|na` picks the difficulty symbols.
 *
 * Fingerpost blades and marker plates take their run's piste colour (green/blue/red/black,
 * plus the off-piste and type colours), with the ink chosen by contrast so the text reads on
 * every one. Lift blades stay dark slate.
 *
 * Everything is instanced: one mesh of posts, one of blade/board bodies and one of text
 * faces reading a single canvas atlas through a per-instance UV rectangle, so the whole
 * resort's signs are three draw calls whatever their number.
 */
import { instancedBufferAttribute, mix, texture, uv, vec2 } from 'three/tsl';
import {
  BoxGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearMipmapLinearFilter,
  Matrix4,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  type Camera,
} from 'three/webgpu';

import {
  type Blade,
  bladeColour,
  bladeSide,
  bladeSub,
  bladeTitle,
  hudArrow,
  inkFor,
  naShape,
  quantiseArrow,
} from './layout';

export type { Blade } from './layout';

export interface SignSite {
  id: number;
  kind: 'lift-top' | 'junction' | 'lift-bottom';
  east: number;
  north: number;
  ground: number;
  /** Compass bearing the sign's face looks toward (at arriving skiers). */
  facing: number;
  approach: number;
  lift: string | null;
  blades: Blade[];
}

export type Variant = 'hybrid' | 'fingerpost' | 'board' | 'marker' | 'off';
type Style = 'eu' | 'na';

const MAX_ATLAS = 8192;
const ATLAS_W = 4096;

/** Shelf-packed canvas atlas: add() queues a cell, pack() sizes the canvas and draws. */
class Atlas {
  readonly canvas = document.createElement('canvas');
  private readonly cells: {
    w: number;
    h: number;
    draw: (ctx: CanvasRenderingContext2D) => void;
    x: number;
    y: number;
  }[] = [];

  add(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): number {
    this.cells.push({ w, h, draw, x: 0, y: 0 });
    return this.cells.length - 1;
  }

  /** Lays the cells out on shelves, then scales everything down if it would pass 8192 px. */
  pack(): CanvasTexture {
    let x = 0;
    let y = 0;
    let shelf = 0;
    for (const c of this.cells) {
      if (x + c.w > ATLAS_W) {
        x = 0;
        y += shelf;
        shelf = 0;
      }
      c.x = x;
      c.y = y;
      x += c.w;
      shelf = Math.max(shelf, c.h);
    }
    const height = Math.max(1, y + shelf);
    const scale = Math.min(1, MAX_ATLAS / height);
    this.canvas.width = Math.floor(ATLAS_W * scale);
    this.canvas.height = Math.ceil(height * scale);
    this.scale = scale;
    const ctx = this.canvas.getContext('2d')!;
    ctx.scale(scale, scale);
    for (const c of this.cells) {
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.beginPath();
      ctx.rect(0, 0, c.w, c.h);
      ctx.clip();
      c.draw(ctx);
      ctx.restore();
    }
    const t = new CanvasTexture(this.canvas);
    t.colorSpace = SRGBColorSpace;
    t.minFilter = LinearMipmapLinearFilter;
    t.anisotropy = 8;
    return t;
  }

  private scale = 1;

  /** [u0, vBottom, u1, vTop] for CanvasTexture's default flipY (after pack()). */
  uv(i: number): [number, number, number, number] {
    const r = this.cells[i]!;
    const W = ATLAS_W;
    const H = this.canvas.height / this.scale;
    return [r.x / W, 1 - (r.y + r.h) / H, (r.x + r.w) / W, 1 - r.y / H];
  }
}

const FONT = "'Geist', system-ui, sans-serif";
const MONO = "'Geist Mono', ui-monospace, monospace";

/**
 * The leading badge on a blade or board row: a lift pictogram, a North-American difficulty
 * shape, or (EU) the run number in a pill. Drawn in `ink` on the blade's own colour, so it
 * reads without a separate colour swatch — the blade background already is the colour.
 */
function drawBadge(
  ctx: CanvasRenderingContext2D,
  b: Blade,
  x: number,
  y: number,
  s: number,
  ink: string,
  style: Style,
) {
  ctx.save();
  const cx = x + s / 2;
  const cy = y + s / 2;
  if (b.kind === 'lift') {
    // Chair on a rope.
    ctx.strokeStyle = ink;
    ctx.lineWidth = s * 0.09;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x + s * 0.12, y + s * 0.26);
    ctx.lineTo(x + s * 0.88, y + s * 0.12);
    ctx.moveTo(cx, y + s * 0.19);
    ctx.lineTo(cx, y + s * 0.5);
    ctx.stroke();
    ctx.fillStyle = ink;
    ctx.fillRect(x + s * 0.26, y + s * 0.5, s * 0.48, s * 0.3);
    ctx.restore();
    return;
  }
  const shape = style === 'na' ? naShape(b) : null;
  if (shape) {
    ctx.fillStyle = ink;
    ctx.beginPath();
    if (shape === 'circle') ctx.arc(cx, cy, s * 0.36, 0, Math.PI * 2);
    else if (shape === 'square') ctx.rect(cx - s * 0.32, cy - s * 0.32, s * 0.64, s * 0.64);
    else {
      const diamond = (dx: number, r: number) => {
        ctx.moveTo(dx, cy - r);
        ctx.lineTo(dx + r, cy);
        ctx.lineTo(dx, cy + r);
        ctx.lineTo(dx - r, cy);
        ctx.closePath();
      };
      if (shape === 'double-diamond') {
        diamond(cx - s * 0.2, s * 0.24);
        diamond(cx + s * 0.2, s * 0.24);
      } else diamond(cx, s * 0.4);
    }
    ctx.fill();
    ctx.restore();
    return;
  }
  if (b.ref) {
    // The run number in an ink pill, the blade's colour showing through.
    const colour = bladeColour(b);
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.roundRect(x, y + s * 0.08, s, s * 0.84, s * 0.22);
    ctx.fill();
    ctx.fillStyle = colour;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let size = s * 0.58;
    ctx.font = `800 ${size}px ${MONO}`;
    while (ctx.measureText(b.ref).width > s * 0.82 && size > 12) {
      size -= 2;
      ctx.font = `800 ${size}px ${MONO}`;
    }
    ctx.fillText(b.ref, cx, cy + s * 0.02);
  }
  ctx.restore();
}

/** True when a blade has a leading badge (lift, NA shape, or a run number). */
function hasBadge(b: Blade, style: Style): boolean {
  return b.kind === 'lift' || !!naShape(b) || (style === 'eu' && !!b.ref);
}

/** Arrow glyph pointing `rel` degrees from straight ahead (quantised to 45°). */
function drawArrow(
  ctx: CanvasRenderingContext2D,
  rel: number,
  cx: number,
  cy: number,
  s: number,
  colour: string,
) {
  const q = quantiseArrow(rel);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((q * Math.PI) / 180);
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.moveTo(0, -s * 0.5);
  ctx.lineTo(s * 0.42, -s * 0.05);
  ctx.lineTo(s * 0.15, -s * 0.05);
  ctx.lineTo(s * 0.15, s * 0.5);
  ctx.lineTo(-s * 0.15, s * 0.5);
  ctx.lineTo(-s * 0.15, -s * 0.05);
  ctx.lineTo(-s * 0.42, -s * 0.05);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  weight: number,
  size: number,
  max: number,
  family = FONT,
) {
  ctx.font = `${weight} ${size}px ${family}`;
  while (ctx.measureText(text).width > max && size > 14) {
    size -= 2;
    ctx.font = `${weight} ${size}px ${family}`;
  }
  return size;
}

/**
 * One fingerpost blade: arrow-shaped (pointing left/right) or a flat plate (ahead), the
 * whole blade in its run's colour with the text in a contrasting ink.
 */
const BLADE = { w: 1024, h: 176, metresW: 1.9 };
function drawBlade(ctx: CanvasRenderingContext2D, b: Blade, side: -1 | 0 | 1, style: Style) {
  const { w, h } = BLADE;
  const tip = side === 0 ? 0 : h * 0.5;
  const colour = bladeColour(b);
  const ink = inkFor(colour);
  ctx.fillStyle = colour;
  ctx.beginPath();
  if (side === 1) {
    ctx.moveTo(0, 0);
    ctx.lineTo(w - tip, 0);
    ctx.lineTo(w, h / 2);
    ctx.lineTo(w - tip, h);
    ctx.lineTo(0, h);
  } else if (side === -1) {
    ctx.moveTo(w, 0);
    ctx.lineTo(tip, 0);
    ctx.lineTo(0, h / 2);
    ctx.lineTo(tip, h);
    ctx.lineTo(w, h);
  } else ctx.rect(0, 0, w, h);
  ctx.closePath();
  ctx.fill();
  // A thin edge in the ink colour, so dark-on-dark and light-on-light blades still read.
  ctx.lineWidth = 10;
  ctx.strokeStyle = ink === '#f7f8fa' ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.5)';
  ctx.stroke();

  const pad = 22;
  const s = h - pad * 2;
  const x0 = side === -1 ? tip + 10 : pad;
  const x1 = side === 1 ? w - tip - 10 : w - pad;
  let tx = x0;
  if (hasBadge(b, style)) {
    drawBadge(ctx, b, x0, pad, s, ink, style);
    tx = x0 + s + 24;
  }
  if (side === 0) {
    drawArrow(ctx, b.rel, x1 - s / 2, h / 2, s * 0.9, ink);
  }
  const right = side === 0 ? x1 - s - 16 : x1;
  ctx.fillStyle = ink;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const title = bladeTitle(b);
  const sub = bladeSub(b);
  fitText(ctx, title, 750, sub ? 64 : 76, right - tx);
  ctx.fillText(title, tx, sub ? h * 0.38 : h * 0.52);
  if (sub) {
    fitText(ctx, sub, 500, 40, right - tx);
    ctx.globalAlpha = 0.78;
    ctx.fillText(sub, tx, h * 0.76);
    ctx.globalAlpha = 1;
  }
}

/** A lift-top / junction board: one row per way out, arrow + badge + name + destination. */
const ROW_H = 150;
function boardSize(site: SignSite) {
  return { w: 1024, h: 150 + ROW_H * site.blades.length + 20 };
}
function drawBoard(ctx: CanvasRenderingContext2D, site: SignSite, style: Style) {
  const { w, h } = boardSize(site);
  ctx.fillStyle = '#0b3d91';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 8;
  ctx.strokeRect(12, 12, w - 24, h - 24);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const head = site.lift
    ? `${site.lift} · top`
    : site.kind === 'lift-bottom'
      ? 'Lifts & runs'
      : 'Runs';
  fitText(ctx, head.toUpperCase(), 800, 64, w - 80);
  ctx.fillText(head.toUpperCase(), 40, 84);
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillRect(40, 140, w - 80, 4);
  site.blades.forEach((b, i) => {
    const y = 150 + i * ROW_H;
    // Each row is its run's colour, with the text and badge in the contrasting ink.
    const colour = bladeColour(b);
    const ink = inkFor(colour);
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.roundRect(40, y + 14, w - 80, ROW_H - 22, 14);
    ctx.fill();
    drawArrow(ctx, b.rel, 40 + 66, y + ROW_H / 2 + 4, 92, ink);
    const s = ROW_H - 52;
    let tx = 150;
    if (hasBadge(b, style)) {
      drawBadge(ctx, b, 150, y + 30, s, ink, style);
      tx = 150 + s + 24;
    }
    ctx.fillStyle = ink;
    ctx.textAlign = 'left';
    const title = bladeTitle(b);
    const sub = bladeSub(b);
    fitText(ctx, title, 750, sub ? 58 : 66, w - 60 - tx);
    ctx.fillText(title, tx, y + (sub ? 64 : 82));
    if (sub) {
      fitText(ctx, sub, 500, 38, w - 60 - tx);
      ctx.globalAlpha = 0.8;
      ctx.fillText(sub, tx, y + 112);
      ctx.globalAlpha = 1;
    }
  });
}

/** Minimal marker plate: the run colour with its number and a small arrow, no words. */
const PLATE = { w: 256, h: 256 };
function drawPlate(ctx: CanvasRenderingContext2D, b: Blade, style: Style) {
  const colour = bladeColour(b);
  const ink = inkFor(colour);
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.roundRect(4, 4, PLATE.w - 8, PLATE.h - 8, 28);
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = ink === '#f7f8fa' ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.45)';
  ctx.stroke();
  const label = b.kind === 'lift' ? 'LIFT' : (b.ref ?? '');
  const shape = style === 'na' ? naShape(b) : null;
  if (shape || b.kind === 'lift') {
    drawBadge(ctx, b, 53, 30, 150, ink, style);
  } else if (label) {
    ctx.fillStyle = ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let size = 150;
    ctx.font = `800 ${size}px ${MONO}`;
    while (ctx.measureText(label).width > 180 && size > 40) {
      size -= 6;
      ctx.font = `800 ${size}px ${MONO}`;
    }
    ctx.fillText(label, 118, 118);
  }
  drawArrow(ctx, b.rel, PLATE.w - 46, PLATE.h - 46, 60, ink);
}

const Y = new Vector3(0, 1, 0);
function dirOf(bearing: number): Vector3 {
  const r = (bearing * Math.PI) / 180;
  return new Vector3(Math.sin(r), 0, -Math.cos(r));
}

export interface Signposts {
  root: Group;
  sites: SignSite[];
  variant: Variant;
  stats: { sites: number; faces: number; posts: number; bodies: number; atlas: [number, number] };
  update(camera: Camera): void;
  /** Hide/show the HUD readout (driven by the Display "Sign readout" toggle). */
  setHintEnabled(on: boolean): void;
  dispose(): void;
}

/** How far in front of a sign's plane its post stands (m); the post is always behind. */
const POST_BACK = 0.08;
const POST_R = 0.05;

/**
 * Builds the signs. `ground(east, north)` is the snow height (the terrain may have been
 * graded since the pipeline sampled it).
 */
export async function createSignposts(
  sites: SignSite[],
  ground: (east: number, north: number) => number,
  variant: Variant,
  style: Style,
): Promise<Signposts> {
  const root = new Group();
  root.name = 'signposts';
  await document.fonts?.load(`700 40px Geist`).catch(() => undefined);
  await document.fonts?.load(`700 40px 'Geist Mono'`).catch(() => undefined);

  const atlas = new Atlas();
  const faces: { m: Matrix4; cell: number }[] = [];
  const bodies: { m: Matrix4; colour: number }[] = [];
  const posts: Matrix4[] = [];
  const q = new Quaternion();
  const Z = new Vector3(0, 0, 1);
  const compose = (pos: Vector3, facing: Vector3, sx: number, sy: number, sz = 1) =>
    new Matrix4().compose(pos, q.setFromUnitVectors(Z, facing).clone(), new Vector3(sx, sy, sz));
  // A vertical post standing from the ground up to `top` m, pushed `back` m along −face.
  const standPost = (base: Vector3, face: Vector3, top: number, back: number) =>
    new Matrix4().compose(
      base
        .clone()
        .addScaledVector(face, -back)
        .setY(base.y - 0.4 + (top + 0.4) / 2),
      new Quaternion(),
      new Vector3(1, top + 0.4, 1),
    );

  for (const site of variant === 'off' ? [] : sites) {
    const base = new Vector3(site.east, ground(site.east, site.north), -site.north);
    const face = dirOf(site.facing); // toward arriving skiers
    const right = new Vector3().crossVectors(face, Y).normalize().negate(); // skier's right
    const kind: Variant =
      variant === 'hybrid' ? (site.kind === 'lift-top' ? 'board' : 'fingerpost') : variant;

    if (kind === 'board') {
      const { w, h } = boardSize(site);
      const cell = atlas.add(w, h, (ctx) => drawBoard(ctx, site, style));
      const W = 2.8;
      const H = (W * h) / w;
      const bottom = 1.1;
      const centre = base.clone().setY(base.y + bottom + H / 2);
      bodies.push({
        m: compose(centre.clone().addScaledVector(face, -0.04), face, W + 0.08, H + 0.08, 0.06),
        colour: 0x2a2e35,
      });
      faces.push({ m: compose(centre.clone().addScaledVector(face, 0.04), face, W, H), cell });
      for (const s of [-1, 1]) {
        const foot = base
          .clone()
          .addScaledVector(right, (s * W) / 2.3)
          .addScaledVector(face, -0.12);
        const top = bottom + H + 0.1;
        posts.push(
          new Matrix4().compose(
            foot.setY(base.y - 0.4 + (top + 0.4) / 2),
            new Quaternion(),
            new Vector3(1, top + 0.4, 1),
          ),
        );
      }
    } else if (kind === 'fingerpost') {
      const n = site.blades.length;
      const bh = (1.9 * 176) / 1024;
      const gap = 0.07;
      const topY = 1.0 + n * (bh + gap);
      posts.push(standPost(base, face, topY + 0.6, POST_BACK));
      site.blades.forEach((b, i) => {
        const side = bladeSide(b.rel);
        const cell = atlas.add(BLADE.w, BLADE.h, (ctx) => drawBlade(ctx, b, side, style));
        const W = BLADE.metresW;
        const H = (W * BLADE.h) / BLADE.w;
        const y = base.y + topY - i * (bh + gap) - H / 2;
        // Arms stick out to their side of the post; "ahead" plates sit centred on it.
        const offset = side * (W / 2 + 0.05);
        const centre = base.clone().setY(y).addScaledVector(right, offset);
        // Thin backing plate (behind the face) with a dark edge, then the face in front.
        bodies.push({
          m: compose(
            centre.clone().addScaledVector(face, -0.015),
            face,
            W * (side ? 0.9 : 1),
            H * 0.94,
            0.05,
          ),
          colour: 0x23262c,
        });
        faces.push({ m: compose(centre.clone().addScaledVector(face, 0.045), face, W, H), cell });
      });
    } else if (kind === 'marker') {
      // Numbered plates stacked up one post: each on its own backing panel, the post behind.
      const n = site.blades.length;
      const P = 0.46;
      const gap = 0.07;
      const topY = 1.3 + n * (P + gap);
      posts.push(standPost(base, face, topY + 0.3, POST_BACK + 0.02));
      site.blades.forEach((b, i) => {
        const cell = atlas.add(PLATE.w, PLATE.h, (ctx) => drawPlate(ctx, b, style));
        const centre = base.clone().setY(base.y + topY - i * (P + gap) - P / 2);
        bodies.push({
          m: compose(centre.clone().addScaledVector(face, 0.0), face, P + 0.06, P + 0.06, 0.06),
          colour: 0x23262c,
        });
        faces.push({ m: compose(centre.clone().addScaledVector(face, 0.05), face, P, P), cell });
      });
    }
  }

  // Debug beacons (?signdebug=1): a 30 m mast and ball over every sign, coloured by kind,
  // to judge placement and density from the air.
  if (new URLSearchParams(location.search).get('signdebug') === '1') {
    const KIND = { 'lift-top': 0x7c3aed, junction: 0xea580c, 'lift-bottom': 0x0891b2 } as const;
    const mast = new InstancedMesh(
      new CylinderGeometry(1.4, 1.4, 1, 6),
      new MeshBasicNodeMaterial({ color: 0xffffff }),
      sites.length,
    );
    const ball = new InstancedMesh(
      new SphereGeometry(9, 12, 8),
      new MeshBasicNodeMaterial(),
      sites.length,
    );
    const c = new Color();
    sites.forEach((site, i) => {
      const y = ground(site.east, site.north);
      mast.setMatrixAt(
        i,
        new Matrix4().compose(
          new Vector3(site.east, y + 35, -site.north),
          new Quaternion(),
          new Vector3(1, 70, 1),
        ),
      );
      ball.setMatrixAt(i, new Matrix4().makeTranslation(site.east, y + 76, -site.north));
      mast.setColorAt(i, c.set(KIND[site.kind]));
      ball.setColorAt(i, c.set(KIND[site.kind]));
    });
    mast.computeBoundingSphere();
    ball.computeBoundingSphere();
    root.add(mast, ball);
  }

  const texture_ = atlas.pack();
  if (faces.length) {
    const rects = new InstancedBufferAttribute(
      new Float32Array(faces.flatMap((f) => atlas.uv(f.cell))),
      4,
    );
    const r = instancedBufferAttribute<'vec4'>(rects, 'vec4');
    const material = new MeshBasicNodeMaterial({ transparent: false });
    const sample = texture(texture_, vec2(mix(r.x, r.z, uv().x), mix(r.y, r.w, uv().y)));
    material.colorNode = sample;
    material.opacityNode = sample.a;
    material.alphaTest = 0.5;
    const mesh = new InstancedMesh(new PlaneGeometry(1, 1), material, faces.length);
    faces.forEach((f, i) => mesh.setMatrixAt(i, f.m));
    mesh.computeBoundingSphere();
    mesh.name = 'signpost-faces';
    root.add(mesh);
  }
  if (bodies.length) {
    const mesh = new InstancedMesh(
      new BoxGeometry(1, 1, 1),
      new MeshStandardNodeMaterial({ roughness: 0.7, metalness: 0.2 }),
      bodies.length,
    );
    const c = new Color();
    bodies.forEach((b, i) => {
      mesh.setMatrixAt(i, b.m);
      mesh.setColorAt(i, c.set(b.colour));
    });
    mesh.castShadow = true;
    mesh.computeBoundingSphere();
    mesh.name = 'signpost-bodies';
    root.add(mesh);
  }
  if (posts.length) {
    const mesh = new InstancedMesh(
      new CylinderGeometry(POST_R, POST_R + 0.01, 1, 8),
      new MeshStandardNodeMaterial({ color: 0x5b6068, metalness: 0.6, roughness: 0.45 }),
      posts.length,
    );
    posts.forEach((p, i) => mesh.setMatrixAt(i, p));
    mesh.castShadow = true;
    mesh.computeBoundingSphere();
    mesh.name = 'signpost-posts';
    root.add(mesh);
  }

  // HUD hint: the nearest sign ahead within 45 m, read out as text (accessibility, phones).
  const hint = document.createElement('div');
  hint.id = 'signpost-hint';
  hint.className = 'glass glass-dark';
  hint.hidden = true;
  document.querySelector('#hud')?.appendChild(hint);
  let shown = -1;
  let enabled = new URLSearchParams(location.search).get('signhint') !== '0';
  const camDir = new Vector3();
  const update = (camera: Camera) => {
    if (variant === 'off' || !enabled) {
      if (!hint.hidden) {
        hint.hidden = true;
        shown = -1;
      }
      return;
    }
    camera.getWorldDirection(camDir);
    let best: SignSite | null = null;
    let bestD = 45;
    for (const s of sites) {
      const dx = s.east - camera.position.x;
      const dz = -s.north - camera.position.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < bestD && (dx * camDir.x + dz * camDir.z) / Math.max(d, 1e-3) > 0.5) {
        best = s;
        bestD = d;
      }
    }
    const id = best ? best.id : -1;
    if (id === shown) return;
    shown = id;
    if (!best) {
      hint.hidden = true;
      return;
    }
    const rows = best.blades
      .map((b) => {
        const chip = `<span class="sh-chip" style="background:${bladeColour(b)};color:${inkFor(bladeColour(b))}">${b.kind === 'lift' ? '⛡' : (b.ref ?? '&nbsp;')}</span>`;
        const to = b.kind === 'piste' && b.to ? ` <span class="sh-to">→ ${b.to}</span>` : '';
        return `<div class="sh-row"><span class="sh-arrow">${hudArrow(b.rel)}</span>${chip}<span class="sh-name">${bladeTitle(b)}</span>${to}</div>`;
      })
      .join('');
    const head = best.lift
      ? `${best.lift} · top`
      : best.kind === 'lift-bottom'
        ? 'Lifts and runs'
        : 'Junction';
    hint.innerHTML = `<div class="sh-head">SIGN · ${head.toUpperCase()}</div>${rows}`;
    hint.hidden = false;
  };

  return {
    root,
    sites,
    variant,
    stats: {
      sites: sites.length,
      faces: faces.length,
      posts: posts.length,
      bodies: bodies.length,
      atlas: [atlas.canvas.width, atlas.canvas.height],
    },
    update,
    setHintEnabled(on: boolean) {
      enabled = on;
      if (!on) {
        hint.hidden = true;
        shown = -1;
      }
    },
    dispose() {
      hint.remove();
      root.removeFromParent();
    },
  };
}

/** Load `signposts.json` beside the resort's other files (absent: no signs). */
export async function loadSignposts(url: string): Promise<SignSite[] | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return ((await res.json()) as { sites: SignSite[] }).sites;
  } catch {
    return null;
  }
}
