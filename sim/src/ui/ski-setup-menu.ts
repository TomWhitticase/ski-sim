import {
  DEFAULT_SETUP,
  matchPreset,
  SETUP_RANGES,
  SKI_PRESETS,
  type SkiHandling,
  type SkiPresetId,
  type SkiProfile,
  type SkiSetup,
  type SkiTune,
  type SkiWax,
  skiHandling,
} from '../controls/ski-setup';
import { fillRange, OptionsTab } from './options-hub';

type NumberField = keyof typeof SETUP_RANGES;
type ChoiceField = 'profile' | 'wax' | 'tune';

const SLIDERS: { key: NumberField; label: string; hint: string; format: (v: number) => string }[] =
  [
    {
      key: 'length',
      label: 'Length',
      hint: 'Longer is more stable and faster; shorter turns quicker and easier.',
      format: (v) => `${v} cm`,
    },
    {
      key: 'waist',
      label: 'Waist width',
      hint: 'Wider floats in powder; narrower is quicker edge to edge on piste.',
      format: (v) => `${v} mm`,
    },
    {
      key: 'radius',
      label: 'Sidecut radius',
      hint: 'A smaller radius carves tighter turns; a larger one is calmer at speed.',
      format: (v) => `${v.toFixed(1)} m`,
    },
    {
      key: 'flex',
      label: 'Flex',
      hint: 'Stiff holds an edge at speed; soft is forgiving at low speed but chatters fast.',
      format: (v) => `${v} · ${v <= 3 ? 'soft' : v <= 7 ? 'medium' : 'stiff'}`,
    },
    {
      key: 'mount',
      label: 'Binding mount',
      hint: 'Forward pivots and spins easily; back is more stable and floats better.',
      format: (v) =>
        v === 0 ? 'on the line' : `${Math.abs(v).toFixed(1)} cm ${v > 0 ? 'forward' : 'back'}`,
    },
  ];

const CHOICES: {
  key: ChoiceField;
  label: string;
  hint: string;
  options: { value: SkiProfile | SkiWax | SkiTune; label: string }[];
}[] = [
  {
    key: 'profile',
    label: 'Profile',
    hint: 'Camber grips on hard snow; rocker turns easily and floats in powder.',
    options: [
      { value: 'camber', label: 'Camber' },
      { value: 'tip-rocker', label: 'Tip rocker' },
      { value: 'hybrid', label: 'Rocker-camber-rocker' },
      { value: 'full-rocker', label: 'Full rocker' },
    ],
  },
  {
    key: 'wax',
    label: 'Base wax',
    hint: 'Glide on flats, traverses and cat tracks.',
    options: [
      { value: 'race', label: 'Race wax' },
      { value: 'all-temp', label: 'All-temp' },
      { value: 'worn', label: 'Worn' },
      { value: 'unwaxed', label: 'Dry base' },
    ],
  },
  {
    key: 'tune',
    label: 'Edge tune',
    hint: 'Sharp edges bite on hard and icy snow; dull or detuned edges skid.',
    options: [
      { value: 'race', label: 'Race sharp' },
      { value: 'sharp', label: 'Sharp' },
      { value: 'detuned', label: 'Detuned' },
      { value: 'dull', label: 'Dull' },
    ],
  },
];

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Rough 0–1 scores for the handling summary bars. */
export function handlingScores(h: SkiHandling): { label: string; value: number }[] {
  return [
    { label: 'Top speed', value: clamp01((h.maxSpeed - 18) / 22) },
    { label: 'Glide', value: clamp01(0.15 + (0.062 - h.snowFriction) / 0.03) },
    { label: 'Stability', value: clamp01(h.stableSpeed / 46) },
    { label: 'Carving', value: clamp01((h.carveRate * h.hardGrip) / 4.6) },
    { label: 'Quick turns', value: clamp01((h.turnRate * h.pivotRate * h.edgeRate) / 2) },
    { label: 'Powder float', value: clamp01((0.11 - h.powderFriction) / 0.055) },
  ];
}

/**
 * Ski setup: presets plus real ski properties (length, waist, sidecut, flex, profile,
 * wax, tune, mount). Changes apply straight away through `onChange`.
 */
export class SkiSetupMenu extends OptionsTab {
  private setup: SkiSetup;
  private readonly presetsEl: HTMLElement;
  private readonly barsEl: HTMLElement;
  private readonly sliders = new Map<
    NumberField,
    { input: HTMLInputElement; value: HTMLElement }
  >();
  private readonly choices = new Map<ChoiceField, HTMLElement>();

  constructor(
    el: HTMLElement,
    initial: SkiSetup,
    private readonly onChange: (setup: SkiSetup) => void,
  ) {
    super(el);
    this.setup = { ...initial };
    const body = el.querySelector<HTMLElement>('.modal-body')!;

    this.presetsEl = section(body, 'Presets', 'setup-presets');
    for (const [id, preset] of Object.entries(SKI_PRESETS)) {
      const b = button('setup-preset', preset.name);
      b.dataset.preset = id;
      b.addEventListener('click', () => this.set({ ...SKI_PRESETS[id as SkiPresetId].setup }));
      this.presetsEl.append(b);
    }

    const columns = document.createElement('div');
    columns.className = 'setup-columns';
    body.append(columns);
    const shape = section(columns, 'Ski', 'setup-fields');
    for (const s of SLIDERS) {
      const { min, max, step } = SETUP_RANGES[s.key];
      const field = document.createElement('label');
      field.className = 'setup-field';
      field.innerHTML =
        '<span class="setup-label"></span><span class="setup-value"></span>' +
        '<input type="range" /><span class="setup-hint"></span>';
      field.querySelector('.setup-label')!.textContent = s.label;
      field.querySelector('.setup-hint')!.textContent = s.hint;
      const input = field.querySelector('input')!;
      Object.assign(input, { min, max, step, name: s.key });
      input.addEventListener('input', () => this.set({ ...this.setup, [s.key]: +input.value }));
      this.sliders.set(s.key, { input, value: field.querySelector('.setup-value')! });
      shape.append(field);
    }

    const right = document.createElement('div');
    columns.append(right);
    const tuning = section(right, 'Profile & tune', 'setup-fields');
    for (const c of CHOICES) {
      const field = document.createElement('div');
      field.className = 'setup-field';
      field.innerHTML =
        '<span class="setup-label"></span><div class="setup-options" role="radiogroup"></div>' +
        '<span class="setup-hint"></span>';
      field.querySelector('.setup-label')!.textContent = c.label;
      field.querySelector('.setup-hint')!.textContent = c.hint;
      const options = field.querySelector<HTMLElement>('.setup-options')!;
      options.dataset.field = c.key;
      for (const o of c.options) {
        const b = button('setup-option', o.label);
        b.dataset.value = o.value;
        b.setAttribute('role', 'radio');
        b.addEventListener('click', () => this.set({ ...this.setup, [c.key]: o.value }));
        options.append(b);
      }
      this.choices.set(c.key, options);
      tuning.append(field);
    }
    this.barsEl = section(right, 'Handling', 'setup-bars');

    el.querySelector('.setup-reset')!.addEventListener('click', () =>
      this.set({ ...DEFAULT_SETUP }),
    );
    this.render();
  }

  get current(): SkiSetup {
    return this.setup;
  }

  private set(setup: SkiSetup): void {
    this.setup = setup;
    this.render();
    this.onChange(setup);
  }

  private render(): void {
    const preset = matchPreset(this.setup);
    for (const b of this.presetsEl.querySelectorAll<HTMLElement>('.setup-preset')) {
      b.classList.toggle('selected', b.dataset.preset === preset);
    }
    for (const s of SLIDERS) {
      const { input, value } = this.sliders.get(s.key)!;
      input.value = String(this.setup[s.key]);
      fillRange(input);
      value.textContent = s.format(this.setup[s.key]);
    }
    for (const [key, options] of this.choices) {
      for (const b of options.querySelectorAll<HTMLElement>('.setup-option')) {
        const on = b.dataset.value === this.setup[key];
        b.classList.toggle('selected', on);
        b.setAttribute('aria-checked', String(on));
      }
    }
    this.barsEl.replaceChildren(
      ...handlingScores(skiHandling(this.setup)).map(({ label, value }) => {
        const row = document.createElement('div');
        row.className = 'setup-bar';
        row.innerHTML = '<span></span><div class="setup-bar-track"><div></div></div>';
        row.querySelector('span')!.textContent = label;
        row.querySelector<HTMLElement>('.setup-bar-track div')!.style.width =
          `${Math.round(value * 100)}%`;
        return row;
      }),
    );
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
