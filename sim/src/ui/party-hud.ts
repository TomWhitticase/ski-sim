/**
 * Multiplayer on the HUD: short notices ("Ben joined", "Reconnecting…") under the
 * compass, and the party card (top left) with each friend's name, how far away they are
 * and what they're doing, so you always know who's in and where.
 */

/** One line of the party card. */
export interface PartyMember {
  name: string;
  colour: string;
  host: boolean;
  /** Metres from you; null if not seen yet (just joined, or another resort). */
  distance: number | null;
  /** "skiing Cascades", "on a lift", "flying a drone"… */
  doing: string | null;
}

const NOTICE_MS = 4000;

/** "850 m", "1.2 km". */
export function distanceLabel(m: number): string {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

/** What a player's mode means in words (avatar modes from net/codec). */
export function activity(mode: string, run: string | null): string {
  if (mode === 'ride') return 'on a lift';
  if (mode === 'fly') return 'flying a drone';
  if (mode === 'glide') return 'paragliding';
  if (mode === 'sled') return 'on a snowmobile';
  return run ? `skiing ${run}` : 'skiing';
}

export class PartyHud {
  private readonly notices: HTMLElement;
  private readonly card: HTMLElement;
  private shown = '';
  /** The same notice again within its time just restarts it (a countdown updates). */
  private readonly live = new Map<string, { el: HTMLElement; timer: number }>();

  constructor(hud: HTMLElement) {
    this.notices = document.createElement('div');
    this.notices.id = 'notices';
    this.notices.setAttribute('role', 'status');
    this.card = document.createElement('div');
    this.card.id = 'party';
    this.card.className = 'glass';
    this.card.hidden = true;
    hud.append(this.notices, this.card);
  }

  /** Show a notice for a few seconds. Notices sharing a `key` replace each other. */
  notify(text: string, key = text): void {
    const old = this.live.get(key);
    if (old) {
      clearTimeout(old.timer);
      old.el.textContent = text;
    }
    const el = old?.el ?? document.createElement('div');
    if (!old) {
      el.className = 'notice glass';
      el.textContent = text;
      this.notices.append(el);
      while (this.notices.children.length > 3) this.notices.firstElementChild!.remove();
    }
    const timer = window.setTimeout(() => {
      el.remove();
      this.live.delete(key);
    }, NOTICE_MS);
    this.live.set(key, { el, timer });
  }

  /** The party card: hidden out of a party. */
  setParty(members: PartyMember[] | null): void {
    const key = JSON.stringify(members);
    if (key === this.shown) return;
    this.shown = key;
    this.card.hidden = !members;
    if (!members) return;
    const head = document.createElement('div');
    head.className = 'party-head';
    head.textContent = members.length ? `Party · ${members.length + 1}` : 'Party · just you';
    const rows = members.map((m) => {
      const row = document.createElement('div');
      row.className = 'party-row';
      row.style.setProperty('--player', m.colour);
      row.innerHTML =
        '<span class="party-dot"></span><span class="party-name"></span><span class="party-where"></span>';
      row.querySelector('.party-name')!.textContent = m.name + (m.host ? ' · host' : '');
      row.querySelector('.party-where')!.textContent =
        m.distance === null
          ? 'joining…'
          : [distanceLabel(m.distance), m.doing].filter(Boolean).join(' · ');
      return row;
    });
    const hint = document.createElement('div');
    hint.className = 'party-hint';
    hint.innerHTML = '<kbd>N</kbd> party · go to a friend';
    this.card.replaceChildren(head, ...rows, hint);
  }
}
