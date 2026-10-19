import {
  CylinderGeometry,
  Mesh,
  MeshBasicMaterial,
  type PerspectiveCamera,
  type Scene,
  Vector3,
} from 'three';
import { formatDistance, placeOnScreen, type Waypoint } from '../nav/waypoint';

const BEAM_HEIGHT = 400;
const COLOUR = 0xff8a1f;
/** Keep the edge marker this far in from the screen border (px). */
const EDGE = 80;

/**
 * The map marker in the world: a tall light beam at the spot, plus a pin with the distance
 * and height difference that stays on screen (pinned to the edge, pointing the way) when
 * the spot is out of view.
 */
export class WaypointMarker {
  private readonly beam: Mesh;
  private readonly el: HTMLElement;
  private readonly info: HTMLElement;
  private readonly arrow: HTMLElement;
  private readonly anchor = new Vector3();
  private readonly view = new Vector3();
  private waypoint: Waypoint | null = null;
  private ground = 0;

  constructor(
    scene: Scene,
    private readonly root: HTMLElement,
    private readonly groundHeight: (x: number, z: number) => number,
  ) {
    const geometry = new CylinderGeometry(1.4, 1.4, BEAM_HEIGHT, 12, 1, true);
    geometry.translate(0, BEAM_HEIGHT / 2, 0);
    this.beam = new Mesh(
      geometry,
      new MeshBasicMaterial({
        color: COLOUR,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
        fog: false,
      }),
    );
    this.beam.visible = false;
    this.beam.frustumCulled = false;
    scene.add(this.beam);

    this.el = document.createElement('div');
    this.el.id = 'waypoint';
    this.el.hidden = true;
    this.el.innerHTML =
      '<div class="waypoint-arrow"></div><div class="waypoint-pin"></div><span class="waypoint-info"></span>';
    this.info = this.el.querySelector('.waypoint-info')!;
    this.arrow = this.el.querySelector('.waypoint-arrow')!;
    root.append(this.el);
  }

  get current(): Waypoint | null {
    return this.waypoint;
  }

  set(w: Waypoint | null): void {
    this.waypoint = w;
    this.beam.visible = !!w;
    this.el.hidden = !w;
    if (!w) return;
    this.ground = this.groundHeight(w.east, -w.north);
    this.beam.position.set(w.east, this.ground, -w.north);
    this.anchor.set(w.east, this.ground + 3, -w.north);
  }

  update(camera: PerspectiveCamera, from: Vector3): void {
    const w = this.waypoint;
    if (!w) return;
    const distance = Math.hypot(w.east - from.x, -w.north - from.z);
    // A few pixels wide at any distance (1.4 m up close).
    const width = Math.max(1, distance / 250);
    this.beam.scale.set(width, 1, width);
    const climb = Math.round(this.ground - from.y);
    const height = Math.abs(climb) < 10 ? '' : ` · ${climb > 0 ? '▲' : '▼'} ${Math.abs(climb)} m`;
    const text = `${formatDistance(distance)}${height}`;
    if (this.info.textContent !== text) this.info.textContent = text;

    this.view.copy(this.anchor).applyMatrix4(camera.matrixWorldInverse);
    const w2 = this.root.clientWidth || window.innerWidth;
    const h = this.root.clientHeight || window.innerHeight;
    const p = placeOnScreen(this.view, camera.fov, camera.aspect, w2, h, EDGE);
    this.el.classList.toggle('offscreen', !p.onScreen);
    this.el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
    if (!p.onScreen) this.arrow.style.transform = `rotate(${p.angle.toFixed(3)}rad)`;
  }
}
