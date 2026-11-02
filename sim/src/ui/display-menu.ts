import {
  applyDisplay,
  DEFAULT_DISPLAY,
  displaySettings,
  GLASS_STRENGTHS,
  UI_SCALE_RANGE,
} from './display-settings';
import { fillRange, OptionsTab } from './options-hub';
import { keyLabel, type Registry } from './registry';

/**
 * Display (Options): what's drawn in the world (the registry's `display` entries: the
 * same switches as the H / V / 1–5 / K keys) and how the interface looks (glass
 * strength, size). World switches need a loaded map (`data-needs-map`); the interface
 * ones apply at once and are saved via `onChange`.
 */
export class DisplayMenu extends OptionsTab {
  private readonly switches = new Map<string, HTMLButtonElement>();
  private readonly glassButtons: HTMLButtonElement[] = [];
  private readonly scale: HTMLInputElement;
  private readonly scaleValue: HTMLElement;
  private readonly signSwitch: HTMLButtonElement;
  private readonly tipsSwitch: HTMLButtonElement;

  constructor(
    el: HTMLElement,
    private readonly registry: Registry,
    private readonly onChange: () => void,
    /** "Show tips again": forget which hints have been seen. */
    onResetTips: () => void = () => {},
  ) {
    super(el);
    const body = el.querySelector<HTMLElement>('.modal-body')!;

    const world = section(body, 'In the world');
    for (const entry of registry.entries.filter((e) => e.display)) {
      const line = document.createElement('div');
      line.className = 'option-row';
      line.innerHTML =
        '<span class="option-label"></span><kbd></kbd><button class="switch" type="button" role="switch" data-needs-map disabled></button>';
      line.querySelector('.option-label')!.textContent = entry.label;
      line.querySelector('kbd')!.textContent = entry.key ? keyLabel(entry.key) : '';
      const sw = line.querySelector<HTMLButtonElement>('.switch')!;
      sw.dataset.toggle = entry.id;
      sw.setAttribute('aria-checked', String(registry.isOn(entry)));
      sw.setAttribute('aria-label', entry.label);
      sw.addEventListener('click', () => entry.run());
      this.switches.set(entry.id, sw);
      world.append(line);
    }
    registry.subscribe(() => this.refresh());

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

    const sign = document.createElement('div');
    sign.className = 'option-row';
    sign.innerHTML =
      '<span class="option-label">Sign readout<small>The signpost ahead, as text under the compass</small></span>' +
      '<button class="switch" type="button" role="switch" aria-label="Sign readout"></button>';
    this.signSwitch = sign.querySelector<HTMLButtonElement>('.switch')!;
    this.signSwitch.addEventListener('click', () => {
      displaySettings.signReadout = !displaySettings.signReadout;
      this.changed();
    });
    ui.append(sign);

    const tips = document.createElement('div');
    tips.className = 'option-row';
    tips.innerHTML =
      '<span class="option-label">Tips<small>A one-line hint the first time something is useful, once each</small></span>' +
      '<button class="btn tips-again" type="button">Show again</button>' +
      '<button class="switch" type="button" role="switch" aria-label="Tips"></button>';
    this.tipsSwitch = tips.querySelector<HTMLButtonElement>('.switch')!;
    this.tipsSwitch.addEventListener('click', () => {
      displaySettings.tips = !displaySettings.tips;
      this.changed();
    });
    tips.querySelector('.tips-again')!.addEventListener('click', (e) => {
      onResetTips();
      (e.currentTarget as HTMLButtonElement).textContent = 'Reset';
    });
    ui.append(tips);

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

  /** Show every switch's state (the world's, from the registry, and the interface's). */
  refresh(): void {
    for (const [id, sw] of this.switches) {
      const entry = this.registry.get(id);
      if (entry) sw.setAttribute('aria-checked', String(this.registry.isOn(entry)));
    }
    this.render();
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
    this.signSwitch.setAttribute('aria-checked', String(displaySettings.signReadout));
    this.tipsSwitch.setAttribute('aria-checked', String(displaySettings.tips));
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
