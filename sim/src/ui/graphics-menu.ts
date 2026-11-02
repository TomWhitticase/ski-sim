import {
  defaultPreset,
  GRAPHICS_PRESET_LABELS,
  GRAPHICS_PRESETS_ORDER,
  graphics,
  type GraphicsOptions,
  type GraphicsPreset,
  presetFor,
  setGraphicsPreset,
  TERRAIN_DETAIL_LABELS,
  TERRAIN_DETAIL_ORDER,
  type TerrainDetailLevel,
  terrainDetailCeiling,
} from '../render/graphics';
import { OptionsTab } from './options-hub';

/**
 * Graphics (Options): a preset picker (Fast / Default / Fancy) over the individual graphics
 * options, so the player chooses a look in one click or tunes a single option (then the
 * preset reads "Custom"). Mirrors the Ski-setup discipline switch and the Display glass
 * radiogroup. Terrain detail is baked into the terrain material at load, so a change is
 * saved at once and applied on the next world load — the panel shows an "Apply & reload"
 * bar while the live choice differs from what's currently rendering.
 */
export class GraphicsMenu extends OptionsTab {
  private readonly presetButtons: HTMLButtonElement[] = [];
  private readonly detailButtons: HTMLButtonElement[] = [];
  private readonly presetTag: HTMLElement;
  private readonly reloadBar: HTMLElement;
  /** The options the running terrain material was built with (for the reload prompt). */
  private readonly rendered: GraphicsOptions;

  constructor(
    el: HTMLElement,
    private readonly mobile: boolean,
    private readonly onChange: () => void,
    private readonly onApply: () => void,
  ) {
    super(el);
    this.rendered = { ...graphics };
    const body = el.querySelector<HTMLElement>('.modal-body')!;

    // Preset picker.
    const preset = section(body, 'Preset');
    const row = document.createElement('div');
    row.className = 'option-row';
    row.innerHTML =
      '<span class="option-label">Quality<small>Fast is the cheapest look; Fancy the richest. ' +
      'Choosing one sets every option below.</small></span>' +
      '<div class="setup-options" role="radiogroup" aria-label="Graphics preset"></div>';
    const group = row.querySelector('.setup-options')!;
    for (const p of GRAPHICS_PRESETS_ORDER) {
      const b = optionButton(GRAPHICS_PRESET_LABELS[p]);
      b.dataset.preset = p;
      b.addEventListener('click', () => this.choosePreset(p));
      this.presetButtons.push(b);
      group.append(b);
    }
    preset.append(row);
    this.presetTag = document.createElement('p');
    this.presetTag.className = 'setup-hint';
    preset.append(this.presetTag);

    // Individual options.
    const options = section(body, 'Options');
    options.append(
      this.detailRow(
        'Terrain detail',
        'Procedural close-up rock and snow. Off is a flat surface; Ultra is the strongest, ' +
          'reaching furthest.',
        TERRAIN_DETAIL_ORDER,
        TERRAIN_DETAIL_LABELS,
        this.detailButtons,
        (level) => this.setTerrainDetail(level),
      ),
    );
    if (this.mobile) {
      const note = document.createElement('p');
      note.className = 'setup-hint';
      note.textContent = `On this device terrain detail is capped at ${
        TERRAIN_DETAIL_LABELS[terrainDetailCeiling(true)]
      } to keep it smooth.`;
      options.append(note);
    }

    // Reload prompt (terrain detail only takes effect on the next world load).
    this.reloadBar = document.createElement('div');
    this.reloadBar.className = 'option-row reload-bar';
    this.reloadBar.hidden = true;
    const msg = document.createElement('span');
    msg.className = 'option-label';
    msg.textContent = 'Terrain detail changes apply when the map reloads.';
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'btn btn-primary';
    apply.textContent = 'Apply & reload';
    apply.addEventListener('click', () => this.onApply());
    this.reloadBar.append(msg, apply);
    body.append(this.reloadBar);

    // Reset to the device's starting preset.
    const reset = el.querySelector<HTMLButtonElement>('.setup-reset');
    reset?.addEventListener('click', () => this.choosePreset(defaultPreset()));

    this.render();
  }

  private detailRow(
    label: string,
    hint: string,
    values: readonly TerrainDetailLevel[],
    labels: Record<TerrainDetailLevel, string>,
    store: HTMLButtonElement[],
    onPick: (v: TerrainDetailLevel) => void,
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'option-row';
    row.innerHTML =
      `<span class="option-label">${label}<small>${hint}</small></span>` +
      '<div class="setup-options" role="radiogroup"></div>';
    const group = row.querySelector('.setup-options')!;
    group.setAttribute('aria-label', label);
    for (const v of values) {
      const b = optionButton(labels[v]);
      b.dataset.detail = v;
      b.addEventListener('click', () => onPick(v));
      store.push(b);
      group.append(b);
    }
    return row;
  }

  private choosePreset(p: GraphicsPreset): void {
    setGraphicsPreset(p);
    this.changed();
  }

  private setTerrainDetail(level: TerrainDetailLevel): void {
    if (graphics.terrainDetail === level) return;
    graphics.terrainDetail = level;
    this.changed();
  }

  private changed(): void {
    this.onChange();
    this.render();
  }

  private render(): void {
    const active = presetFor(graphics);
    for (const b of this.presetButtons) {
      const on = b.dataset.preset === active;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-checked', String(on));
    }
    for (const b of this.detailButtons) {
      const on = b.dataset.detail === graphics.terrainDetail;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-checked', String(on));
    }
    this.presetTag.textContent = active
      ? `${GRAPHICS_PRESET_LABELS[active]} preset selected.`
      : 'Custom — one or more options differ from a preset.';
    // Show the reload prompt only once the choice differs from what's on screen.
    this.reloadBar.hidden = graphics.terrainDetail === this.rendered.terrainDetail;
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

function optionButton(label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'setup-option';
  b.setAttribute('role', 'radio');
  b.textContent = label;
  return b;
}
