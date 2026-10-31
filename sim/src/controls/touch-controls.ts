import { type Input } from './input';
import {
  type InputKind,
  nextKind,
  stickKnob,
  stickKeys,
  stickVector,
  stopSide,
  TOUCH_LOOK_GAIN,
  type TouchMode,
} from './touch-input';

/** What the context buttons need to know each frame. */
export interface TouchState {
  mode: TouchMode;
  /** Skiing in the air (flip buttons instead of tuck and stop). */
  airborne: boolean;
  /** Riding a snowboard (Jump becomes Ollie; no ski-only nuances). */
  snowboard?: boolean;
  tucked: boolean;
  /** Riding a lift that may be fast-forwarded (not in a multiplayer game). */
  fastForward: boolean;
  /** Any of the lift, peak and restaurant names are showing. */
  names: boolean;
  /** Piste colours are on the snow. */
  pistes: boolean;
  /** In a plane or helicopter off the ground (you can jump out). */
  flying?: boolean;
  /** Skydiving under an open canopy. */
  canopy?: boolean;
}

export interface TouchActions {
  /** Do what a key does in game (`main.ts`): KeyM map, KeyF drone, KeyE ride... */
  key: (code: string) => void;
  /** Lift, peak and restaurant names on or off together. */
  labels: () => void;
}

interface ButtonSpec {
  id: string;
  label: string;
  icon: string;
  /** Shown when this is true. */
  when: (s: TouchState) => boolean;
  /** Held like a key while pressed... */
  hold?: string;
  /** ...or does something on each press (repeating while held if `repeat`). */
  press?: () => void;
  repeat?: boolean;
  big?: boolean;
  /** Lit while this is true (a toggle that's on). */
  on?: (s: TouchState) => boolean;
}

/** Line icons (24 px, stroked), in the style of the world labels' icons. */
const svg = (d: string) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  pause: svg('<path d="M9 5v14M15 5v14"/>'),
  map: svg('<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/>'),
  // A quadcopter from above: four props on an X.
  fly: svg(
    '<path d="M8.5 8.5l7 7M15.5 8.5l-7 7"/><rect x="10" y="10" width="4" height="4" rx="1"/>' +
      '<circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/>' +
      '<circle cx="6" cy="18" r="3"/><circle cx="18" cy="18" r="3"/>',
  ),
  glider: svg('<path d="M3 9c3-4 15-4 18 0"/><path d="M4 9l8 10 8-10M12 9v10"/>'),
  sled: svg('<path d="M3 17h13l3-3"/><path d="M5 17l2-5h7l3 2"/><path d="M10 12l1-3h3"/>'),
  view: svg(
    '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  ),
  labels: svg('<path d="M3 12V4h8l10 10-8 8L3 12z"/><circle cx="7.5" cy="8" r="1.5"/>'),
  // Piste colours: mountains with a run winding down them.
  pistes: svg(
    '<path d="M2 20l7-13 4 6 2-3 7 10z"/><path d="M9 7.5c-1.5 2.5 2 3.5.5 6.5S9 18 10 20"/>',
  ),
  fullscreen: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  jump: svg('<path d="M12 20V5"/><path d="M5 12l7-7 7 7"/>'),
  tuck: svg('<path d="M6 7l6 6 6-6"/><path d="M6 13l6 6 6-6"/>'),
  stop: svg('<path d="M5 19L19 5"/><path d="M4 12h6M14 12h6" opacity="0.5"/>'),
  flipFwd: svg('<path d="M20 12a8 8 0 1 1-3-6.2"/><path d="M17 2v4h-4"/>'),
  flipBack: svg('<path d="M4 12a8 8 0 1 0 3-6.2"/><path d="M7 2v4h4"/>'),
  up: svg('<path d="M6 15l6-6 6 6"/>'),
  down: svg('<path d="M6 9l6 6 6-6"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  skip: svg('<path d="M5 5l9 7-9 7z"/><path d="M18 5v14"/>'),
  fast: svg('<path d="M3 5l8 7-8 7z"/><path d="M12 5l8 7-8 7z"/>'),
  off: svg('<path d="M15 4h4v16h-4"/><path d="M10 8l-4 4 4 4M6 12h10"/>'),
  lean: svg('<circle cx="14" cy="5" r="2"/><path d="M13 8l-4 6 5 2-2 5"/><path d="M4 21h16"/>'),
  flaps: svg('<path d="M3 10h12l6 2"/><path d="M15 10l5 6"/>'),
  turnLeft: svg('<path d="M9 7H15a5 5 0 0 1 0 10h-4"/><path d="M12 4L9 7l3 3"/>'),
  turnRight: svg('<path d="M15 7H9a5 5 0 0 0 0 10h4"/><path d="M12 4l3 3-3 3"/>'),
  bail: svg('<circle cx="12" cy="5" r="2"/><path d="M5 10l7 2 7-2M12 12v4l-4 5M12 16l4 5"/>'),
  canopy: svg('<path d="M3 10c3-5 15-5 18 0"/><path d="M3 10l9 9 9-9M8 9l4 10 4-10"/>'),
  brake: svg('<circle cx="12" cy="12" r="8"/><path d="M8 12h8"/>'),
};

/** How often a held +/- steps the fly speed (ms). */
const REPEAT_MS = 140;

/**
 * Touch play: a virtual thumbstick where the left thumb lands (and stays there), look-drag on the right half,
 * and context buttons for the current mode (dark glass, bottom right), plus pause and a row
 * of tools (map, drone, paraglider, snowmobile, view, labels, piste colours, fullscreen).
 * Everything goes through `Input`, as the keyboard does, so the physics is the same.
 *
 * It also decides which controls are in use: touch on a phone or tablet (`body.touch`), and
 * keyboard and mouse from the first real mouse click or key press (`nextKind`), back to
 * touch on the next finger.
 */
export class TouchControls {
  kind: InputKind;
  private readonly pad: HTMLElement;
  private readonly stick: HTMLElement;
  private readonly knob: HTMLElement;
  private readonly buttons: { spec: ButtonSpec; el: HTMLButtonElement }[] = [];
  private stickTouch: { id: number; ox: number; oy: number } | null = null;
  private lookTouch: { id: number; x: number; y: number } | null = null;
  private stopping = false;
  private stateKey = '';

  constructor(
    private readonly root: HTMLElement,
    private readonly input: Input,
    private readonly actions: TouchActions,
    touch: boolean,
  ) {
    this.kind = touch ? 'touch' : 'desktop';
    this.pad = root.querySelector('#touch-pad')!;
    this.stick = root.querySelector('#touch-stick')!;
    this.knob = this.stick.querySelector('i')!;
    this.build();
    this.apply();

    this.pad.addEventListener('pointerdown', this.onDown);
    this.pad.addEventListener('pointermove', this.onMove);
    this.pad.addEventListener('pointerup', this.onUp);
    this.pad.addEventListener('pointercancel', this.onUp);
    // Which controls: watch every press, before anything else handles it.
    window.addEventListener('pointerdown', (e) => this.switchTo(nextKind(this.kind, e)), true);
    window.addEventListener(
      'keydown',
      (e) => {
        const t = e.target;
        const typing =
          t instanceof HTMLTextAreaElement ||
          (t instanceof HTMLInputElement && !['checkbox', 'radio', 'range'].includes(t.type));
        this.switchTo(nextKind(this.kind, { type: 'keydown', typing }));
      },
      true,
    );
    // No long-press menus, callouts or double-tap zoom over the game.
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('dblclick', (e) => this.kind === 'touch' && e.preventDefault());
    // Stopped playing (paused, map, menu): let go of everything held.
    document.addEventListener('pointerlockchange', () => {
      if (!this.input.locked) this.reset();
    });
    // A phone's game pauses when it's put away.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.kind === 'touch' && this.input.locked) this.input.unlock();
    });
    document.addEventListener('fullscreenchange', () => this.markFullscreen());
  }

  /** The mode and what's happening in it; shows the buttons that matter. Every frame. */
  update(state: TouchState): void {
    const key = `${state.mode}|${state.airborne}|${state.tucked}|${state.fastForward}|${state.names}|${state.pistes}|${state.flying}|${state.canopy}`;
    if (key !== this.stateKey) {
      this.stateKey = key;
      for (const { spec, el } of this.buttons) {
        el.hidden = !spec.when(state);
        if (spec.on) el.classList.toggle('on', spec.on(state));
        if (el.hidden && el.classList.contains('down')) this.release(spec, el);
      }
      this.root.dataset.mode = state.mode;
    }
    if (this.kind !== 'touch') return;
    // Stop: a snowplough, or a hockey stop to the side the stick's pushed. While it's
    // held the stick doesn't skate or plough as well.
    const stopping = this.stopping && state.mode === 'ski';
    this.input.hockey = stopping ? stopSide(this.input.hockey, this.input.stickX) : 0;
    this.input.setStickKeys(stopping ? [] : stickKeys(state.mode, this.input.stickY));
    const plough = stopping && this.input.hockey === 0;
    this.input.hold('ShiftLeft', plough || this.heldBy('ShiftLeft'));
  }

  private heldBy(code: string): boolean {
    return this.buttons.some(({ spec, el }) => spec.hold === code && el.classList.contains('down'));
  }

  private switchTo(kind: InputKind): void {
    if (kind === this.kind) return;
    this.kind = kind;
    this.apply();
    // A finger on a tablet whose mouse had captured the pointer: carry on by touch.
    if (kind === 'touch' && document.pointerLockElement) {
      document.exitPointerLock();
      void this.input.lock();
    }
  }

  private apply(): void {
    const touch = this.kind === 'touch';
    this.input.touch = touch;
    document.body.classList.toggle('touch', touch);
    this.reset();
  }

  private build(): void {
    const s = this.input;
    const ski = (st: TouchState) => st.mode === 'ski';
    const specs: ButtonSpec[] = [
      // Context buttons, bottom right (the first is the big one under the thumb).
      {
        id: 'jump',
        label: 'Jump',
        icon: ICONS.jump,
        hold: 'Space',
        big: true,
        when: (st) => ski(st) && !st.airborne && !st.snowboard,
      },
      {
        // On a board the same pop is an ollie (loaded off the tail).
        id: 'ollie',
        label: 'Ollie',
        icon: ICONS.jump,
        hold: 'Space',
        big: true,
        when: (st) => ski(st) && !st.airborne && !!st.snowboard,
      },
      {
        id: 'tuck',
        label: 'Tuck',
        icon: ICONS.tuck,
        press: () => s.tap('ControlLeft'),
        when: (st) => ski(st) && !st.airborne,
        on: (st) => st.tucked,
      },
      { id: 'stop', label: 'Stop', icon: ICONS.stop, when: (st) => ski(st) && !st.airborne },
      {
        id: 'flip-fwd',
        label: 'Front flip',
        icon: ICONS.flipFwd,
        hold: 'BracketLeft',
        big: true,
        when: (st) => ski(st) && st.airborne,
      },
      {
        id: 'flip-back',
        label: 'Backflip',
        icon: ICONS.flipBack,
        hold: 'BracketRight',
        when: (st) => ski(st) && st.airborne,
      },
      {
        id: 'up',
        label: 'Up',
        icon: ICONS.up,
        hold: 'Space',
        big: true,
        when: (st) => st.mode === 'fly',
      },
      {
        id: 'down',
        label: 'Down',
        icon: ICONS.down,
        hold: 'ShiftLeft',
        when: (st) => st.mode === 'fly',
      },
      {
        id: 'faster',
        label: 'Faster',
        icon: ICONS.plus,
        press: () => (s.wheel -= 100),
        repeat: true,
        when: (st) => st.mode === 'fly',
      },
      {
        id: 'slower',
        label: 'Slower',
        icon: ICONS.minus,
        press: () => (s.wheel += 100),
        repeat: true,
        when: (st) => st.mode === 'fly',
      },
      {
        id: 'hang',
        label: 'Hang off',
        icon: ICONS.lean,
        hold: 'ShiftLeft',
        when: (st) => st.mode === 'sled',
      },
      {
        id: 'power-up',
        label: 'Power',
        icon: ICONS.plus,
        hold: 'KeyW',
        big: true,
        when: (st) => st.mode === 'plane',
      },
      {
        id: 'power-down',
        label: 'Less',
        icon: ICONS.minus,
        hold: 'KeyS',
        when: (st) => st.mode === 'plane',
      },
      {
        id: 'flaps',
        label: 'Flaps',
        icon: ICONS.flaps,
        press: () => s.tap('KeyX'),
        when: (st) => st.mode === 'plane',
      },
      {
        id: 'brake',
        label: 'Brake',
        icon: ICONS.brake,
        hold: 'Space',
        when: (st) => st.mode === 'plane',
      },
      // Pedals (the cluster fills from the right, so Right comes first to sit right).
      {
        id: 'turn-right',
        label: 'Right',
        icon: ICONS.turnRight,
        hold: 'KeyE',
        when: (st) => st.mode === 'heli',
      },
      {
        id: 'turn-left',
        label: 'Left',
        icon: ICONS.turnLeft,
        hold: 'KeyQ',
        when: (st) => st.mode === 'heli',
      },
      {
        id: 'bail',
        label: 'Jump out',
        icon: ICONS.bail,
        press: () => this.actions.key('KeyU'),
        when: (st) => (st.mode === 'plane' || st.mode === 'heli') && !!st.flying,
      },
      {
        id: 'open',
        label: 'Open',
        icon: ICONS.canopy,
        press: () => s.tap('Space'),
        big: true,
        when: (st) => st.mode === 'skydive' && !st.canopy,
      },
      {
        id: 'climb',
        label: 'Up',
        icon: ICONS.up,
        hold: 'KeyW',
        big: true,
        when: (st) => st.mode === 'heli',
      },
      {
        id: 'descend',
        label: 'Down',
        icon: ICONS.down,
        hold: 'KeyS',
        when: (st) => st.mode === 'heli',
      },
      {
        id: 'ff',
        label: 'Fast',
        icon: ICONS.fast,
        hold: 'KeyW',
        big: true,
        when: (st) => st.mode === 'ride' && st.fastForward,
      },
      {
        id: 'skip',
        label: 'Skip',
        icon: ICONS.skip,
        press: () => s.tap('KeyS'),
        when: (st) => st.mode === 'ride',
      },
      {
        id: 'off',
        label: 'Off',
        icon: ICONS.off,
        press: () => this.actions.key('KeyE'),
        when: (st) => st.mode === 'ride',
      },
    ];
    const tools: ButtonSpec[] = [
      {
        id: 'map',
        label: 'Map',
        icon: ICONS.map,
        press: () => this.actions.key('KeyM'),
        when: () => true,
      },
      {
        id: 'fly',
        label: 'Drone',
        icon: ICONS.fly,
        press: () => this.actions.key('KeyF'),
        when: (st) => st.mode !== 'ride' && st.mode !== 'skydive',
        on: (st) => st.mode === 'fly',
      },
      {
        id: 'glider',
        label: 'Paraglider',
        icon: ICONS.glider,
        press: () => this.actions.key('KeyP'),
        when: (st) => st.mode !== 'plane' && st.mode !== 'heli',
        on: (st) => st.mode === 'glide',
      },
      {
        id: 'sled',
        label: 'Snowmobile',
        icon: ICONS.sled,
        press: () => this.actions.key('KeyB'),
        when: (st) =>
          st.mode !== 'ride' && st.mode !== 'plane' && st.mode !== 'heli' && st.mode !== 'skydive',
        on: (st) => st.mode === 'sled',
      },
      {
        id: 'view',
        label: 'View',
        icon: ICONS.view,
        press: () => this.actions.key('KeyV'),
        when: (st) => st.mode !== 'fly',
      },
      {
        id: 'labels',
        label: 'Labels',
        icon: ICONS.labels,
        press: () => this.actions.labels(),
        when: () => true,
        on: (st) => st.names,
      },

      {
        id: 'pistes',
        label: 'Piste colours',
        icon: ICONS.pistes,
        press: () => this.actions.key('Digit3'),
        when: () => true,
        on: (st) => st.pistes,
      },
      {
        id: 'fullscreen',
        label: 'Fullscreen',
        icon: ICONS.fullscreen,
        press: () => void toggleFullscreen(),
        when: () => document.fullscreenEnabled,
      },
    ];
    const make = (spec: ButtonSpec, parent: HTMLElement, cls: string) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `${cls}${spec.big ? ' big' : ''}`;
      el.dataset.touch = spec.id;
      el.setAttribute('aria-label', spec.label);
      el.innerHTML = `${spec.icon}<span>${spec.label}</span>`;
      el.addEventListener('pointerdown', (e) => this.press(e, spec, el));
      el.addEventListener('pointerup', () => this.release(spec, el));
      el.addEventListener('pointercancel', () => this.release(spec, el));
      el.addEventListener('lostpointercapture', () => this.release(spec, el));
      parent.appendChild(el);
      this.buttons.push({ spec, el });
    };
    const cluster = this.root.querySelector<HTMLElement>('#touch-buttons')!;
    const toolbar = this.root.querySelector<HTMLElement>('#touch-tools')!;
    for (const spec of specs) make(spec, cluster, 'touch-btn glass');
    for (const spec of tools) make(spec, toolbar, 'touch-tool glass');
    this.markFullscreen();
    // The portrait hint goes when dismissed (for this visit) or the phone's turned.
    const dismissed = 'ski-sim.rotate-hint';
    if (sessionStorage.getItem(dismissed)) document.body.classList.add('rotate-dismissed');
    this.root.querySelector('#rotate-hint button')!.addEventListener('click', () => {
      document.body.classList.add('rotate-dismissed');
      sessionStorage.setItem(dismissed, '1');
    });
    // Pause: the one way back to the menu (there's no Esc on a phone).
    this.root.querySelector('#touch-pause')!.addEventListener('click', () => this.input.unlock());
  }

  private repeatTimers = new Map<string, number>();

  private press(e: PointerEvent, spec: ButtonSpec, el: HTMLButtonElement): void {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add('down');
    navigator.vibrate?.(8);
    if (spec.hold) this.input.hold(spec.hold, true);
    if (spec.id === 'stop') this.stopping = true;
    spec.press?.();
    if (spec.repeat) {
      this.repeatTimers.set(
        spec.id,
        window.setInterval(() => spec.press?.(), REPEAT_MS),
      );
    }
  }

  private release(spec: ButtonSpec, el: HTMLButtonElement): void {
    if (!el.classList.contains('down')) return;
    el.classList.remove('down');
    if (spec.hold) this.input.hold(spec.hold, false);
    if (spec.id === 'stop') this.stopping = false;
    clearInterval(this.repeatTimers.get(spec.id));
    this.repeatTimers.delete(spec.id);
  }

  /** Let go of the stick, the look drag and every button. */
  private reset(): void {
    for (const { spec, el } of this.buttons) this.release(spec, el);
    this.stickTouch = null;
    this.lookTouch = null;
    this.stopping = false;
    this.input.hockey = 0;
    this.input.stickX = 0;
    this.input.stickY = 0;
    this.input.setStickKeys([]);
    this.stick.classList.remove('active');
    this.stick.style.removeProperty('left');
    this.stick.style.removeProperty('top');
    this.knob.style.transform = '';
  }

  private markFullscreen(): void {
    const el = this.buttons.find((b) => b.spec.id === 'fullscreen')?.el;
    el?.classList.toggle('on', !!document.fullscreenElement);
  }

  // --- the pad: stick on the left half, look on the right ---

  private readonly onDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    e.preventDefault();
    const left = e.clientX < window.innerWidth / 2;
    if (left && !this.stickTouch) {
      this.pad.setPointerCapture(e.pointerId);
      this.stickTouch = { id: e.pointerId, ox: e.clientX, oy: e.clientY };
      this.stick.classList.add('active');
      this.placeStick(e.clientX, e.clientY);
      this.knob.style.transform = '';
    } else if (!left && !this.lookTouch) {
      this.pad.setPointerCapture(e.pointerId);
      this.lookTouch = { id: e.pointerId, x: e.clientX, y: e.clientY };
    }
  };

  private readonly onMove = (e: PointerEvent) => {
    const stick = this.stickTouch;
    if (stick && e.pointerId === stick.id) {
      const v = stickVector(stick.ox, stick.oy, e.clientX, e.clientY);
      this.input.stickX = v.x;
      this.input.stickY = v.y;
      const knob = stickKnob(stick.ox, stick.oy, e.clientX, e.clientY);
      this.knob.style.transform = `translate(${knob.x}px, ${knob.y}px)`;
      return;
    }
    const look = this.lookTouch;
    if (look && e.pointerId === look.id) {
      this.input.look(
        (e.clientX - look.x) * TOUCH_LOOK_GAIN,
        (e.clientY - look.y) * TOUCH_LOOK_GAIN,
      );
      look.x = e.clientX;
      look.y = e.clientY;
    }
  };

  private readonly onUp = (e: PointerEvent) => {
    if (this.stickTouch?.id === e.pointerId) {
      this.stickTouch = null;
      this.input.stickX = 0;
      this.input.stickY = 0;
      this.stick.classList.remove('active');
      this.stick.style.removeProperty('left');
      this.stick.style.removeProperty('top');
      this.knob.style.transform = '';
    }
    if (this.lookTouch?.id === e.pointerId) this.lookTouch = null;
  };

  private placeStick(x: number, y: number): void {
    this.stick.style.left = `${x}px`;
    this.stick.style.top = `${y}px`;
  }
}

async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    // Refused (iPhone Safari has no fullscreen for pages): nothing to do.
  }
}
