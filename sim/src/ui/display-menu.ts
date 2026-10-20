import {
  applyDisplay,
  DEFAULT_DISPLAY,
  displaySettings,
  GLASS_STRENGTHS,
  UI_SCALE_RANGE,
} from './display-settings';
import { DISPLAY_TOGGLES, type DisplayToggle } from './hud';
import { fillRange, OptionsTab } from './options-hub';

/** The quick toggles (H, V, 1–4, K), each a switch here and a hotkey in game. */
export type WorldToggle = DisplayToggle;

const ROWS = DISPLAY_TOGGLES;

/**
 * Display (Options): what's drawn in the world (the same switches as the H / V / 1–4 / K
 * keys) and how the interface looks (glass strength, size). World switches need a loaded
 * map (`data-needs-map`); the interface ones apply at once and are saved via `onChange`.
 */
export class DisplayMenu extends OptionsTab {
  private readonly switches = new Map<WorldToggle, HTMLButtonElement>();
  private readonly glassButtons: HTMLButtonElement[] = [];
  private readonly scale: HTMLInputElement;
  private readonly scaleValue: HTMLElement;

  constructor(
    el: HTMLElement,
    private readonly onToggle: (name: WorldToggle) => void,
    private readonly onChange: () => void,
  ) {
    super(el);
    const body = el.querySelector<HTMLElement>('.modal-body')!;

    const world = section(body, 'In the world');
    for (const row of ROWS) {
      const line = document.createElement('div');
      line.className = 'option-row';
      line.innerHTML =
        '<span class="option-label"></span><kbd></kbd><button class="switch" type="button" role="switch" data-needs-map disabled></button>';
      line.querySelector('.option-label')!.textContent = row.label;
      line.querySelector('kbd')!.textContent = row.key;
      const sw = line.querySelector<HTMLButtonElement>('.switch')!;
      sw.dataset.toggle = row.name;
      sw.setAttribute('aria-checked', 'false');
      sw.setAttribute('aria-label', row.label);
      sw.addEventListener('click', () => this.onToggle(row.name));
      this.switches.set(row.name, sw);
      world.append(line);
    }

    const ui = section(body, 'Interface');
    const glass = document.createElement('div');
    glass.className = 'option-row';
    glass.innerHTML =
      '<span class="option-label">Glass<small>Blur behind panels; lighter is faster on slow graphics cards</small></span><div class="setup-options"></div>';
    for (const g of GLASS_STRENGTHS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'setup-option';
      b.dataset.glass = g.value;
      b.textContent = g.label;
      b.addEventListener('click', () => {
        displaySettings.glass = g.value;
        this.changed();
      });
      this.glassButtons.push(b);
      glass.querySelector('.setup-options')!.append(b);
    }
    ui.append(glass);

    const size = document.createElement('label');
    size.className = 'setup-field';
    size.innerHTML =
      '<span class="setup-label">Interface size</span><span class="setup-value"></span><input type="range" name="uiScale" />' +
      '<span class="setup-hint">On top of the automatic size, which follows the window height</span>';
    this.scale = size.querySelector('input')!;
    this.scaleValue = size.querySelector('.setup-value')!;
    this.scale.min = String(UI_SCALE_RANGE.min);
    this.scale.max = String(UI_SCALE_RANGE.max);
    this.scale.step = String(UI_SCALE_RANGE.step);
    this.scale.addEventListener('input', () => {
      displaySettings.uiScale = Number(this.scale.value);
      this.changed();
    });
    ui.append(size);

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'btn';
    reset.textContent = 'Reset interface';
    reset.addEventListener('click', () => {
      Object.assign(displaySettings, DEFAULT_DISPLAY);
      this.changed();
    });
    ui.append(reset);
    this.render();
  }

  /** Show a world toggle's state. */
  set(name: WorldToggle, on: boolean): void {
    this.switches.get(name)?.setAttribute('aria-checked', String(on));
  }

  private changed(): void {
    applyDisplay();
    this.onChange();
    this.render();
  }

  private render(): void {
    for (const b of this.glassButtons) {
      b.classList.toggle('selected', b.dataset.glass === displaySettings.glass);
    }
    this.scale.value = String(displaySettings.uiScale);
    fillRange(this.scale);
    this.scaleValue.textContent = `×${displaySettings.uiScale.toFixed(2)}`;
  }
}

function section(body: HTMLElement, title: string): HTMLElement {
  const s = document.createElement('section');
  s.className = 'option-group';
  const h = document.createElement('h3');
  h.textContent = title;
  s.append(h);
  body.append(s);
  return s;
}
