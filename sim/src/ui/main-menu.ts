import type { StartBase } from '../resort/manifest';
import { OptionsTab } from './options-hub';

export interface ResortEntry {
  id: string;
  name: string;
  country: string;
  bases?: string[];
  lifts?: number | null;
  pistes?: number | null;
}

/** `null` = carry on from where you are (or where you left off). */
export type StartChoice = StartBase | null;

export interface MenuHandlers {
  /** A ski area was highlighted: list its start points (`setStarts`). */
  onSelect: (resortId: string) => void;
  /** Load the highlighted ski area, starting at `choice` once it's ready. */
  onLoad: (resortId: string, choice: StartChoice) => void;
  /** The loaded area is ready and the player pressed Start (or Continue / Go to). */
  onPlay: (choice: StartChoice) => void;
}

const regions = new Intl.DisplayNames(['en'], { type: 'region' });
const countryName = (code: string) => (code ? (regions.of(code) ?? code) : '');

/**
 * The ski-sim main menu (light glass): a top bar with the ski areas and tools, and a card
 * with the highlighted area, its start points and the one button. Nothing heavy downloads
 * until you press Load. Shown at load and whenever the mouse is released (Esc), where it
 * becomes the pause menu: a small card (Resume, Map, Options…) until you ask to change the
 * area or start.
 *
 * The big button always says what it will do: choose an area, load it (with progress),
 * start skiing, or carry on.
 */
export class MainMenu {
  private choice: StartChoice = null;
  private readonly resortsEl: HTMLElement;
  private readonly startsEl: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly bar: HTMLElement;
  private resorts: ResortEntry[] = [];
  /** The highlighted ski area. */
  private selected: string | null = null;
  /** The ski area this page has loaded (or is loading). */
  private current: string | null = null;
  private phase: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  private started = false;
  /** Paused, but looking through the areas and start points rather than the pause card. */
  private browsing = false;
  private bases: StartBase[] = [];
  private browser!: HTMLElement;
  private search!: HTMLInputElement;
  readonly controls = new OptionsTab(document.querySelector<HTMLElement>('#opt-controls')!);

  constructor(
    private readonly root: HTMLElement,
    private readonly handlers: MenuHandlers,
  ) {
    this.resortsEl = root.querySelector('#menu-resorts')!;
    this.startsEl = root.querySelector('#menu-starts')!;
    this.button = root.querySelector('#start')!;
    this.status = root.querySelector('#status')!;
    this.bar = root.querySelector('#load-progress')!;
    root.querySelector('#open-controls')!.addEventListener('click', () => this.controls.open());
    this.button.addEventListener('click', () => this.press());
    root.querySelector('#resume')!.addEventListener('click', () => this.handlers.onPlay(null));
    root.querySelector('#pause-browse')!.addEventListener('click', () => {
      this.browsing = true;
      this.render();
    });
    this.browser = root.querySelector('#menu-browser')!;
    this.search = root.querySelector('#menu-search')!;
    root
      .querySelector('#menu-area')!
      .addEventListener('click', () => this.showBrowser(this.browser.hasAttribute('hidden')));
    root
      .querySelector('#menu-browser-close')!
      .addEventListener('click', () => this.showBrowser(false));
    this.search.addEventListener('input', () => this.filter());
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.showBrowser(false);
      if (e.key !== 'Enter') return;
      // Enter picks the first match.
      const first = [...this.resortsEl.children].find((c) => !(c as HTMLElement).hidden);
      (first as HTMLElement | undefined)?.click();
    });
    // Enter does what the big button (or Resume) says, unless a control has focus.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || document.body.classList.contains('flying')) return;
      if (document.querySelector('dialog[open]') || document.body.classList.contains('map-open'))
        return;
      if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLInputElement) return;
      if (this.isPaused) this.handlers.onPlay(null);
      else if (!this.button.disabled) this.press();
    });
    this.render();
  }

  /** The ski areas, with `selected` highlighted (null: none yet). */
  setResorts(resorts: ResortEntry[], selected: string | null): void {
    this.resorts = resorts;
    this.resortsEl.replaceChildren(
      ...[...resorts]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((r) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'menu-item';
          b.dataset.resort = r.id;
          const detail = [
            countryName(r.country),
            r.lifts ? `${r.lifts} lifts` : '',
            r.pistes ? `${r.pistes} pistes` : '',
          ]
            .filter(Boolean)
            .join(' · ');
          b.innerHTML =
            '<span class="menu-item-name"></span><span class="menu-item-detail"></span>';
          b.querySelector('.menu-item-name')!.textContent = r.name;
          b.querySelector('.menu-item-detail')!.textContent = detail;
          b.dataset.search = `${r.name} ${detail}`.toLowerCase();
          b.addEventListener('click', () => {
            this.selectResort(r.id);
            this.showBrowser(false);
          });
          b.addEventListener('dblclick', () => this.button.click());
          return b;
        }),
    );
    this.root.querySelector('#menu-resort-count')!.textContent = `· ${resorts.length}`;
    if (selected) this.selectResort(selected);
    else this.render();
  }

  /** The highlighted ski area (or null). */
  get selectedResort(): string | null {
    return this.selected;
  }

  /** Start locations for `resortId`, if it's still the highlighted one. */
  setStarts(
    resortId: string,
    bases: StartBase[],
    hasSavedPosition: boolean,
    preferred?: string | null,
  ): void {
    if (resortId !== this.selected) return;
    this.bases = bases;
    const here = this.started && resortId === this.current;
    const items: { label: string; detail: string; altitude: number | null; choice: StartChoice }[] =
      [];
    if (here || hasSavedPosition) {
      items.push({
        label: here ? 'Continue where you are' : 'Where you left off',
        detail: '',
        altitude: null,
        choice: null,
      });
    }
    for (const base of bases) {
      items.push({ label: base.name, detail: base.lift, altitude: base.ground, choice: base });
    }
    let number = 0;
    const buttons = items.map((item) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'menu-item';
      b.innerHTML =
        '<span class="menu-item-index"></span><span class="menu-item-name"></span>' +
        '<span class="menu-item-detail"></span><span class="menu-item-alt"></span>';
      b.querySelector('.menu-item-index')!.textContent = item.choice
        ? String(++number).padStart(2, '0')
        : '↺';
      b.querySelector('.menu-item-name')!.textContent = item.label;
      b.querySelector('.menu-item-detail')!.textContent = item.detail;
      b.querySelector('.menu-item-alt')!.textContent =
        item.altitude === null ? '' : `${Math.round(item.altitude).toLocaleString('en-GB')} m`;
      b.addEventListener('click', () => this.select(item.choice, b));
      b.addEventListener('dblclick', () => this.button.click());
      return b;
    });
    this.startsEl.replaceChildren(...buttons);
    this.root.querySelector('#menu-starts-count')!.textContent = bases.length
      ? `${bases.length} · lifts within 700 m`
      : '';
    this.renderStats();
    // Default: a start asked for by name, else carry on if there's somewhere to carry on
    // from, else the first village.
    const wanted = preferred ? items.findIndex((i) => i.choice?.name === preferred) : -1;
    const index = Math.max(wanted, 0);
    this.select(items[index]?.choice ?? null, buttons[index]);
  }

  /** The start points are on their way (or couldn't be read). */
  setStartsMessage(resortId: string, text: string): void {
    if (resortId !== this.selected) return;
    const p = document.createElement('p');
    p.className = 'menu-note';
    p.textContent = text;
    this.startsEl.replaceChildren(p);
  }

  /** This page is now loading `resortId`. */
  loading(resortId: string): void {
    this.current = resortId;
    this.phase = 'loading';
    this.progress('Starting…', 0);
  }

  /** Loading progress: what's happening and how far along (0-1). */
  progress(text: string, fraction: number): void {
    if (this.phase !== 'loading') return;
    this.status.textContent = text;
    this.status.classList.remove('error');
    this.bar.querySelector('i')!.style.width = `${Math.round(fraction * 100)}%`;
    this.render();
  }

  /** The loaded area is drawn and you can play. */
  ready(): void {
    this.phase = 'ready';
    document.body.classList.add('world');
    this.render();
  }

  /** Loading failed: say why; the button retries. */
  failed(message: string): void {
    this.phase = 'error';
    this.render();
    this.status.textContent = message;
    this.status.classList.add('error');
  }

  /** Playing: next time the menu opens, it's the pause card again. */
  resumed(): void {
    this.browsing = false;
    this.render();
  }

  /** Showing the small pause card (playing, paused, not browsing areas). */
  get isPaused(): boolean {
    return this.started && this.phase === 'ready' && !this.browsing;
  }

  private name(id: string | null): string {
    return this.resorts.find((r) => r.id === id)?.name ?? id ?? '';
  }

  private selectResort(id: string): void {
    this.selected = id;
    for (const child of this.resortsEl.children) {
      child.classList.toggle('selected', (child as HTMLElement).dataset.resort === id);
    }
    this.bases = [];
    this.choice = null;
    this.root.querySelector('#menu-starts-count')!.textContent = '';
    this.setStartsMessage(id, 'Finding start points…');
    this.renderStats();
    this.render();
    this.handlers.onSelect(id);
  }

  /** The highlighted area's name, country and numbers. */
  /** The ski area list: a searchable panel beside the card (it scales to many areas). */
  private showBrowser(open: boolean): void {
    this.browser.hidden = !open;
    this.root.querySelector('#menu-area')!.setAttribute('aria-expanded', String(open));
    if (!open) return;
    this.search.value = '';
    this.filter();
    this.search.focus();
    this.resortsEl.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  }

  private filter(): void {
    const words = this.search.value.toLowerCase().split(/\s+/).filter(Boolean);
    for (const child of this.resortsEl.children) {
      const text = (child as HTMLElement).dataset.search ?? '';
      (child as HTMLElement).hidden = !words.every((w) => text.includes(w));
    }
  }

  private renderStats(): void {
    const r = this.resorts.find((x) => x.id === this.selected);
    this.root.querySelector('#menu-title')!.textContent = r?.name ?? 'ski-sim';
    this.root.querySelector('#menu-kicker')!.textContent = r ? countryName(r.country) : '';
    const tiles: [string, string][] = [
      ['Lifts', r?.lifts ? String(r.lifts) : '–'],
      ['Runs', r?.pistes ? String(r.pistes) : '–'],
      ['Starts', this.bases.length ? String(this.bases.length) : '–'],
    ];
    if (this.bases.length) {
      const top = Math.max(...this.bases.map((b) => b.ground));
      tiles.push([
        'Top start',
        `${Math.round(top).toLocaleString('en-GB')}<span class="unit">m</span>`,
      ]);
    }
    this.root.querySelector('#menu-stats')!.innerHTML = tiles
      .map(([k, v]) => `<div><span class="lab">${k}</span><b>${v}</b></div>`)
      .join('');
  }

  private press(): void {
    const id = this.selected;
    if (!id) return;
    if (id !== this.current) {
      this.handlers.onLoad(id, this.choice);
    } else if (this.phase === 'error') {
      location.reload();
    } else if (this.phase === 'ready') {
      const choice = this.choice;
      this.started = true;
      // Next time the menu opens (Esc), default to carrying on from where you are.
      this.setStarts(id, this.bases, true);
      this.handlers.onPlay(choice);
    }
    this.render();
  }

  /** The button, progress bar, status and layout always agree with the state. */
  private render(): void {
    const b = this.button;
    const id = this.selected;
    const here = id !== null && id === this.current;
    const loadingHere = here && this.phase === 'loading';
    this.bar.hidden = !loadingHere;
    b.classList.toggle('loading', loadingHere);
    if (!id) {
      b.disabled = true;
      b.textContent = 'Choose a ski area';
    } else if (!here) {
      b.disabled = false;
      b.textContent = this.current ? `Switch to ${this.name(id)}` : `Load ${this.name(id)}`;
    } else if (this.phase === 'loading') {
      b.disabled = true;
      b.textContent = `Loading ${this.name(id)}…`;
    } else if (this.phase === 'error') {
      b.disabled = false;
      b.textContent = 'Try again';
    } else {
      b.disabled = false;
      b.textContent = !this.started
        ? 'Start skiing'
        : this.choice
          ? `Go to ${this.choice.name}`
          : 'Continue';
    }
    if (this.phase !== 'loading' && this.phase !== 'error') {
      this.status.classList.remove('error');
      this.status.textContent =
        this.phase === 'ready' && here
          ? this.started
            ? `Paused · ${this.name(id)}`
            : `${this.name(id)} is ready`
          : this.current && !here
            ? `Switching leaves ${this.name(this.current)}`
            : id
              ? 'Pick where to start, then load the map'
              : 'Pick a ski area';
    }
    this.root.classList.toggle('paused', this.isPaused);
    this.root.querySelector('#pause-title')!.textContent = this.name(this.current);
    // Menus that need a world (time of day, multiplayer) wait for one.
    for (const el of document.querySelectorAll<HTMLButtonElement>('[data-needs-map]')) {
      el.disabled = this.phase !== 'ready';
      el.title = el.disabled ? 'Load a ski area first' : '';
    }
  }

  private select(choice: StartChoice, el?: HTMLElement): void {
    this.choice = choice;
    for (const child of this.startsEl.children) child.classList.toggle('selected', child === el);
    this.render();
  }
}

export const LAST_RESORT_KEY = 'ski-sim.resort';
