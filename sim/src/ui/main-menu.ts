import { type Extent, resortUrl, type StartBase } from '../resort/manifest';
import { OptionsTab } from './options-hub';
import {
  frameStarts,
  pinAt,
  SCREEN_NAMES,
  type ScreenId,
  ScreenStack,
  startsAspect,
} from './screens';
import { showModalOver } from './stacked';

export interface ResortEntry {
  id: string;
  name: string;
  /** The main country; `countries` is every one the area spans (older indexes: none). */
  country: string;
  countries?: string[];
  bases?: string[];
  lifts?: number | null;
  pistes?: number | null;
}

/** `null` = carry on from where you are (or where you left off). */
export type StartChoice = StartBase | null;

export interface MenuHandlers {
  /** A ski area was highlighted: fetch its start points (`setStarts`). */
  onSelect: (resortId: string) => void;
  /** Load a ski area (a fresh page if one's already loaded), starting at `choice`. */
  onLoad: (resortId: string, choice: StartChoice, options: { host: boolean }) => void;
  /**
   * The loaded area is ready and you pressed Start (or Resume, or picked a new start);
   * `auto` when it's just finished loading (no tap or click to start with).
   */
  onPlay: (choice: StartChoice, auto?: boolean) => void;
  /** Said when leaving for another area, about your party ("Your party comes with you"). */
  leaveNote?: () => string | null;
}

/** A menu screen something else opens and closes (the Multiplayer screen). */
export interface ScreenControl {
  open(): void;
  close(): void;
  isOpen(): boolean;
}

const regions = new Intl.DisplayNames(['en'], { type: 'region' });
const countryName = (code: string) => (code ? (regions.of(code) ?? code) : '');
/** Every country a ski area spans, main one first. */
export const countriesOf = (r: Pick<ResortEntry, 'country' | 'countries'>) =>
  r.countries?.length ? r.countries : r.country ? [r.country] : [];
/** A country's flag: the emoji made of its two regional-indicator letters. */
export const flag = (code: string) =>
  /^[A-Za-z]{2}$/.test(code)
    ? String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65))
    : '';
/** "🇫🇷 🇨🇭 France · Switzerland" */
export const countriesLabel = (r: Pick<ResortEntry, 'country' | 'countries'>) => {
  const codes = countriesOf(r);
  return codes.length ? `${codes.map(flag).join(' ')} ${codes.map(countryName).join(' · ')}` : '';
};
const metres = (m: number) => `${Math.round(m).toLocaleString('en-GB')} m`;

const TIPS = [
  'M opens the map: right click anywhere to go there.',
  'Ctrl tucks; Shift ploughs; S with A or D is a hockey stop.',
  'F flies a drone while your skier waits; F again goes back to your skier.',
  'E at a lift’s bottom station rides it; hold W to fast-forward.',
  'H hides everything for full immersion.',
  'P opens a paraglider, even mid-air; B brings a snowmobile.',
];
const TOUCH_TIPS = [
  'Left thumb steers: push forward to skate, pull back to snowplough.',
  'Drag on the right half of the screen to look around.',
  'On the map, touch and hold anywhere to go there.',
  'Hold Stop and flick the stick left or right: a hockey stop that way.',
  'The paraglider opens even mid-air; the snowmobile comes to you.',
];

/**
 * The menus (light glass), one screen at a time:
 *   Title → Resorts → Resort (start points) → Loading → skiing; Esc in game → Pause.
 * Esc or the ← in the corner goes back one screen (`ScreenStack`). Nothing heavy downloads
 * until you choose where to ski, unless the link names a resort or a game.
 */
export class MainMenu {
  readonly controls = new OptionsTab(document.querySelector<HTMLElement>('#opt-controls')!);
  private readonly screens = new ScreenStack('title');
  private readonly $ = <T extends HTMLElement = HTMLElement>(s: string) =>
    this.root.querySelector<T>(s)!;
  private resorts: ResortEntry[] = [];
  /** The highlighted ski area (Resorts and Resort screens). */
  private selected: string | null = null;
  /** The ski area this page has loaded (or is loading). */
  private current: string | null = null;
  private phase: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  private started = false;
  /** Why moving to a start point in the loaded area isn't allowed (the rules), or null. */
  private teleportOff: string | null = null;
  /** The start picked on the Resort screen. */
  private choice: StartChoice = null;
  /** The start to use when the loading area is ready. */
  private loadChoice: StartChoice = null;
  private bases: StartBase[] = [];
  private extent: Extent | null = null;
  private hasSaved = false;
  /** Pressed "Host a game" before choosing a resort. */
  private hosting = false;
  private continueTo: string | null = null;
  private unlockedAt = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly handlers: MenuHandlers,
  ) {
    const on = (s: string, f: () => void) => this.$(s).addEventListener('click', f);
    on('#menu-back', () => this.back());
    on('#title-continue', () => this.continueGame());
    on('#continue-card', () => this.continueGame());
    on('#title-play', () => this.go('resorts'));
    on('#open-controls', () => this.controls.open());
    on('#choose-start', () => this.go('resort'));
    on('#ski-from', () => void this.skiFrom());
    on('#start', () => this.start());
    on('#resume', () => this.handlers.onPlay(null));
    on('#pause-start', () => {
      if (this.current) this.selectResort(this.current);
      this.go('resort');
    });
    on('#pause-resort', () => this.go('resorts'));
    on('#pause-quit', () => void this.quit());
    this.$('#menu-search').addEventListener('input', () => this.filter());
    this.$('#menu-country').addEventListener('change', () => this.filter());
    document.addEventListener('pointerlockchange', () => {
      if (!document.pointerLockElement) this.unlockedAt = performance.now();
    });
    document.addEventListener('keydown', (e) => this.key(e));
    this.render();
  }

  /** The Multiplayer screen, for the multiplayer menu to open and close. */
  readonly multiplayer: ScreenControl = {
    open: () => this.go('multiplayer'),
    close: () => {
      if (this.screens.current === 'multiplayer') this.back();
    },
    isOpen: () => this.visible && this.screens.current === 'multiplayer',
  };

  /** Host a game before any map's loaded: choose where first. */
  hostFromResort(): void {
    this.hosting = true;
    this.go('resorts');
  }

  /** The ski areas, with `selected` highlighted (null: none yet). */
  setResorts(resorts: ResortEntry[], selected: string | null): void {
    this.resorts = [...resorts].sort((a, b) => a.name.localeCompare(b.name));
    const countries = [...new Set(this.resorts.flatMap(countriesOf))].sort((a, b) =>
      countryName(a).localeCompare(countryName(b)),
    );
    const select = this.$<HTMLSelectElement>('#menu-country');
    select.replaceChildren(
      new Option('All countries', ''),
      ...countries.map((c) => new Option(`${flag(c)} ${countryName(c)}`, c)),
    );
    this.$('#menu-resorts').replaceChildren(
      ...this.resorts.map((r) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'resort-card';
        b.dataset.resort = r.id;
        b.dataset.countries = countriesOf(r).join(' ');
        b.dataset.search =
          `${r.name} ${countriesOf(r).map(countryName).join(' ')} ${(r.bases ?? []).join(' ')}`.toLowerCase();
        b.innerHTML =
          '<span class="resort-thumb"><img loading="lazy" alt="" /></span>' +
          '<span class="menu-item-name"></span><span class="menu-item-detail"></span>';
        const img = b.querySelector('img')!;
        img.src = resortUrl(r.id, 'preview.jpg');
        img.addEventListener('error', () => img.remove());
        b.querySelector('.menu-item-name')!.textContent = r.name;
        b.querySelector('.menu-item-detail')!.textContent = detailOf(r);
        b.addEventListener('click', () => this.selectResort(r.id));
        b.addEventListener('dblclick', () => this.go('resort'));
        return b;
      }),
    );
    this.filter();
    if (selected) this.selectResort(selected);
    else this.render();
  }

  /** The last area played, offered as Continue on the title screen (null: first visit). */
  setContinue(resortId: string | null, detail: string): void {
    this.continueTo = resortId;
    const card = this.$('#continue-card');
    card.hidden = !resortId;
    this.$('#title-continue').hidden = !resortId;
    if (resortId) {
      card.querySelector('b')!.textContent = this.name(resortId);
      card.querySelector('small')!.textContent = detail;
      const img = card.querySelector('img')!;
      img.src = resortUrl(resortId, 'preview.jpg');
      img.onerror = () => (img.style.visibility = 'hidden');
    }
    // Returning: Continue leads, choosing a resort is second; first visit: Play.
    const play = this.$('#title-play');
    play.textContent = resortId ? 'Choose a resort' : 'Play';
    play.classList.toggle('btn-primary', !resortId);
    this.$('#open-ski-setup').hidden = !!resortId; // in Options for returning players
  }

  /** The highlighted ski area (or null). */
  get selectedResort(): string | null {
    return this.selected;
  }

  /** Start points (and the map's extent) for `resortId`, if it's still highlighted. */
  setStarts(
    resortId: string,
    bases: StartBase[],
    hasSavedPosition: boolean,
    extent: Extent,
    preferred?: string | null,
  ): void {
    if (resortId !== this.selected) return;
    this.bases = [...bases].sort((a, b) => b.ground - a.ground);
    this.extent = extent;
    this.hasSaved = hasSavedPosition;
    const wanted = preferred ? this.bases.find((b) => b.name === preferred) : undefined;
    // Default: a start asked for by name, else where you left off, else the highest village.
    this.choice = wanted ?? (this.offersSaved ? null : (this.bases[0] ?? null));
    this.renderPreview();
    this.renderStarts();
  }

  /** The start points couldn't be read. */
  setStartsMessage(resortId: string, text: string): void {
    if (resortId !== this.selected) return;
    this.$('#menu-villages').textContent = text;
  }

  /** This page is now loading `resortId` (straight away from a link, or chosen). */
  loading(resortId: string): void {
    this.current = resortId;
    this.phase = 'loading';
    this.screens.reset('loading');
    const where = this.loadChoice?.name ?? (this.hasSaved ? 'Where you left off' : 'Resort start');
    this.$('#loading-where').textContent = `${this.name(resortId)} · ${where}`;
    const tips = document.body.classList.contains('touch') ? TOUCH_TIPS : TIPS;
    this.$('.loading-tip').textContent = `Tip · ${tips[Math.floor(Math.random() * tips.length)]}`;
    this.progress('Starting…', 0);
    this.render();
  }

  /** The start to use once loaded (set before `loading` from a link's `start=`). */
  setLoadChoice(choice: StartChoice): void {
    this.loadChoice = choice;
  }

  /** Loading progress: what's happening and how far along (0-1). */
  progress(text: string, fraction: number): void {
    if (this.phase !== 'loading') return;
    const status = this.$('#status');
    status.textContent = text;
    status.classList.remove('error');
    this.$('#load-progress i').style.width = `${Math.round(fraction * 100)}%`;
  }

  /** The loaded area is drawn: straight into it (the first click captures the mouse). */
  ready(): void {
    this.phase = 'ready';
    document.body.classList.add('world');
    this.start(true);
  }

  /** Loading failed: say why; the button tries again. */
  failed(message: string): void {
    this.phase = 'error';
    this.screens.reset('loading');
    const status = this.$('#status');
    status.textContent = message;
    status.classList.add('error');
    this.render();
  }

  /** Playing (the mouse is captured): next time the menu shows, it's the pause menu. */
  resumed(): void {
    this.screens.reset('pause');
    const confirm = this.$<HTMLDialogElement>('#confirm');
    if (confirm.open) confirm.close('stay');
    this.render();
  }

  /**
   * Teleporting is off under the game's rules (`off` says so) or on (null): once you're in
   * an area, its start points are teleports, so they aren't offered.
   */
  setTeleport(off: string | null): void {
    this.teleportOff = off;
    const change = this.$<HTMLButtonElement>('#pause-start');
    change.disabled = !!off;
    change.title = off ?? '';
    this.render();
  }

  /** A line on the pause menu (e.g. the game code when hosting); null hides it. */
  setPauseNote(text: string | null): void {
    const note = this.$('#pause-host');
    note.hidden = !text;
    note.textContent = text ?? '';
  }

  /** On the pause menu (playing, mouse released). */
  get isPaused(): boolean {
    return this.started && this.screens.current === 'pause';
  }

  private get visible(): boolean {
    return !['flying', 'map-open', 'entering'].some((c) => document.body.classList.contains(c));
  }

  /** "Where you left off" makes sense only when you aren't already skiing there. */
  private get offersSaved(): boolean {
    return this.hasSaved && !(this.started && this.selected === this.current);
  }

  private name(id: string | null): string {
    return this.resorts.find((r) => r.id === id)?.name ?? id ?? '';
  }

  private go(id: ScreenId): void {
    if (id === 'title') this.hosting = false;
    this.screens.push(id);
    this.render();
    if (id === 'resort') requestAnimationFrame(() => this.renderMap());
    if (id === 'resorts') {
      const search = this.$<HTMLInputElement>('#menu-search');
      search.focus();
      this.$('#menu-resorts .selected')?.scrollIntoView({ block: 'nearest' });
    }
  }

  private back(): void {
    // Loading can't be backed out of mid-way: Cancel goes back to a fresh menu.
    if (this.screens.current === 'loading') {
      location.href = location.pathname;
      return;
    }
    if (this.screens.back()) {
      if (this.screens.current === 'title') this.hosting = false;
      this.render();
    }
  }

  private continueGame(): void {
    if (!this.continueTo) return;
    this.selected = this.continueTo;
    this.loadChoice = null;
    this.hasSaved = true;
    this.handlers.onLoad(this.continueTo, null, { host: false });
  }

  private selectResort(id: string): void {
    if (id !== this.selected) {
      this.bases = [];
      this.extent = null;
      this.choice = null;
    }
    this.selected = id;
    for (const card of this.$('#menu-resorts').children) {
      card.classList.toggle('selected', (card as HTMLElement).dataset.resort === id);
    }
    this.renderPreview();
    this.renderStarts();
    this.handlers.onSelect(id);
  }

  private filter(): void {
    const words = this.$<HTMLInputElement>('#menu-search').value.toLowerCase().split(/\s+/);
    const country = this.$<HTMLSelectElement>('#menu-country').value;
    let shown = 0;
    for (const card of this.$('#menu-resorts').children) {
      const el = card as HTMLElement;
      el.hidden =
        (!!country && !(el.dataset.countries ?? '').split(' ').includes(country)) ||
        !words.every((w) => (el.dataset.search ?? '').includes(w));
      if (!el.hidden) shown++;
    }
    this.$('#menu-resort-count').textContent =
      shown === this.resorts.length
        ? `${this.resorts.length} ski areas`
        : `${shown} of ${this.resorts.length} ski areas`;
  }

  /** The Resorts screen's right-hand panel: the highlighted area. */
  private renderPreview(): void {
    const r = this.resorts.find((x) => x.id === this.selected);
    this.$('#menu-title').textContent = r?.name ?? '';
    this.$('#menu-kicker').textContent = r ? countriesLabel(r) : '';
    const img = this.$<HTMLImageElement>('#menu-preview');
    if (r) {
      img.style.visibility = '';
      img.onerror = () => (img.style.visibility = 'hidden');
      const src = resortUrl(r.id, 'preview.jpg');
      if (img.getAttribute('src') !== src) img.src = src;
    }
    const tiles: [string, string][] = [
      ['Lifts', r?.lifts ? String(r.lifts) : '–'],
      ['Runs', r?.pistes ? String(r.pistes) : '–'],
      ['Starts', this.bases.length ? String(this.bases.length) : '–'],
    ];
    if (this.bases.length) {
      tiles.push([
        'Top start',
        `${Math.round(this.bases[0]!.ground).toLocaleString('en-GB')}<span class="unit">m</span>`,
      ]);
    }
    this.$('#menu-stats').innerHTML = tiles
      .map(([k, v]) => `<div><span class="lab">${k}</span><b>${v}</b></div>`)
      .join('');
    const villages = this.bases.map((b) => b.name);
    this.$('#menu-villages').textContent = villages.length
      ? `${villages.slice(0, 6).join(' · ')}${villages.length > 6 ? ` · +${villages.length - 6} more` : ''}`
      : r && !r.bases?.length
        ? 'No start villages: you start at the resort’s viewpoint.'
        : 'Finding start points…';
  }

  /** The Resort screen: the start list beside the map with a pin for each. */
  private renderStarts(): void {
    const r = this.resorts.find((x) => x.id === this.selected);
    this.$('#resort-title').textContent = r?.name ?? '';
    this.$('#resort-kicker').textContent = r ? countriesLabel(r) : '';
    this.$('#menu-starts-count').textContent = this.bases.length ? String(this.bases.length) : '';
    const items: { label: string; detail: string; altitude: number | null; choice: StartChoice }[] =
      [];
    if (this.offersSaved || !this.bases.length) {
      items.push({
        label: this.bases.length ? 'Where you left off' : 'Resort start',
        detail: '',
        altitude: null,
        choice: null,
      });
    }
    for (const b of this.bases) {
      items.push({ label: b.name, detail: b.lift, altitude: b.ground, choice: b });
    }
    this.$('#menu-starts').replaceChildren(
      ...items.map((item) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'menu-item';
        b.classList.toggle('selected', item.choice === this.choice);
        b.innerHTML =
          '<span class="menu-item-name"></span><span class="menu-item-detail"></span><span class="menu-item-alt"></span>';
        b.querySelector('.menu-item-name')!.textContent = item.label;
        b.querySelector('.menu-item-detail')!.textContent = item.detail;
        b.querySelector('.menu-item-alt')!.textContent =
          item.altitude === null ? '' : metres(item.altitude);
        b.addEventListener('click', () => this.pick(item.choice));
        b.addEventListener('dblclick', () => void this.skiFrom());
        return b;
      }),
    );
    this.renderMap();
    this.render();
  }

  /** The preview map, framed on the start points, with a pin for each. */
  private renderMap(): void {
    const view = this.$('.starts-view');
    const img = this.$<HTMLImageElement>('#starts-map-img');
    const pins = this.$('#starts-pins');
    const extent = this.extent;
    if (!this.selected || !extent) {
      pins.replaceChildren();
      img.style.visibility = 'hidden';
      return;
    }
    const src = resortUrl(this.selected, 'preview.jpg');
    if (img.getAttribute('src') !== src) {
      img.src = src;
      img.style.visibility = '';
      img.onerror = () => (img.style.visibility = 'hidden');
    }
    // The map panel takes the shape of the area the starts cover, then frames them.
    this.$('.starts-map').style.aspectRatio = String(startsAspect(extent, this.bases));
    const aspect = view.clientWidth / Math.max(1, view.clientHeight) || 1;
    const frame = frameStarts(extent, this.bases, aspect);
    img.style.left = `${frame.left * 100}%`;
    img.style.top = `${frame.top * 100}%`;
    img.style.width = `${frame.width * 100}%`;
    img.style.height = `${frame.height * 100}%`;
    pins.replaceChildren(
      ...this.bases.map((b) => {
        const { x, y } = pinAt(extent, frame, b);
        const pin = document.createElement('button');
        pin.type = 'button';
        pin.className = 'start-pin';
        pin.classList.toggle('selected', b === this.choice);
        pin.style.left = `${x * 100}%`;
        pin.classList.toggle('flip', x > 0.6); // label to the left near the right edge
        pin.style.top = `${y * 100}%`;
        pin.innerHTML = '<i></i><span></span>';
        pin.querySelector('span')!.textContent = b.name;
        pin.title = `${b.name} · ${metres(b.ground)}`;
        pin.addEventListener('click', () => this.pick(b));
        pin.addEventListener('dblclick', () => void this.skiFrom());
        return pin;
      }),
    );
  }

  private pick(choice: StartChoice): void {
    this.choice = choice;
    this.renderStarts();
  }

  /** The Resort screen's button: go there now, or load the area there. */
  private async skiFrom(): Promise<void> {
    const id = this.selected;
    if (!id) return;
    if (this.started && id === this.current) {
      if (this.choice && this.teleportOff) return;
      this.handlers.onPlay(this.choice); // already here: just move
      return;
    }
    if (this.current && id !== this.current) {
      const note = this.handlers.leaveNote?.();
      const leave = await this.confirm(
        `Leave ${this.name(this.current)}?`,
        `${this.name(id)} loads in its place. Your position here is saved.${note ? ` ${note}` : ''}`,
      );
      if (!leave) return;
    }
    this.loadChoice = this.choice;
    this.handlers.onLoad(id, this.choice, { host: this.hosting });
  }

  /** Into the world once it's ready (or, after an error, the button tries again). */
  private start(auto = false): void {
    if (this.phase === 'error') {
      location.reload();
      return;
    }
    if (this.phase !== 'ready') return;
    this.started = true;
    this.screens.reset('pause');
    this.render();
    this.handlers.onPlay(this.loadChoice, auto);
  }

  private async quit(): Promise<void> {
    const leave = await this.confirm(
      `Leave ${this.name(this.current)}?`,
      'You’ll go back to the main menu. Your position is saved.',
    );
    if (leave) location.href = location.pathname;
  }

  private confirm(title: string, text: string): Promise<boolean> {
    const dialog = this.$<HTMLDialogElement>('#confirm');
    dialog.querySelector('h2')!.textContent = title;
    dialog.querySelector('p')!.textContent = text;
    dialog.returnValue = '';
    showModalOver(dialog);
    return new Promise((resolve) =>
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'leave'), {
        once: true,
      }),
    );
  }

  /** Esc goes back; Enter does the screen's main action. */
  private key(e: KeyboardEvent): void {
    if (!this.visible || document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape') {
      // The Esc that released the mouse also arrives here: it isn't a "back".
      if (performance.now() - this.unlockedAt < 400) return;
      const search = this.$<HTMLInputElement>('#menu-search');
      if (e.target === search && search.value) return; // the field clears itself
      e.preventDefault();
      this.back();
      return;
    }
    if (e.key !== 'Enter') return;
    if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLSelectElement) return;
    const s = this.screens.current;
    if (s === 'title') {
      if (this.continueTo) this.continueGame();
      else this.go('resorts');
    } else if (s === 'resorts') {
      // In the search box, Enter picks the first match.
      const first = [...this.$('#menu-resorts').children].find((c) => !(c as HTMLElement).hidden);
      if (e.target instanceof HTMLInputElement && first)
        this.selectResort((first as HTMLElement).dataset.resort!);
      if (this.selected) this.go('resort');
    } else if (s === 'resort') void this.skiFrom();
    else if (s === 'loading') this.start();
    else if (s === 'pause') this.handlers.onPlay(null);
    else return;
    e.preventDefault();
  }

  /** Show the screen on top, its ← and buttons in agreement with the state. */
  private render(): void {
    const current = this.screens.current;
    this.root.dataset.screen = current;
    for (const s of this.root.querySelectorAll<HTMLElement>('.screen')) {
      s.hidden = s.dataset.screen !== current;
    }
    const back = this.$('#menu-back');
    const previous = this.screens.previous;
    back.hidden = current === 'loading' ? this.phase === 'ready' : !previous;
    back.querySelector('.crumb-to')!.textContent =
      current === 'loading' ? 'Cancel' : previous ? SCREEN_NAMES[previous] : '';

    // Resort screen's button says exactly what it'll do.
    const where =
      this.choice?.name ?? (this.bases.length ? 'where you left off' : 'the resort start');
    const here = this.started && this.selected === this.current;
    const skiFrom = this.$<HTMLButtonElement>('#ski-from');
    skiFrom.textContent = here
      ? this.choice
        ? (this.teleportOff ?? `Go to ${this.choice.name}`)
        : 'Back to where you were'
      : `${this.hosting ? 'Host from' : 'Ski from'} ${where}`;
    skiFrom.disabled = here && !!this.choice && !!this.teleportOff;
    this.$<HTMLButtonElement>('#choose-start').disabled = !this.selected;

    const start = this.$<HTMLButtonElement>('#start');
    start.hidden = this.phase !== 'error';
    start.textContent = 'Try again';
    this.$('#load-progress').hidden = this.phase === 'error';
    this.$('#pause-title').textContent = this.name(this.current);

    // Menus that need a world (time of day) wait for one.
    for (const el of document.querySelectorAll<HTMLButtonElement>('[data-needs-map]')) {
      el.disabled = this.phase !== 'ready';
      el.title = el.disabled ? 'Load a ski area first' : '';
    }
  }
}

function detailOf(r: ResortEntry): string {
  return [countriesLabel(r), r.lifts ? `${r.lifts} lifts` : '', r.pistes ? `${r.pistes} runs` : '']
    .filter(Boolean)
    .join(' · ');
}

export const LAST_RESORT_KEY = 'ski-sim.resort';
