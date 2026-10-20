import { CODE_LENGTH, parseRoomCode } from '../net/room';
import { OptionsTab } from './options-hub';

export interface MultiplayerView {
  /** Not in a game: null. */
  role: 'host' | 'guest' | null;
  code: string | null;
  link: string | null;
  players: { player: number; name: string; you: boolean; colour: string; seen: boolean }[];
  status: string;
  error: boolean;
}

export interface MultiplayerActions {
  host(): void;
  join(code: string): void;
  leave(): void;
  /** Teleport next to another player. */
  goTo(player: number): void;
  rename(name: string): void;
}

/**
 * Multiplayer: your name, host a game (a code and an invite link to share) or join one
 * with a code, then who's playing and a way to leave. The networking lives in `net/`.
 */
export class MultiplayerMenu extends OptionsTab {
  private readonly nameInput: HTMLInputElement;
  private readonly codeInput: HTMLInputElement;
  private readonly lobby: HTMLElement;
  private readonly room: HTMLElement;
  private readonly codeEl: HTMLElement;
  private readonly linkInput: HTMLInputElement;
  private readonly playersEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly joinButton: HTMLButtonElement;
  private readonly hostButton: HTMLButtonElement;
  private shownPlayers = '';

  constructor(el: HTMLElement, name: string, actions: MultiplayerActions) {
    super(el);
    const body = el.querySelector<HTMLElement>('.modal-body')!;
    body.innerHTML = `
      <section>
        <h3>Your name</h3>
        <input class="mp-input" name="player-name" maxlength="20" autocomplete="nickname" />
      </section>
      <section class="mp-lobby">
        <h3>Play with friends</h3>
        <div class="mp-row">
          <button class="btn btn-primary mp-host" type="button">Host a game</button>
          <span class="setup-hint">Get a code to share. Your browser relays everyone, so keep this tab open.</span>
        </div>
        <div class="mp-row">
          <input class="mp-input mp-code-input" name="room-code" placeholder="Code" maxlength="${CODE_LENGTH + 2}" autocomplete="off" spellcheck="false" />
          <button class="btn mp-join" type="button">Join</button>
        </div>
      </section>
      <section class="mp-room" hidden>
        <h3>Game code</h3>
        <div class="mp-row">
          <span class="mp-code"></span>
          <input class="mp-input mp-link" name="invite-link" readonly />
          <button class="btn mp-copy" type="button">Copy invite link</button>
        </div>
        <h3>Players</h3>
        <ul class="mp-players"></ul>
        <button class="btn mp-leave" type="button">Leave game</button>
      </section>
      <p class="mp-status" role="status"></p>
      <p class="setup-hint">
        Peer to peer over WebRTC, found through free public relays: no game server. Up to
        16 players. Very strict networks (some offices and schools) may not connect.
      </p>`;
    const $ = <T extends HTMLElement>(s: string) => body.querySelector<T>(s)!;
    this.nameInput = $('[name="player-name"]');
    this.nameInput.value = name;
    this.nameInput.addEventListener('change', () => actions.rename(this.nameInput.value));
    this.codeInput = $('.mp-code-input');
    this.lobby = $('.mp-lobby');
    this.room = $('.mp-room');
    this.codeEl = $('.mp-code');
    this.linkInput = $('.mp-link');
    this.playersEl = $('.mp-players');
    this.statusEl = $('.mp-status');
    this.hostButton = $('.mp-host');
    this.joinButton = $('.mp-join');
    this.hostButton.addEventListener('click', () => actions.host());
    const join = () => {
      const code = parseRoomCode(this.codeInput.value);
      if (code) actions.join(code);
      else
        this.render({
          ...EMPTY,
          status: `A code is ${CODE_LENGTH} letters and digits`,
          error: true,
        });
    };
    this.joinButton.addEventListener('click', join);
    this.codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') join();
    });
    $('.mp-copy').addEventListener('click', () => {
      this.linkInput.select();
      void navigator.clipboard?.writeText(this.linkInput.value).then(
        () => this.flash('Invite link copied'),
        () => this.flash('Select the link and copy it'),
      );
    });
    $('.mp-leave').addEventListener('click', () => actions.leave());
    this.playersEl.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-go]');
      if (b) actions.goTo(Number(b.dataset.go));
    });
  }

  get name(): string {
    return this.nameInput.value;
  }

  render(view: MultiplayerView): void {
    const inRoom = view.role !== null;
    this.lobby.hidden = inRoom;
    this.room.hidden = !inRoom;
    this.codeEl.textContent = view.code ?? '';
    this.linkInput.value = view.link ?? '';
    this.statusEl.textContent = view.status;
    this.statusEl.classList.toggle('error', view.error);
    const key = JSON.stringify(view.players);
    if (key === this.shownPlayers) return;
    this.shownPlayers = key;
    this.playersEl.replaceChildren(
      ...view.players.map((p) => {
        const li = document.createElement('li');
        li.className = 'mp-player';
        li.style.setProperty('--player', p.colour);
        li.innerHTML = '<span class="mp-dot"></span><span class="mp-name"></span>';
        li.querySelector('.mp-name')!.textContent =
          p.name + (p.player === 0 ? ' · host' : '') + (p.you ? ' (you)' : '');
        if (!p.you) {
          const go = document.createElement('button');
          go.type = 'button';
          go.className = 'setup-option';
          go.dataset.go = String(p.player);
          go.textContent = 'Go to';
          go.disabled = !p.seen;
          li.append(go);
        }
        return li;
      }),
    );
  }

  private flash(text: string): void {
    this.statusEl.textContent = text;
    this.statusEl.classList.remove('error');
  }
}

const EMPTY: MultiplayerView = {
  role: null,
  code: null,
  link: null,
  players: [],
  status: '',
  error: false,
};
