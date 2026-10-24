import { EVERYTHING_ON, type GameRules, REALISTIC, RULES, rulesPreset } from '../game/rules';
import { OptionsTab } from './options-hub';

/**
 * Rules (Options): what the game lets you do beyond skiing and riding lifts, a switch
 * each, plus the Realistic (all off) and Everything on presets. Changes go out through
 * `onChange`; in someone else's game the host sets them and the tab is locked.
 */
export class RulesMenu extends OptionsTab {
  private readonly switches = new Map<keyof GameRules, HTMLButtonElement>();
  private readonly presets: HTMLButtonElement[] = [];
  private readonly lockHint: HTMLElement;
  private rules: GameRules = { ...EVERYTHING_ON };

  constructor(
    el: HTMLElement,
    private readonly onChange: (rules: GameRules) => void,
  ) {
    super(el);
    const body = el.querySelector<HTMLElement>('.modal-body')!;
    this.lockHint = document.createElement('p');
    this.lockHint.className = 'time-locked';
    this.lockHint.hidden = true;
    body.append(this.lockHint);

    const presets = section(body, 'Presets');
    const row = document.createElement('div');
    row.className = 'setup-presets';
    for (const [name, label, rules] of [
      ['realistic', 'Realistic', REALISTIC],
      ['everything', 'Everything on', EVERYTHING_ON],
    ] as const) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'setup-preset';
      b.dataset.preset = name;
      b.textContent = label;
      b.addEventListener('click', () => this.change({ ...rules }));
      this.presets.push(b);
      row.append(b);
    }
    presets.append(row);

    const allowed = section(body, 'Allowed');
    for (const rule of RULES) {
      const line = document.createElement('div');
      line.className = 'option-row';
      line.innerHTML =
        '<span class="option-label"><small></small></span><button class="switch" type="button" role="switch"></button>';
      line.querySelector('.option-label')!.prepend(rule.label);
      line.querySelector('small')!.textContent = rule.detail;
      const sw = line.querySelector<HTMLButtonElement>('.switch')!;
      sw.dataset.rule = rule.name;
      sw.setAttribute('aria-label', rule.label);
      sw.addEventListener('click', () =>
        this.change({ ...this.rules, [rule.name]: !this.rules[rule.name] }),
      );
      this.switches.set(rule.name, sw);
      allowed.append(line);
    }
    this.render();
  }

  /** Show the rules in force; `locked` says why they can't be changed here (or null). */
  show(rules: GameRules, locked: string | null): void {
    this.rules = { ...rules };
    this.lockHint.textContent = locked ?? '';
    this.lockHint.hidden = !locked;
    for (const b of [...this.presets, ...this.switches.values()]) b.disabled = !!locked;
    this.render();
  }

  private change(rules: GameRules): void {
    this.rules = rules;
    this.render();
    this.onChange({ ...rules });
  }

  private render(): void {
    for (const [name, sw] of this.switches)
      sw.setAttribute('aria-checked', String(this.rules[name]));
    const preset = rulesPreset(this.rules);
    for (const b of this.presets) b.classList.toggle('selected', b.dataset.preset === preset);
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
