import {
  DAY_SECONDS,
  formatRate,
  formatTime,
  TIME_RATES,
  type TimeOfDay,
  type TimePreset,
} from '../env/time-of-day';
import { fillRange, OptionsTab } from './options-hub';

/**
 * Time of day: a slider and presets that move the sun, and how fast the clock runs.
 * Changes apply straight away through `onChange`; `sync()` keeps the slider following
 * the running clock while the tab is open.
 */
export class TimeMenu extends OptionsTab {
  private readonly slider: HTMLInputElement;
  private readonly value: HTMLElement;
  private readonly sunEl: HTMLElement;
  private readonly presetsEl: HTMLElement;
  private readonly ratesEl: HTMLElement;
  private readonly lockHint: HTMLElement;
  private dragging = false;
  private shown = -1;

  constructor(
    el: HTMLElement,
    private readonly clock: TimeOfDay,
    private readonly presets: TimePreset[],
    private readonly sunElevation: () => number,
    private readonly onChange: () => void,
  ) {
    super(el);
    const body = el.querySelector<HTMLElement>('.modal-body')!;
    this.lockHint = document.createElement('p');
    this.lockHint.className = 'time-locked';
    this.lockHint.hidden = true;
    body.append(this.lockHint);

    const time = section(body, 'Time', 'setup-fields');
    const field = document.createElement('label');
    field.className = 'setup-field';
    field.innerHTML =
      '<span class="setup-label">Time of day</span><span class="setup-value"></span>' +
      '<input type="range" name="time" min="0" step="60" /><span class="setup-hint"></span>';
    this.slider = field.querySelector('input')!;
    this.slider.max = String(DAY_SECONDS - 60);
    this.value = field.querySelector('.setup-value')!;
    this.sunEl = field.querySelector('.setup-hint')!;
    this.slider.addEventListener('input', () => this.set(+this.slider.value));
    this.slider.addEventListener('pointerdown', () => (this.dragging = true));
    window.addEventListener('pointerup', () => (this.dragging = false));
    time.append(field);

    this.presetsEl = section(body, 'Presets', 'setup-presets');
    for (const p of presets) {
      const b = button('setup-preset', `${p.name} · ${formatTime(p.seconds)}`);
      b.dataset.preset = p.name;
      b.addEventListener('click', () => this.set(p.seconds));
      this.presetsEl.append(b);
    }

    this.ratesEl = section(body, 'Time speed', 'setup-options');
    this.ratesEl.setAttribute('role', 'radiogroup');
    for (const rate of TIME_RATES) {
      const b = button('setup-option', formatRate(rate));
      b.dataset.rate = String(rate);
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => {
        this.clock.rate = rate;
        this.onChange();
        this.sync(true);
      });
      this.ratesEl.append(b);
    }
    this.sync(true);
  }

  /** In someone else's game the host sets the time: `hint` says so, and nothing's editable. */
  setLocked(hint: string | null): void {
    this.lockHint.textContent = hint ?? '';
    this.lockHint.hidden = !hint;
    for (const input of this.el.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
      '.modal-body input, .modal-body button',
    )) {
      input.disabled = !!hint;
    }
  }

  private set(seconds: number): void {
    this.clock.set(seconds);
    this.onChange();
    this.sync(true);
  }

  /** Refresh from the clock (cheap when the shown minute hasn't changed). */
  sync(force = false): void {
    const minute = Math.floor(this.clock.seconds / 60);
    if (!force && (minute === this.shown || !this.isOpen)) return;
    this.shown = minute;
    if (!this.dragging) this.slider.value = String(minute * 60);
    fillRange(this.slider);
    this.value.textContent = formatTime(this.clock.seconds);
    const el = Math.round(this.sunElevation());
    this.sunEl.textContent =
      el === 0
        ? 'Sun on the horizon'
        : `Sun ${Math.abs(el)}° ${el > 0 ? 'above' : 'below'} the horizon`;
    for (const b of this.presetsEl.querySelectorAll<HTMLElement>('.setup-preset')) {
      const p = this.presets.find((p) => p.name === b.dataset.preset)!;
      b.classList.toggle('selected', Math.abs(p.seconds - minute * 60) < 60);
    }
    for (const b of this.ratesEl.querySelectorAll<HTMLElement>('.setup-option')) {
      const on = +b.dataset.rate! === this.clock.rate;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-checked', String(on));
    }
  }
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
