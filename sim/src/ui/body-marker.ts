import type { PerspectiveCamera, Vector3 } from 'three/webgpu';
import { Vector3 as V3 } from 'three/webgpu';

import { formatDistance, placeOnScreen } from '../nav/waypoint';

/** Keep the tag this far inside the screen edge when your skier is out of view (px). */
const EDGE = 40;

/**
 * Out of body (fly mode): a tag over the skier you left behind, "Your skier · 840 m",
 * pinned to the screen edge in its direction when it's out of view, so you can always
 * find your way back.
 */
export class BodyMarker {
  private readonly el: HTMLElement;
  private readonly text: HTMLElement;
  private readonly view = new V3();

  constructor(private readonly root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'label label-body';
    this.el.dataset.icon = 'skier';
    this.el.hidden = true;
    this.el.innerHTML = '<span class="label-name"></span>';
    this.text = this.el.querySelector('.label-name')!;
    root.append(this.el);
  }

  /** Show the tag over `head` (world), seen from `from`; null hides it. */
  update(camera: PerspectiveCamera, head: Vector3 | null, from: Vector3): void {
    this.el.hidden = !head;
    if (!head) return;
    const text = `Your skier · ${formatDistance(head.distanceTo(from))}`;
    if (this.text.textContent !== text) this.text.textContent = text;
    this.view.copy(head).applyMatrix4(camera.matrixWorldInverse);
    const w = this.root.clientWidth || window.innerWidth;
    const h = this.root.clientHeight || window.innerHeight;
    const p = placeOnScreen(this.view, camera.fov, camera.aspect, w, h, EDGE);
    this.el.classList.toggle('offscreen', !p.onScreen);
    // Anchored at the tag's bottom centre, like the other labels.
    this.el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -100%)`;
  }
}
