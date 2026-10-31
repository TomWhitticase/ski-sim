import {
  type BoardPresetId,
  BOARD_PRESETS,
  type BoardSetup,
  boardHandling,
  DEFAULT_BOARD_SETUP,
  type Discipline,
  matchBoardPreset,
} from '../controls/discipline';
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

/** Optional snowboard side of the setup tab (discipline switch + board settings). */
export interface BoardOptions {
  discipline: Discipline;
  setup: BoardSetup;
  onDiscipline: (discipline: Discipline) => void;
  onBoard: (setup: BoardSetup) => void;
}

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
  // Snowboard side (only wired when board options are passed).
  private readonly board?: BoardOptions;
  private boardSetup: BoardSetup = DEFAULT_BOARD_SETUP;
  private readonly skiBlock = document.createElement('div');
  private readonly boardBlock = document.createElement('div');
  private disciplineEl?: HTMLElement;
  private stanceEl?: HTMLElement;
  private boardPresetsEl?: HTMLElement;
  private boardBarsEl?: HTMLElement;

  constructor(
    el: HTMLElement,
    initial: SkiSetup,
    private readonly onChange: (setup: SkiSetup) => void,
    board?: BoardOptions,
  ) {
    super(el);
    this.setup = { ...initial };
    this.board = board;
    const body = el.querySelector<HTMLElement>('.modal-body')!;

    // Discipline switch at the top (Ski / Snowboard), when snowboarding is wired in.
    if (board) {
      this.boardSetup = { ...board.setup };
      const disc = section(body, 'Discipline', 'setup-options discipline-switch');
      disc.setAttribute('role', 'radiogroup');
      for (const [value, label] of [
        ['ski', 'Ski'],
        ['snowboard', 'Snowboard'],
      ] as const) {
        const b = button('setup-option', label);
        b.dataset.discipline = value;
        b.setAttribute('role', 'radio');
        b.addEventListener('click', () => this.setDiscipline(value));
        disc.append(b);
      }
      this.disciplineEl = disc;
      body.append(this.skiBlock, this.boardBlock);
    }
    const skiHost = board ? this.skiBlock : body;

    this.presetsEl = section(skiHost, 'Presets', 'setup-presets');
    for (const [id, preset] of Object.entries(SKI_PRESETS)) {
      const b = button('setup-preset', preset.name);
      b.dataset.preset = id;
      b.addEventListener('click', () => this.set({ ...SKI_PRESETS[id as SkiPresetId].setup }));
      this.presetsEl.append(b);
    }

    const columns = document.createElement('div');
    columns.className = 'setup-columns';
    skiHost.append(columns);
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

    // Board block: stance, board presets, handling bars.
    if (board) {
      const stance = section(this.boardBlock, 'Stance', 'setup-field');
      const stanceOpts = document.createElement('div');
      stanceOpts.className = 'setup-options';
      stanceOpts.setAttribute('role', 'radiogroup');
      for (const [value, label] of [
        ['regular', 'Regular'],
        ['goofy', 'Goofy'],
      ] as const) {
        const b = button('setup-option', label);
        b.dataset.stance = value;
        b.setAttribute('role', 'radio');
        b.addEventListener('click', () => this.setBoard({ ...this.boardSetup, stance: value }));
        stanceOpts.append(b);
      }
      stance.append(stanceOpts);
      const hint = document.createElement('span');
      hint.className = 'setup-hint';
      hint.textContent = 'Regular rides left foot forward, goofy right foot forward.';
      stance.append(hint);
      this.stanceEl = stanceOpts;

      const presets = section(this.boardBlock, 'Board', 'setup-presets');
      for (const [id, preset] of Object.entries(BOARD_PRESETS)) {
        const b = button('setup-preset', preset.name);
        b.dataset.boardPreset = id;
        b.addEventListener('click', () =>
          this.setBoard({
            ...BOARD_PRESETS[id as BoardPresetId].setup,
            stance: this.boardSetup.stance,
          }),
        );
        presets.append(b);
      }
      this.boardPresetsEl = presets;
      this.boardBarsEl = section(this.boardBlock, 'Handling', 'setup-bars');
    }

    el.querySelector('.setup-reset')!.addEventListener('click', () => {
      if (this.board && this.board.discipline === 'snowboard')
        this.setBoard({ ...DEFAULT_BOARD_SETUP });
      else this.set({ ...DEFAULT_SETUP });
    });
    this.render();
  }

  private setDiscipline(discipline: Discipline): void {
    if (!this.board || this.board.discipline === discipline) return;
    this.board.discipline = discipline;
    this.board.onDiscipline(discipline);
    this.render();
  }

  /** Reflect a discipline change made outside the tab (the Y quick toggle), without looping. */
  syncDiscipline(discipline: Discipline): void {
    if (!this.board || this.board.discipline === discipline) return;
    this.board.discipline = discipline;
    this.render();
  }

  private setBoard(setup: BoardSetup): void {
    this.boardSetup = setup;
    this.board?.onBoard(setup);
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
    if (this.board) {
      const snow = this.board.discipline === 'snowboard';
      this.skiBlock.hidden = snow;
      this.boardBlock.hidden = !snow;
      const head = this.el.querySelector('.hub-head');
      const h2 = head?.querySelector('h2');
      const p = head?.querySelector('p');
      if (h2) h2.textContent = snow ? 'Snowboard setup' : 'Ski setup';
      if (p)
        p.textContent = snow
          ? 'Real board properties; the physics follows them'
          : 'Real ski properties; the physics follows them';
      for (const b of this.disciplineEl!.querySelectorAll<HTMLElement>('.setup-option')) {
        const on = b.dataset.discipline === this.board.discipline;
        b.classList.toggle('selected', on);
        b.setAttribute('aria-checked', String(on));
      }
      for (const b of this.stanceEl!.querySelectorAll<HTMLElement>('.setup-option')) {
        const on = b.dataset.stance === this.boardSetup.stance;
        b.classList.toggle('selected', on);
        b.setAttribute('aria-checked', String(on));
      }
      const boardPreset = matchBoardPreset(this.boardSetup);
      for (const b of this.boardPresetsEl!.querySelectorAll<HTMLElement>('.setup-preset')) {
        b.classList.toggle('selected', b.dataset.boardPreset === boardPreset);
      }
      this.boardBarsEl!.replaceChildren(...bars(handlingScores(boardHandling(this.boardSetup))));
    }
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
    this.barsEl.replaceChildren(...bars(handlingScores(skiHandling(this.setup))));
  }
}

function bars(scores: { label: string; value: number }[]): HTMLElement[] {
  return scores.map(({ label, value }) => {
    const row = document.createElement('div');
    row.className = 'setup-bar';
    row.innerHTML = '<span></span><div class="setup-bar-track"><div></div></div>';
    row.querySelector('span')!.textContent = label;
    row.querySelector<HTMLElement>('.setup-bar-track div')!.style.width =
      `${Math.round(value * 100)}%`;
    return row;
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
