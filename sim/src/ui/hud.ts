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

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="hud-row"><span class="hud-label">ALT</span><span data-field="altitude"></span></div>
      <div class="hud-row"><span class="hud-label">LAT</span><span data-field="lat"></span></div>
      <div class="hud-row"><span class="hud-label">LON</span><span data-field="lon"></span></div>
      <div class="hud-row"><span class="hud-label">SPD</span><span data-field="speed"></span></div>
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
