import { ICONS } from './icons';
import { type Entry, GROUPS, keyLabel, type Registry } from './registry';

/** How long the button shows a toggle just switched by its key (ms). */
const FLASH_MS = 1400;

/** Groups whose toggles count as overlays (the button's "N on"). */
const OVERLAY_GROUPS = new Set(['labels', 'map']);

export interface QuickSettingsHooks {
  /** About to open: release the mouse (the HUD stays, the pause menu doesn't show). */
  opening(): void;
  /** Closed; `resume` (a key, ✕ or a click away) carries on playing. */
  closed(resume: boolean): void;
  /** On a touchscreen (no keys to show). */
  touch(): boolean;
}

/**
 * Quick settings (Tab, or the button under the minimap): the registry's `panel` entries,
 * grouped, in dark glass in the HUD's right rail below the minimap. Toggles are switches,
 * actions (map, drone, paraglider, snowmobile) rows that run and close. Anything the
 * game's mode or rules don't allow right now is greyed with the reason. The button itself
 * says how many overlays are on and, for a moment, what a key just switched.
 */
export class QuickSettings {
  private readonly rows = new Map<string, HTMLElement>();
  private readonly count: HTMLElement;
  private readonly headCount: HTMLElement;
  private readonly flash: HTMLElement;
  private flashTimer = 0;
  private refreshTimer = 0;
  /** Rendered above the groups (the presets, `ui/presets.ts`). */
  readonly top: HTMLElement;
  /** Called each time it opens (the hints: you've found it). */
  onOpen = () => {};

  constructor(
    private readonly button: HTMLButtonElement,
    readonly panel: HTMLElement,
    private readonly registry: Registry,
    private readonly hooks: QuickSettingsHooks,
  ) {
    button.innerHTML =
      `${ICONS.quick}<span class="qs-name">Quick settings</span>` +
      '<span class="qs-count"></span><kbd>Tab</kbd>' +
      '<span class="qs-flash" hidden><span></span><b></b></span>';
    this.count = button.querySelector('.qs-count')!;
    this.flash = button.querySelector('.qs-flash')!;
    button.addEventListener('click', () => this.toggle());

    panel.innerHTML =
      '<header class="qs-head"><b>Quick settings</b><span class="qs-on"></span>' +
      '<button class="qs-close" type="button" aria-label="Close">✕</button></header>' +
      '<div class="qs-top"></div><div class="qs-body"></div>';
    this.headCount = panel.querySelector('.qs-on')!;
    this.top = panel.querySelector('.qs-top')!;
    panel.querySelector('.qs-close')!.addEventListener('click', () => this.close(true));
    panel.tabIndex = -1;
    window.addEventListener('resize', () => this.fit());
    const body = panel.querySelector<HTMLElement>('.qs-body')!;
    for (const group of GROUPS) {
      const entries = registry.entries.filter((e) => e.panel && e.group === group.id);
      if (!entries.length) continue;
      const section = document.createElement('section');
      section.className = 'qs-group';
      section.dataset.group = group.id;
      const h = document.createElement('h4');
      h.textContent = group.label;
      section.append(h);
      for (const entry of entries) section.append(this.row(entry));
      body.append(section);
    }
    // Arrow keys move between the rows' controls; Space / Enter work them (buttons do).
    panel.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const all = [...panel.querySelectorAll<HTMLElement>('.qs-row button:not(:disabled)')];
      const i = all.indexOf(document.activeElement as HTMLElement);
      const next = all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length];
      next?.focus();
    });
    registry.subscribe((id, announce) => {
      this.refresh();
      if (id && announce && !this.isOpen) this.announce(id);
    });
    this.refresh();
  }

  get isOpen(): boolean {
    return !this.panel.hidden;
  }

  toggle(): void {
    if (this.isOpen) this.close(true);
    else this.open();
  }

  open(): void {
    if (this.isOpen) return;
    this.hooks.opening();
    this.panel.hidden = false;
    this.onOpen();
    this.button.setAttribute('aria-expanded', 'true');
    document.body.classList.add('quick-open');
    this.refresh();
    // What's allowed follows the mode (a lift, the drone), which can change while it's open.
    this.refreshTimer = window.setInterval(() => this.refresh(), 400);
    this.fit();
    // Focus the panel (not a switch: no ring until you move), so ↑ ↓ start from the top.
    if (!this.hooks.touch()) this.panel.focus({ preventScroll: true });
  }

  close(resume: boolean): void {
    if (!this.isOpen) return;
    this.panel.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('quick-open');
    clearInterval(this.refreshTimer);
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.hooks.closed(resume);
  }

  /**
   * End above the screen's bottom edge: its height is what's left below where it sits
   * (in the HUD's zoomed pixels). A bottom sheet (short landscape phones) sets its own.
   */
  fit(): void {
    if (!this.isOpen) return;
    this.panel.style.maxHeight = '';
    if (getComputedStyle(this.panel).position === 'fixed') return;
    const zoom = parseFloat(getComputedStyle(this.panel.closest('#hud > *')!).zoom) || 1;
    const top = this.panel.getBoundingClientRect().top;
    const room = (window.innerHeight - 20 - top) / zoom;
    this.panel.style.maxHeight = `${Math.max(160, Math.floor(room))}px`;
  }

  /** Every row's state, availability and the counts. */
  refresh(): void {
    let overlays = 0;
    for (const entry of this.registry.entries) {
      if (entry.kind === 'toggle' && entry.panel && OVERLAY_GROUPS.has(entry.group)) {
        if (this.registry.isOn(entry)) overlays++;
      }
    }
    const text = overlays ? `${overlays} on` : '';
    if (this.count.textContent !== text) this.count.textContent = text;
    this.headCount.textContent = text;
    if (!this.isOpen) return;
    for (const [id, row] of this.rows) {
      const entry = this.registry.get(id)!;
      const status = this.registry.status(entry);
      const on = this.registry.isOn(entry);
      const control = row.querySelector<HTMLButtonElement>('button')!;
      control.disabled = !status.enabled;
      row.classList.toggle('disabled', !status.enabled);
      row.setAttribute('aria-disabled', String(!status.enabled));
      row.querySelector('small')!.textContent = status.reason ?? entry.hint;
      if (entry.kind === 'toggle') control.setAttribute('aria-checked', String(on));
      else row.classList.toggle('active', on);
    }
  }

  /** The button says what a key just switched: "Peak names · ON". */
  private announce(id: string): void {
    const entry = this.registry.get(id);
    if (!entry || entry.kind !== 'toggle') return;
    const on = this.registry.isOn(entry);
    this.flash.querySelector('span')!.textContent = entry.label;
    const state = this.flash.querySelector('b')!;
    state.textContent = on ? 'On' : 'Off';
    state.classList.toggle('on', on);
    this.flash.hidden = false;
    this.button.classList.add('flashing');
    clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => {
      this.flash.hidden = true;
      this.button.classList.remove('flashing');
    }, FLASH_MS);
  }

  private row(entry: Entry): HTMLElement {
    const row = document.createElement('div');
    row.className = `qs-row qs-${entry.kind}`;
    row.dataset.id = entry.id;
    const key = entry.key ? `<kbd>${keyLabel(entry.key)}</kbd>` : '';
    const text = '<span class="qs-label"><span></span><small></small></span>';
    if (entry.kind === 'toggle') {
      row.innerHTML = `${ICONS[entry.icon]}${text}${key}<button class="switch" type="button" role="switch"></button>`;
      const sw = row.querySelector<HTMLButtonElement>('.switch')!;
      sw.setAttribute('aria-label', entry.label);
      sw.addEventListener('click', () => entry.run());
      // The whole row is a target (a switch alone is small for a thumb).
      row.addEventListener('click', (e) => {
        if (e.target !== sw && !sw.disabled) entry.run();
      });
    } else {
      // An action: the row is the button; it closes the panel and does it.
      row.innerHTML = `<button class="qs-action" type="button">${ICONS[entry.icon]}${text}${key}<i class="qs-dot"></i></button>`;
      row.querySelector('button')!.addEventListener('click', () => {
        this.close(true);
        entry.run();
      });
    }
    row.querySelector('.qs-label > span')!.textContent = entry.label;
    if (entry.touch === false) row.classList.add('desktop-only');
    this.rows.set(entry.id, row);
    return row;
  }
}
