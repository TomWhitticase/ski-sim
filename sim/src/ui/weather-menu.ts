import { formatTime } from '../env/time-of-day';
import {
  type Conditions,
  compass,
  conditionsAt,
  describe,
  describeSky,
  formatVisibility,
} from '../env/weather';
import type { WeatherChoice, WeatherState } from '../env/weather-control';
import { FIRST_DATE } from '../env/weather-source';
import { OptionsTab } from './options-hub';

/** Which of the three the choice is, for the radio buttons. */
const MODES: { mode: WeatherChoice['mode']; label: string }[] = [
  { mode: 'clear', label: 'Clear' },
  { mode: 'live', label: 'Live' },
  { mode: 'past', label: 'A past day' },
];

/**
 * Options → Weather (C): Clear (the bluebird default), Live (today, now) or a day from the
 * past, with the time. Shows the conditions where you are in words and numbers, and the
 * day hour by hour (click an hour to go there).
 */
export class WeatherMenu extends OptionsTab {
  private readonly modesEl: HTMLElement;
  private readonly dateInput: HTMLInputElement;
  private readonly timeInput: HTMLInputElement;
  private readonly when: HTMLElement;
  private readonly status: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly details: HTMLElement;
  private readonly hours: HTMLElement;
  private readonly lockHint: HTMLElement;
  private shownVersion = -1;
  private shownMinute = -1;

  constructor(
    el: HTMLElement,
    private readonly weather: WeatherState,
    /** The clock (seconds after local midnight) and setting it. */
    private readonly clock: { seconds: number; set(seconds: number): void },
    /** Height (m) to show the hour strip for: where you are. */
    private readonly altitude: () => number,
    /** The instant (ms UTC) for a time of day on the shown date. */
    private readonly instant: (seconds: number) => number,
    private readonly onChoose: (choice: WeatherChoice) => void,
    private readonly onTime: () => void,
  ) {
    super(el);
    const body = el.querySelector<HTMLElement>('.modal-body')!;
    this.lockHint = document.createElement('p');
    this.lockHint.className = 'time-locked';
    this.lockHint.hidden = true;
    body.append(this.lockHint);

    this.modesEl = section(body, 'Weather', 'setup-options');
    this.modesEl.setAttribute('role', 'radiogroup');
    for (const { mode, label } of MODES) {
      const b = button('setup-option', label);
      b.dataset.mode = mode;
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => {
        if (mode === 'past') this.choose({ mode, date: this.pastDate() });
        else this.choose({ mode });
      });
      this.modesEl.append(b);
    }

    const when = section(body, 'Day and time', 'weather-when');
    this.when = when;
    this.dateInput = input('date', 'date');
    this.dateInput.min = FIRST_DATE;
    this.dateInput.addEventListener('change', () => {
      if (this.dateInput.value) this.choose({ mode: 'past', date: this.dateInput.value });
    });
    this.timeInput = input('time', 'time');
    this.timeInput.step = '60';
    this.timeInput.addEventListener('change', () => {
      const [h, m] = this.timeInput.value.split(':').map(Number);
      if (!Number.isFinite(h) || !Number.isFinite(m)) return;
      this.clock.set(h! * 3600 + m! * 60);
      this.onTime();
      this.sync(true);
    });
    when.append(this.dateInput, this.timeInput);

    const now = section(body, 'Conditions here', 'weather-now');
    this.summary = document.createElement('p');
    this.summary.className = 'weather-summary';
    this.status = document.createElement('p');
    this.status.className = 'weather-status';
    this.details = document.createElement('dl');
    this.details.className = 'weather-details';
    now.append(this.summary, this.details, this.status);

    this.hours = section(body, 'The day, hour by hour', 'weather-hours');
    const credit = document.createElement('p');
    credit.className = 'weather-credit';
    credit.innerHTML =
      'Weather data by <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo.com</a> ' +
      '(ERA5 reanalysis, CC BY 4.0), fetched only while weather is on.';
    body.append(credit);
    this.sync(true);
  }

  /** In someone else's game the host sets the weather. */
  setLocked(hint: string | null): void {
    this.lockHint.textContent = hint ?? '';
    this.lockHint.hidden = !hint;
    for (const el of this.el.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
      '.modal-body input, .modal-body button',
    )) {
      el.disabled = !!hint;
    }
  }

  private pastDate(): string {
    const c = this.weather.choice;
    if (c.mode === 'past') return c.date;
    // A year ago today, a sensible first pick.
    const today = this.weather.today().date;
    return `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`;
  }

  private choose(choice: WeatherChoice): void {
    this.onChoose(choice);
    this.sync(true);
  }

  /** Refresh (cheap unless the data or the shown minute changed). */
  sync(force = false): void {
    const minute = Math.floor(this.clock.seconds / 60);
    const w = this.weather;
    if (!force && !this.isOpen) return;
    if (!force && minute === this.shownMinute && w.version === this.shownVersion) {
      this.showConditions(w.conditions); // where you are moves on its own
      return;
    }
    this.shownMinute = minute;
    this.shownVersion = w.version;
    for (const b of this.modesEl.querySelectorAll<HTMLElement>('.setup-option')) {
      const on = b.dataset.mode === w.choice.mode;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-checked', String(on));
    }
    this.when.parentElement!.hidden = !w.on;
    this.hours.parentElement!.hidden = !w.day;
    this.dateInput.max = w.today().date;
    this.dateInput.value = w.date;
    this.dateInput.disabled = w.following || w.choice.mode === 'live';
    if (document.activeElement !== this.timeInput)
      this.timeInput.value = formatTime(this.clock.seconds);
    this.status.textContent =
      w.status === 'loading'
        ? 'Getting the weather…'
        : w.status === 'error'
          ? w.message
          : w.status === 'ready' && w.day
            ? `${w.day.source === 'archive' ? 'Reanalysis' : 'Weather model'} for ${formatDate(w.date)}`
            : 'Bluebird: no cloud, no wind.';
    this.status.classList.toggle('error', w.status === 'error');
    this.showConditions(w.conditions);
    this.showHours();
  }

  private showConditions(c: Conditions): void {
    const text = this.weather.day ? describe(c) : 'Clear · no weather';
    if (this.summary.textContent !== text) this.summary.textContent = text;
    if (!this.weather.day) {
      this.details.replaceChildren();
      return;
    }
    const kmh = (ms: number) => `${Math.round(ms * 3.6)} km/h`;
    const rows: [string, string][] = [
      [
        'Temperature',
        `${c.temperature < -0.05 ? '−' : ''}${Math.abs(c.temperature).toFixed(1)} °C`,
      ],
      ['Wind', `${kmh(c.wind)} ${compass(c.windFrom)} · gusts ${kmh(c.gusts)}`],
      ['Visibility', formatVisibility(c.visibility).replace('visibility ', '')],
      [
        'Cloud',
        `${Math.round(c.cloud * 100)} % · low ${Math.round(c.cloudLow * 100)} · mid ${Math.round(c.cloudMid * 100)} · high ${Math.round(c.cloudHigh * 100)}`,
      ],
      [
        'Falling',
        c.precipitation === 'none'
          ? 'nothing'
          : c.snowRate > 0.01
            ? `${c.snowRate.toFixed(1)} cm/h snow${c.rainRate > 0.05 ? ` · ${c.rainRate.toFixed(1)} mm/h rain` : ''}`
            : `${c.rainRate.toFixed(1)} mm/h rain`,
      ],
      ['New snow, 24 h', `${Math.round(c.freshSnow)} cm`],
    ];
    const html = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    if (this.details.innerHTML !== html) this.details.innerHTML = html;
  }

  /** 24 hour cells: how cloudy (shade), what's falling (bar), click to go to that hour. */
  private showHours(): void {
    const day = this.weather.day;
    if (!day) return;
    const altitude = this.altitude();
    const hour = Math.floor(this.clock.seconds / 3600);
    const cells: HTMLElement[] = [];
    for (let h = 0; h < 24; h++) {
      const c = conditionsAt(day, this.instant(h * 3600 + 1800), altitude);
      const b = button('weather-hour', '');
      b.dataset.hour = String(h);
      b.classList.toggle('selected', h === hour);
      b.style.setProperty('--cloud', c.overcast.toFixed(2));
      b.style.setProperty(
        '--fall',
        Math.min(1, (c.snowRate / 3 + c.rainRate / 6) ** 0.6).toFixed(2),
      );
      b.classList.toggle('rain', c.precipitation === 'rain');
      b.title = `${String(h).padStart(2, '0')}:00 · ${describe(c)}`;
      b.setAttribute('aria-label', b.title);
      b.innerHTML = `<span class="weather-hour-bar"></span><span class="weather-hour-label">${h % 3 === 0 ? h : ''}</span>`;
      b.addEventListener('click', () => {
        this.clock.set(h * 3600 + Math.min(3599, this.clock.seconds % 3600));
        this.onTime();
        this.sync(true);
      });
      b.disabled = this.weather.following;
      cells.push(b);
    }
    this.hours.replaceChildren(...cells);
    this.hours.setAttribute('aria-label', `Hourly: ${describeSky(this.weather.conditions)} now`);
  }
}

/** "Thursday 4 January 2018" */
function formatDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function section(parent: HTMLElement, title: string, className: string): HTMLElement {
  const s = document.createElement('section');
  const h = document.createElement('h3');
  h.textContent = title;
  const content = document.createElement('div');
  content.className = className;
  s.append(h, content);
  parent.append(s);
  return content;
}

function button(className: string, text: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = text;
  return b;
}

function input(type: string, name: string): HTMLInputElement {
  const i = document.createElement('input');
  i.type = type;
  i.name = name;
  i.className = 'mp-input weather-input';
  return i;
}
