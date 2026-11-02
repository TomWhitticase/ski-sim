import type { HintDef } from './hints';
import { ICONS } from './icons';
import type { Entry } from './registry';

/** The palette's keys as this keyboard has them. */
export function paletteKeys(): string[] {
  return /Mac|iPhone|iPad/.test(navigator.userAgent) ? ['⌘', 'K'] : ['Ctrl', 'K'];
}

/**
 * The context hint on screen (`#hint`, dark glass above the stat strip): "Press 2 for
 * peak names". On a touchscreen there are no keys, so it says what it offers with a
 * button that does it ("Show"), and a ✕. It goes by itself after a few seconds.
 */
export class HintToast {
  private timer = 0;

  constructor(private readonly el: HTMLElement) {}

  get shown(): HintDef | null {
    return this.el.hidden ? null : this.current;
  }

  private current: HintDef | null = null;

  show(hint: HintDef, entry: Entry | undefined, touch: boolean, seconds: number): void {
    this.current = hint;
    this.el.innerHTML = '';
    this.el.insertAdjacentHTML('beforeend', ICONS[entry?.icon ?? 'search']);
    const text = document.createElement('span');
    if (touch) {
      text.textContent = hint.touch;
    } else {
      const keys = hint.keys === 'palette' ? paletteKeys() : entry?.key ? [entry.key.glyph] : [];
      text.append('Press ');
      keys.forEach((k, i) => {
        if (i) text.append(' + ');
        const kbd = document.createElement('kbd');
        kbd.textContent = k;
        text.append(kbd);
      });
      text.append(` ${hint.desktop}`);
    }
    this.el.append(text);
    if (touch && entry) {
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'hint-do';
      go.textContent = entry.kind === 'toggle' ? 'Show' : 'Open';
      go.addEventListener('click', () => {
        this.hide();
        if (!(entry.kind === 'toggle' && entry.get?.())) entry.run();
      });
      this.el.append(go);
    }
    if (touch) {
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'hint-close';
      close.setAttribute('aria-label', 'Dismiss');
      close.textContent = '✕';
      close.addEventListener('click', () => this.hide());
      this.el.append(close);
    }
    this.el.dataset.hint = hint.id;
    this.el.hidden = false;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.hide(), seconds * 1000);
  }

  hide(): void {
    clearTimeout(this.timer);
    this.el.hidden = true;
    this.current = null;
  }
}
