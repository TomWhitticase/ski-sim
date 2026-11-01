import { ICONS } from './icons';
import { type Entry, GROUPS, keyLabel, type Registry, search } from './registry';

export interface PaletteHooks {
  opening(): void;
  /** Closed; `resume` carries on playing (Esc, a click away, or after running something). */
  closed(resume: boolean): void;
}

/**
 * The command palette (Ctrl/⌘ + K): every registry entry, searched by name, synonym,
 * hint or group as you type. Each result shows its group, its key (so it teaches the
 * shortcut) and a toggle's state; ↑ ↓ pick, Enter (or a click) runs it and closes.
 * Entries the mode or the rules don't allow are listed greyed with the reason. While it's
 * open it has the keyboard: nothing reaches the game.
 */
export class CommandPalette {
  private readonly input: HTMLInputElement;
  private readonly list: HTMLElement;
  private results: Entry[] = [];
  private selected = 0;

  constructor(
    readonly el: HTMLElement,
    private readonly registry: Registry,
    private readonly hooks: PaletteHooks,
    /** Which entries to offer (touch hides keyboard-only ones). */
    private readonly offered: (e: Entry) => boolean = () => true,
  ) {
    el.innerHTML =
      '<div class="palette-card glass" role="dialog" aria-label="Search settings and actions">' +
      `<label class="palette-search">${ICONS.search}<input type="text" autocomplete="off" spellcheck="false" ` +
      'placeholder="Search settings, overlays and actions…" aria-label="Search" role="combobox" aria-expanded="true" aria-controls="palette-results" /></label>' +
      '<ul class="palette-results" id="palette-results" role="listbox"></ul>' +
      '<footer class="palette-foot desktop-only"><span><kbd>↑</kbd><kbd>↓</kbd> choose</span>' +
      '<span><kbd>Enter</kbd> run</span><span><kbd>Esc</kbd> close</span></footer>' +
      '</div>';
    this.input = el.querySelector('input')!;
    this.list = el.querySelector('.palette-results')!;
    this.input.addEventListener('input', () => {
      this.selected = 0;
      this.render();
    });
    // It has the keyboard while open: the game's keys stop here.
    el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        // Back to the pause menu: a browser won't capture the mouse on Esc.
        e.preventDefault();
        this.close(false);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.move(e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const entry = this.results[this.selected];
        if (entry) this.run(entry);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        this.move(e.shiftKey ? -1 : 1);
      }
    });
    el.addEventListener('keyup', (e) => e.stopPropagation());
    // A click on the dimmed scene around it closes it.
    el.addEventListener('pointerdown', (e) => {
      if (e.target === el) {
        e.preventDefault();
        this.close(true);
      }
    });
    registry.subscribe(() => {
      if (this.isOpen) this.render();
    });
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  get query(): string {
    return this.input.value;
  }

  open(query = ''): void {
    if (this.isOpen) return;
    this.hooks.opening();
    this.el.hidden = false;
    document.body.classList.add('palette-open');
    this.input.value = query;
    this.selected = 0;
    this.render();
    this.input.focus();
  }

  close(resume: boolean): void {
    if (!this.isOpen) return;
    this.el.hidden = true;
    document.body.classList.remove('palette-open');
    this.input.blur();
    this.hooks.closed(resume);
  }

  toggle(): void {
    if (this.isOpen) this.close(true);
    else this.open();
  }

  private move(by: number): void {
    const n = this.results.length;
    if (!n) return;
    this.selected = (this.selected + by + n) % n;
    this.render();
  }

  private run(entry: Entry): void {
    if (!this.registry.status(entry).enabled) return;
    this.close(true);
    entry.run();
  }

  private render(): void {
    this.results = search(this.registry.entries.filter(this.offered), this.input.value);
    if (this.selected >= this.results.length) this.selected = Math.max(0, this.results.length - 1);
    this.list.innerHTML = '';
    if (!this.results.length) {
      const empty = document.createElement('li');
      empty.className = 'palette-empty';
      empty.textContent = 'Nothing matches';
      this.list.append(empty);
      return;
    }
    this.results.forEach((entry, i) => {
      const status = this.registry.status(entry);
      const li = document.createElement('li');
      li.className = 'palette-item';
      li.dataset.id = entry.id;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === this.selected));
      li.setAttribute('aria-disabled', String(!status.enabled));
      const group = GROUPS.find((g) => g.id === entry.group)!.label;
      const state =
        entry.kind === 'toggle'
          ? `<span class="palette-state${this.registry.isOn(entry) ? ' on' : ''}">${this.registry.isOn(entry) ? 'On' : 'Off'}</span>`
          : '';
      li.innerHTML =
        `${ICONS[entry.icon]}<span class="palette-text"><span class="palette-label"></span><small></small></span>` +
        `<span class="palette-group"></span>${state}` +
        (entry.key ? `<kbd>${keyLabel(entry.key)}</kbd>` : '');
      li.querySelector('.palette-label')!.textContent = entry.label;
      li.querySelector('small')!.textContent = status.reason ?? entry.hint;
      li.querySelector('.palette-group')!.textContent = group;
      li.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the field focused
      li.addEventListener('click', () => this.run(entry));
      li.addEventListener('pointermove', () => {
        if (this.selected === i) return;
        this.selected = i;
        for (const [j, item] of [...this.list.children].entries()) {
          item.setAttribute('aria-selected', String(j === i));
        }
      });
      this.list.append(li);
    });
    this.list.children[this.selected]?.scrollIntoView({ block: 'nearest' });
  }
}
