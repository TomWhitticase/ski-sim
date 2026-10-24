export interface HudState {
  altitude: number;
  lat: number;
  lon: number;
  /** m/s */
  speed: number;
  /** Degrees clockwise from north. */
  heading: number;
  /** Slope underfoot in degrees, or null away from the snow. */
  slope: number | null;
}

export function formatAltitude(metres: number): string {
  return `${Math.round(metres).toLocaleString('en-GB')} m`;
}

export function formatLatitude(lat: number): string {
  return `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? 'N' : 'S'}`;
}

export function formatLongitude(lon: number): string {
  return `${Math.abs(lon).toFixed(5)}° ${lon >= 0 ? 'E' : 'W'}`;
}

export function formatSpeed(metresPerSecond: number): string {
  return `${Math.round(metresPerSecond * 3.6)} km/h`;
}

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** A compass heading as `040° NE` (the nearest of eight points). */
export function formatHeading(degrees: number): string {
  const d = ((Math.round(degrees) % 360) + 360) % 360;
  return `${String(d).padStart(3, '0')}° ${POINTS[Math.round(d / 45) % 8]}`;
}

/** Signed difference from `from` to `to` in degrees, in -180..180. */
export function bearingDelta(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

/**
 * The quick toggles: a key each in game, listed small down the right of the screen (lit
 * when on), and switches under Options → Display.
 */
export const DISPLAY_TOGGLES = [
  { name: 'hud', key: 'H', label: 'HUD', short: 'HUD' },
  { name: 'view', key: 'V', label: 'First person', short: '1st person' },
  { name: 'lift', key: '1', label: 'Lift names', short: 'Lifts' },
  { name: 'peak', key: '2', label: 'Peak names', short: 'Peaks' },
  { name: 'pistes', key: '3', label: 'Piste colours', short: 'Pistes' },
  { name: 'restaurant', key: '4', label: 'Restaurant names', short: 'Restaurants' },
  { name: 'sound', key: 'K', label: 'Sound', short: 'Sound' },
] as const;

export type DisplayToggle = (typeof DISPLAY_TOGGLES)[number]['name'];

/** Compass tape: pixels per degree, and how far either side of the heading it reaches. */
const COMPASS_PX = 3.5;
const COMPASS_SPAN = 45;
/** How long a toggle's row stays highlighted after its key is pressed (ms). */
const FLASH_MS = 1200;

/**
 * The in-game HUD (dark glass): the run underfoot (top left), a compass tape (top
 * centre) with the guide marker on it, the run and a stat strip (bottom left: speed with
 * the mode, altitude, slope), coordinates under the minimap with the quick toggles below,
 * and the drone's set speed (fly mode).
 */
export class Hud {
  private readonly fields: Record<'altitude' | 'lat' | 'lon' | 'speed' | 'slope', HTMLElement>;
  private readonly run: HTMLElement;
  private readonly toggles: HTMLElement;
  private readonly flySpeed: HTMLElement;
  private readonly flyKeys: HTMLElement;
  private readonly compass: HTMLElement;
  private readonly tape: HTMLElement;
  private readonly heading: HTMLElement;
  private readonly marker: HTMLElement;
  private pisteKey: string | null = null;
  private flyKey = '';
  private bumpTimer = 0;
  private readonly flashTimers = new Map<string, number>();
  private shownHeading = NaN;
  private markerBearing: number | null = null;

  constructor(private readonly root: HTMLElement) {
    this.run = root.querySelector('#run')!;
    this.toggles = root.querySelector('#toggles')!;
    this.flySpeed = root.querySelector('#fly-speed')!;
    this.flyKeys = root.querySelector('#fly-keys')!;
    this.compass = root.querySelector('#compass')!;

    this.run.innerHTML = '<span data-piste><i></i><span></span></span>';

    // The tape spans -180..540° so any heading has a full window either side of it.
    const labels: string[] = [];
    for (let d = -180; d <= 540; d += 15) {
      const n = ((d % 360) + 360) % 360;
      const text = n % 45 === 0 ? POINTS[n / 45]! : String(n);
      const cls = n % 90 === 0 ? 'cardinal' : n % 45 === 0 ? 'point' : '';
      labels.push(`<span class="${cls}" style="left:${(d + 180) * COMPASS_PX}px">${text}</span>`);
    }
    this.compass.innerHTML =
      `<div class="compass-window"><div class="compass-tape" style="width:${720 * COMPASS_PX}px">${labels.join('')}</div>` +
      '<i class="compass-marker" hidden></i></div><b class="compass-caret"></b>' +
      '<span class="compass-heading"></span>';
    this.compass.style.setProperty('--compass-px', `${COMPASS_PX}px`);
    this.compass.style.setProperty('--compass-width', `${COMPASS_SPAN * 2 * COMPASS_PX}px`);
    this.toggles.innerHTML = DISPLAY_TOGGLES.map(
      (t) => `<div data-toggle="${t.name}"><kbd>${t.key}</kbd><span>${t.short}</span></div>`,
    ).join('');
    this.tape = this.compass.querySelector('.compass-tape')!;
    this.heading = this.compass.querySelector('.compass-heading')!;
    this.marker = this.compass.querySelector('.compass-marker')!;

    root.querySelector('.hud-stats')!.innerHTML =
      '<div class="hud-speed"><span class="lab"><span data-mode></span> · km/h</span><b data-field="speed"></b></div>' +
      '<div><span class="lab">Altitude</span><b><span data-field="altitude"></span><span class="unit">m</span></b></div>' +
      '<div><span class="lab">Slope</span><b><span data-field="slope"></span><span class="unit">°</span></b></div>';
    const field = (name: string) => root.querySelector<HTMLElement>(`[data-field="${name}"]`)!;
    this.fields = {
      altitude: field('altitude'),
      lat: field('lat'),
      lon: field('lon'),
      speed: field('speed'),
      slope: field('slope'),
    };
  }

  /**
   * Show a quick toggle's state in the list on screen; `announce` (its key was just
   * pressed) briefly highlights the row.
   */
  setToggle(name: DisplayToggle, on: boolean, announce = false): void {
    const row = this.toggles.querySelector<HTMLElement>(`[data-toggle="${name}"]`);
    if (!row) return;
    row.classList.toggle('on', on);
    // H: nothing but the world (labels, markers and piste colours go too; see main.ts).
    if (name === 'hud') document.body.classList.toggle('hud-off', !on);
    if (!announce) return;
    row.classList.add('flash');
    clearTimeout(this.flashTimers.get(name));
    this.flashTimers.set(
      name,
      window.setTimeout(() => row.classList.remove('flash'), FLASH_MS),
    );
  }

  /** The run underfoot (with its piste colour); null hides it (e.g. flying high). */
  setPiste(piste: { name: string; colour: string | null } | null): void {
    const key = piste ? `${piste.name}|${piste.colour}` : '';
    if (key === this.pisteKey) return;
    this.pisteKey = key;
    this.run.hidden = !piste;
    if (!piste) return;
    const dot = this.run.querySelector<HTMLElement>('i')!;
    dot.hidden = !piste.colour;
    if (piste.colour) dot.style.background = piste.colour;
    this.run.querySelector('[data-piste] span')!.textContent = piste.name;
  }

  /**
   * The drone's set speed (fly mode; m/s) and how far along its range it is (0-1); null hides it.
   * Changes give the readout a little bump so the wheel feels responsive.
   */
  setFlySpeed(speed: number | null, fill = 0): void {
    const el = this.flySpeed;
    const key = speed === null ? '' : String(Math.round(speed * 3.6));
    if (key === this.flyKey) return;
    const changed = this.flyKey !== '' && key !== '';
    this.flyKey = key;
    el.hidden = speed === null;
    if (speed === null) return;
    const width = (Math.min(1, Math.max(0, fill)) * 100).toFixed(1);
    el.innerHTML =
      `<span class="lab">Drone speed</span><b>${Math.round(speed * 3.6)}<span class="unit"> km/h</span></b>` +
      `<span class="bar"><i style="width:${width}%"></i></span>` +
      '<span class="lab desktop-only">Scroll to change</span>';
    if (changed) {
      el.classList.add('bump');
      clearTimeout(this.bumpTimer);
      this.bumpTimer = window.setTimeout(() => el.classList.remove('bump'), 150);
    }
  }

  /**
   * Fly mode's ways out, always on screen so there's no guessing: back to the skier
   * holding the controller (`body`), or down to the snow where the drone is. Null hides them.
   */
  setFlyKeys(state: 'body' | 'free' | null): void {
    this.flyKeys.hidden = state === null;
    if (state === null) return;
    // Tappable on a touchscreen (`data-key`: main.ts does what the key does).
    const key = (k: string, text: string) =>
      `<span data-key="Key${k}"><kbd>${k}</kbd>${text}</span>`;
    this.flyKeys.innerHTML =
      state === 'body'
        ? key('F', 'Back to your skier') + key('R', 'Ski from here')
        : key('F', 'Ski from here');
  }

  setMode(mode: 'fly' | 'ski' | 'glide' | 'ride' | 'sled'): void {
    this.root.querySelector('[data-mode]')!.textContent =
      mode === 'ride'
        ? 'LIFT'
        : mode === 'sled'
          ? 'SNOWMOBILE'
          : mode === 'fly'
            ? 'DRONE'
            : mode.toUpperCase();
  }

  /** The guide marker's bearing from you (degrees), or null when there's none. */
  setMarker(bearing: number | null): void {
    this.markerBearing = bearing;
    this.shownHeading = NaN; // redraw
  }

  update(state: HudState): void {
    set(this.fields.altitude, Math.round(state.altitude).toLocaleString('en-GB'));
    set(this.fields.lat, formatLatitude(state.lat));
    set(this.fields.lon, formatLongitude(state.lon));
    set(this.fields.speed, String(Math.round(state.speed * 3.6)));
    set(this.fields.slope, state.slope === null ? '–' : String(Math.round(state.slope)));
    this.updateCompass(state.heading);
  }

  private updateCompass(heading: number): void {
    this.compass.hidden = false;
    if (Math.abs(heading - this.shownHeading) < 0.2) return;
    this.shownHeading = heading;
    const h = ((heading % 360) + 360) % 360;
    const offset = COMPASS_SPAN * COMPASS_PX - (h + 180) * COMPASS_PX;
    this.tape.style.transform = `translateX(${offset.toFixed(1)}px)`;
    set(this.heading, formatHeading(h));
    const b = this.markerBearing;
    this.marker.hidden = b === null;
    if (b !== null) {
      const d = Math.max(-COMPASS_SPAN + 2, Math.min(COMPASS_SPAN - 2, bearingDelta(h, b)));
      this.marker.style.left = `${(COMPASS_SPAN + d) * COMPASS_PX}px`;
    }
  }
}

function set(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
