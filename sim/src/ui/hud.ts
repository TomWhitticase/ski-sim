export interface HudState {
  altitude: number;
  lat: number;
  lon: number;
  /** m/s */
  speed: number;
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

/** The on-screen display toggles, shown under the minimap with their number keys. */
export const DISPLAY_TOGGLES = [
  { name: 'lift', key: '1', label: 'Lift names' },
  { name: 'peak', key: '2', label: 'Peak names' },
  { name: 'pistes', key: '3', label: 'Piste colours' },
  { name: 'restaurant', key: '4', label: 'Restaurants' },
  { name: 'view', key: 'V', label: 'First person' },
] as const;

export type DisplayToggle = (typeof DISPLAY_TOGGLES)[number]['name'];

/**
 * Always-visible readout of position and speed (top left), plus the run
 * underfoot and the display toggles beside the minimap.
 */
export class Hud {
  private readonly fields: Record<keyof HudState, HTMLElement>;
  private pisteKey: string | null = null;

  private flyKey = '';
  private bumpTimer = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly run: HTMLElement,
    private readonly toggles: HTMLElement,
    private readonly flySpeed?: HTMLElement,
  ) {
    root.innerHTML = `
      <div class="hud-row"><span class="hud-label">MODE</span><span data-mode></span></div>
      <div class="hud-row"><span class="hud-label">ALT</span><span data-field="altitude"></span></div>
      <div class="hud-row"><span class="hud-label">LAT</span><span data-field="lat"></span></div>
      <div class="hud-row"><span class="hud-label">LON</span><span data-field="lon"></span></div>
      <div class="hud-row"><span class="hud-label">SPD</span><span data-field="speed"></span></div>
    `;
    run.innerHTML =
      '<span class="hud-label">RUN</span><span data-piste><i></i><span></span></span>';
    toggles.innerHTML = DISPLAY_TOGGLES.map(
      (t) =>
        `<div class="hud-toggle" data-toggle="${t.name}"><kbd>${t.key}</kbd> ${t.label} <b></b></div>`,
    ).join('');
    const field = (name: keyof HudState) =>
      root.querySelector<HTMLElement>(`[data-field="${name}"]`)!;
    this.fields = {
      altitude: field('altitude'),
      lat: field('lat'),
      lon: field('lon'),
      speed: field('speed'),
    };
  }

  /** Reflect a display toggle in its row under the minimap. */
  setToggle(name: DisplayToggle, on: boolean): void {
    const row = this.toggles.querySelector<HTMLElement>(`[data-toggle="${name}"]`)!;
    row.classList.toggle('on', on);
    row.querySelector('b')!.textContent = on ? 'ON' : 'OFF';
  }

  /** The run underfoot; null hides the row (e.g. flying high above the snow). */
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
   * Fly mode's set speed (m/s, including any sprint) and how far along its range it is
   * (0-1); null hides it. Changes give the readout a little bump so the wheel feels
   * responsive.
   */
  setFlySpeed(speed: number | null, fill = 0, sprinting = false): void {
    const el = this.flySpeed;
    if (!el) return;
    const key = speed === null ? '' : `${Math.round(speed * 3.6)}|${sprinting}`;
    if (key === this.flyKey) return;
    const changed = this.flyKey !== '' && key !== '';
    this.flyKey = key;
    el.hidden = speed === null;
    if (speed === null) return;
    el.classList.toggle('sprint', sprinting);
    const width = (Math.min(1, Math.max(0, fill)) * 100).toFixed(1);
    el.innerHTML =
      `<span>Fly speed</span><b>${formatSpeed(speed)}</b>` +
      `<span class="bar"><i style="width:${width}%"></i></span>` +
      `<span class="hint">${sprinting ? 'sprinting' : 'scroll to change'}</span>`;
    if (changed) {
      el.classList.add('bump');
      clearTimeout(this.bumpTimer);
      this.bumpTimer = window.setTimeout(() => el.classList.remove('bump'), 150);
    }
  }

  setMode(mode: 'fly' | 'ski' | 'glide' | 'ride' | 'sled'): void {
    this.root.querySelector('[data-mode]')!.textContent =
      mode === 'ride' ? 'LIFT' : mode === 'sled' ? 'SNOWMOBILE' : mode.toUpperCase();
  }

  update(state: HudState): void {
    set(this.fields.altitude, formatAltitude(state.altitude));
    set(this.fields.lat, formatLatitude(state.lat));
    set(this.fields.lon, formatLongitude(state.lon));
    set(this.fields.speed, formatSpeed(state.speed));
  }
}

function set(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
