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

/** Always-visible readout of position and speed. */
export class Hud {
  private readonly fields: Record<keyof HudState, HTMLElement>;
  private pisteKey: string | null = null;

  constructor(private readonly root: HTMLElement) {
    root.innerHTML = `
      <div class="hud-row"><span class="hud-label">MODE</span><span data-mode></span></div>
      <div class="hud-row"><span class="hud-label">ALT</span><span data-field="altitude"></span></div>
      <div class="hud-row"><span class="hud-label">LAT</span><span data-field="lat"></span></div>
      <div class="hud-row"><span class="hud-label">LON</span><span data-field="lon"></span></div>
      <div class="hud-row"><span class="hud-label">SPD</span><span data-field="speed"></span></div>
      <div class="hud-row hud-piste"><span class="hud-label">RUN</span><span data-piste><i></i><span></span></span></div>
      <div class="hud-toggles">
        <div class="hud-toggle" data-toggle="lift"><kbd>L</kbd> Lift names <b></b></div>
        <div class="hud-toggle" data-toggle="peak"><kbd>P</kbd> Peak names <b></b></div>
        <div class="hud-toggle" data-toggle="pistes"><kbd>O</kbd> Piste colours <b></b></div>
        <div class="hud-toggle"><kbd>M</kbd> Map &amp; teleport</div>
        <div class="hud-toggle"><kbd>F</kbd> Fly / ski</div>
        <div class="hud-toggle"><kbd>V</kbd> Camera</div>
      </div>
    `;
    const field = (name: keyof HudState) =>
      root.querySelector<HTMLElement>(`[data-field="${name}"]`)!;
    this.fields = {
      altitude: field('altitude'),
      lat: field('lat'),
      lon: field('lon'),
      speed: field('speed'),
    };
  }

  /** Reflect an overlay toggle (e.g. "lift", "peak") in the HUD. */
  setToggle(name: string, on: boolean): void {
    const row = this.root.querySelector<HTMLElement>(`[data-toggle="${name}"]`);
    if (!row) return;
    row.classList.toggle('on', on);
    row.querySelector('b')!.textContent = on ? 'ON' : 'OFF';
  }

  /** The run underfoot; null hides the row (e.g. flying high above the snow). */
  setPiste(piste: { name: string; colour: string | null } | null): void {
    const key = piste ? `${piste.name}|${piste.colour}` : '';
    if (key === this.pisteKey) return;
    this.pisteKey = key;
    const row = this.root.querySelector<HTMLElement>('.hud-piste')!;
    row.hidden = !piste;
    if (!piste) return;
    const dot = row.querySelector<HTMLElement>('i')!;
    dot.hidden = !piste.colour;
    if (piste.colour) dot.style.background = piste.colour;
    row.querySelector('[data-piste] span')!.textContent = piste.name;
  }

  setMode(mode: 'fly' | 'ski'): void {
    this.root.querySelector('[data-mode]')!.textContent = mode === 'ski' ? 'SKI' : 'FLY';
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
