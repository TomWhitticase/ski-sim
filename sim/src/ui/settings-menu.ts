import {
  CAMERA_RANGES,
  type CameraSettings,
  cameraSettings,
  DEFAULT_CAMERA,
} from '../controls/camera-settings';
import { fillRange, OptionsTab } from './options-hub';

type NumericKey = keyof typeof CAMERA_RANGES;

const SLIDERS: { key: NumericKey; label: string; hint: string; format: (v: number) => string }[] = [
  {
    key: 'fovFirst',
    label: 'Field of view: first person',
    hint: 'Vertical; wider shows more but distorts the edges',
    format: (v) => `${v}°`,
  },
  {
    key: 'fovThird',
    label: 'Field of view: third person',
    hint: 'Vertical, behind the skier (V swaps view)',
    format: (v) => `${v}°`,
  },
  {
    key: 'speedFov',
    label: 'Speed widening',
    hint: 'Extra field of view at full speed (skiing and sledding)',
    format: (v) => (v === 0 ? 'Off' : `+${v}°`),
  },
  {
    key: 'sensitivity',
    label: 'Mouse sensitivity',
    hint: 'How far the view turns for a mouse movement',
    format: (v) => `×${v.toFixed(2)}`,
  },
  {
    key: 'chaseDistance',
    label: 'Third-person distance',
    hint: 'How far behind the camera sits (V swaps view)',
    format: (v) => `×${v.toFixed(2)}`,
  },
];

/** Settings (O): camera and mouse preferences, applied live through `onChange`. */
export class SettingsMenu extends OptionsTab {
  private readonly sliders = new Map<NumericKey, { input: HTMLInputElement; value: HTMLElement }>();

  constructor(
    el: HTMLElement,
    private readonly onChange: () => void,
  ) {
    super(el);
    const body = el.querySelector<HTMLElement>('.modal-body')!;
    const fields = section(body, 'Camera', 'setup-fields');
    for (const s of SLIDERS) {
      const { min, max, step } = CAMERA_RANGES[s.key];
      const field = document.createElement('label');
      field.className = 'setup-field';
      field.innerHTML =
        '<span class="setup-label"></span><span class="setup-value"></span>' +
        '<input type="range" /><span class="setup-hint"></span>';
      field.querySelector('.setup-label')!.textContent = s.label;
      field.querySelector('.setup-hint')!.textContent = s.hint;
      const input = field.querySelector('input')!;
      Object.assign(input, { min, max, step, name: s.key });
      input.addEventListener('input', () => this.set({ [s.key]: +input.value }));
      this.sliders.set(s.key, { input, value: field.querySelector('.setup-value')! });
      fields.append(field);
    }

    const field = document.createElement('div');
    field.className = 'setup-field';
    field.innerHTML =
      '<span class="setup-label">Invert mouse Y</span>' +
      '<div class="setup-options" role="radiogroup"></div>' +
      '<span class="setup-hint">Push the mouse forward to look down</span>';
    const options = field.querySelector<HTMLElement>('.setup-options')!;
    for (const on of [false, true]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'setup-option';
      b.textContent = on ? 'On' : 'Off';
      b.dataset.invert = String(on);
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => this.set({ invertY: on }));
      options.append(b);
    }
    fields.append(field);

    // Options → Controls: what flies a plane or helicopter (keyboard and mouse only).
    const controls = document.querySelector<HTMLElement>('#opt-controls .modal-body');
    if (controls) {
      const fly = document.createElement('section');
      fly.className = 'desktop-only fly-with';
      fly.innerHTML =
        '<h3>Fly aircraft with</h3><div class="setup-field">' +
        '<div class="setup-options" role="radiogroup"></div>' +
        '<span class="setup-hint">Arrow keys: the mouse only looks round. Mouse: the arrows work too.</span></div>';
      const group = fly.querySelector<HTMLElement>('.setup-options')!;
      for (const [value, label] of [
        ['mouse', 'Mouse'],
        ['arrows', 'Arrow keys'],
      ] as const) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'setup-option';
        b.textContent = label;
        b.dataset.flyWith = value;
        b.setAttribute('role', 'radio');
        b.addEventListener('click', () => this.set({ flyWith: value }));
        group.append(b);
      }
      controls.prepend(fly);
    }

    el.querySelector('.setup-reset')!.addEventListener('click', () =>
      this.set({ ...DEFAULT_CAMERA }),
    );
    this.render();
  }

  private set(change: Partial<CameraSettings>): void {
    Object.assign(cameraSettings, change);
    this.onChange();
    this.render();
  }

  private render(): void {
    for (const s of SLIDERS) {
      const { input, value } = this.sliders.get(s.key)!;
      input.value = String(cameraSettings[s.key]);
      fillRange(input);
      value.textContent = s.format(cameraSettings[s.key]);
    }
    for (const b of document.querySelectorAll<HTMLElement>('[data-fly-with]')) {
      const on = b.dataset.flyWith === cameraSettings.flyWith;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-checked', String(on));
    }
    for (const b of this.el.querySelectorAll<HTMLElement>('[data-invert]')) {
      const on = b.dataset.invert === String(cameraSettings.invertY);
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
