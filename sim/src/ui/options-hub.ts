import { showModalOver } from './stacked';

/**
 * The options hub: one native `<dialog>` (light glass) with a tab per menu (camera,
 * display, controls, ski setup, time of day, multiplayer, credits). Each tab's panel is a
 * `<section class="hub-panel" id="…">` and its sidebar button carries `data-tab="<id>"`.
 * `showModal()` gives it a backdrop, keeps focus inside and closes on Esc; a click on the
 * backdrop or a `.hub-close` button closes it too.
 */
export class OptionsHub {
  private static readonly hubs = new WeakMap<HTMLDialogElement, OptionsHub>();
  private current: string | null = null;
  private readonly tabs: HTMLButtonElement[];
  /** Called after a tab is shown (e.g. to refresh what it displays). */
  readonly onShow = new Map<string, () => void>();

  /** The hub a panel belongs to (one per dialog). */
  static of(dialog: HTMLDialogElement): OptionsHub {
    let hub = OptionsHub.hubs.get(dialog);
    if (!hub) {
      hub = new OptionsHub(dialog);
      OptionsHub.hubs.set(dialog, hub);
    }
    return hub;
  }

  private constructor(readonly el: HTMLDialogElement) {
    this.tabs = [...el.querySelectorAll<HTMLButtonElement>('[data-tab]')];
    for (const tab of this.tabs) tab.addEventListener('click', () => this.show(tab.dataset.tab!));
    for (const button of el.querySelectorAll('.hub-close')) {
      button.addEventListener('click', () => this.close());
    }
    // The dialog box is padded by an inner card, so a click on the dialog itself is the backdrop.
    el.addEventListener('click', (e) => {
      if (e.target === el) this.close();
    });
    el.addEventListener('input', (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type === 'range') fillRange(e.target);
    });
    // Up/down move between tabs when the sidebar has focus.
    el.querySelector('.hub-tabs')?.addEventListener('keydown', (e) => {
      const key = (e as KeyboardEvent).key;
      if (key !== 'ArrowDown' && key !== 'ArrowUp') return;
      e.preventDefault();
      const open = this.tabs.filter((t) => !t.disabled);
      const i = open.findIndex((t) => t.dataset.tab === this.current);
      const next = open[(i + (key === 'ArrowDown' ? 1 : open.length - 1)) % open.length];
      if (next) {
        this.show(next.dataset.tab!);
        next.focus();
      }
    });
  }

  get isOpen(): boolean {
    return this.el.open;
  }

  /** The id of the tab on show (null if the hub is closed). */
  get active(): string | null {
    return this.el.open ? this.current : null;
  }

  show(id: string): void {
    this.current = id;
    for (const tab of this.tabs) {
      const on = tab.dataset.tab === id;
      tab.classList.toggle('on', on);
      tab.setAttribute('aria-selected', String(on));
    }
    for (const panel of this.el.querySelectorAll<HTMLElement>('.hub-panel')) {
      panel.hidden = panel.id !== id;
    }
    if (!this.el.open) showModalOver(this.el);
    // Focus follows the tab (showModal would focus the first one), so arrows carry on from it.
    this.tabs.find((t) => t.dataset.tab === id)?.focus();
    this.onShow.get(id)?.();
    for (const input of this.el.querySelectorAll<HTMLInputElement>(`#${id} input[type='range']`)) {
      fillRange(input);
    }
  }

  close(): void {
    if (this.el.open) this.el.close();
  }
}

/**
 * One tab of the options hub. Menus extend this: `open()` shows the hub on this tab,
 * `toggle()` (their hotkey) opens it or closes the hub if it's already on this tab, and
 * any `.modal-close` button in the panel closes the hub.
 */
export class OptionsTab {
  protected readonly hub: OptionsHub;

  constructor(readonly el: HTMLElement) {
    this.hub = OptionsHub.of(el.closest('dialog')!);
    for (const button of el.querySelectorAll('.modal-close')) {
      button.addEventListener('click', () => this.hub.close());
    }
  }

  get isOpen(): boolean {
    return this.hub.active === this.el.id;
  }

  open(): void {
    this.hub.show(this.el.id);
  }

  close(): void {
    if (this.isOpen) this.hub.close();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }
}

/** A range slider's filled part follows its value through `--fill` (theme.css). */
export function fillRange(input: HTMLInputElement): void {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const t = (Number(input.value) - min) / (max - min || 1);
  input.style.setProperty('--fill', `${(Math.min(1, Math.max(0, t)) * 100).toFixed(1)}%`);
}
