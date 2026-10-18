import type { StartBase } from '../resort/manifest';

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

/**
 * The ski-sim main menu: pick a ski area, then where to start, then play. Shown at load
 * and whenever the mouse is released (Esc), where it doubles as the pause menu.
 */
export class MainMenu {
  private choice: StartChoice = null;
  private readonly resortsEl: HTMLElement;
  private readonly startsEl: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly status: HTMLElement;
  private started = false;
  private bases: StartBase[] = [];
  private hasSaved = false;

  constructor(
    root: HTMLElement,
    private readonly onPlay: (choice: StartChoice) => void,
  ) {
    this.resortsEl = root.querySelector('#menu-resorts')!;
    this.startsEl = root.querySelector('#menu-starts')!;
    this.button = root.querySelector('#start')!;
    this.status = root.querySelector('#status')!;
    this.button.addEventListener('click', () => {
      const choice = this.choice;
      this.started = true;
      // Next time the menu opens (Esc), default to carrying on from where you are.
      this.setStarts(this.bases, true);
      this.button.textContent = 'Continue';
      this.onPlay(choice);
    });
  }

  setStatus(text: string, error = false): void {
    this.status.textContent = text;
    this.status.classList.toggle('error', error);
  }

  /** Ski areas; choosing another reloads with it. */
  setResorts(resorts: ResortEntry[], current: string): void {
    this.resortsEl.replaceChildren(
      ...resorts.map((r) => {
        const b = document.createElement('button');
        b.className = 'menu-item';
        b.classList.toggle('selected', r.id === current);
        const detail = [
          r.country ? (new Intl.DisplayNames(['en'], { type: 'region' }).of(r.country) ?? '') : '',
          r.lifts ? `${r.lifts} lifts` : '',
          r.pistes ? `${r.pistes} pistes` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        b.innerHTML = '<span class="menu-item-name"></span><span class="menu-item-detail"></span>';
        b.querySelector('.menu-item-name')!.textContent = r.name;
        b.querySelector('.menu-item-detail')!.textContent = detail;
        b.addEventListener('click', () => {
          if (r.id === current) return;
          localStorage.setItem(LAST_RESORT_KEY, r.id);
          const url = new URL(location.href);
          url.search = `?resort=${encodeURIComponent(r.id)}`;
          location.href = url.toString();
        });
        return b;
      }),
    );
  }

  /** Start locations for the loaded resort. */
  setStarts(bases: StartBase[], hasSavedPosition: boolean): void {
    this.bases = bases;
    this.hasSaved = hasSavedPosition;
    const items: { label: string; detail: string; choice: StartChoice }[] = [];
    if (hasSavedPosition) {
      items.push({
        label: this.started ? 'Continue where you are' : 'Where you left off',
        detail: '',
        choice: null,
      });
    }
    for (const base of bases) {
      items.push({ label: base.name, detail: `by the ${base.lift} lift`, choice: base });
    }
    this.startsEl.replaceChildren(
      ...items.map((item) => {
        const b = document.createElement('button');
        b.className = 'menu-item';
        b.innerHTML = '<span class="menu-item-name"></span><span class="menu-item-detail"></span>';
        b.querySelector('.menu-item-name')!.textContent = item.label;
        b.querySelector('.menu-item-detail')!.textContent = item.detail;
        b.addEventListener('click', () => this.select(item.choice, b));
        b.addEventListener('dblclick', () => this.button.click());
        return b;
      }),
    );
    // Default: carry on if there's somewhere to carry on from, else the first village.
    const first = this.startsEl.firstElementChild as HTMLElement | null;
    this.select(items[0]?.choice ?? null, first ?? undefined);
  }

  ready(): void {
    void this.hasSaved;
    this.button.disabled = false;
    this.button.textContent = this.started ? 'Continue' : 'Start skiing';
  }

  private select(choice: StartChoice, el?: HTMLElement): void {
    this.choice = choice;
    const target =
      el ?? (choice === null ? (this.startsEl.firstElementChild as HTMLElement | null) : null);
    for (const child of this.startsEl.children)
      child.classList.toggle('selected', child === target);
    if (this.started) {
      this.button.textContent = choice ? `Go to ${choice.name}` : 'Continue';
    }
  }
}

export const LAST_RESORT_KEY = 'ski-sim.resort';
