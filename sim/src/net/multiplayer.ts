import type { PerspectiveCamera, Scene, Vector3 } from 'three/webgpu';

import { DAY_SECONDS, type TimeOfDay } from '../env/time-of-day';
import { type GameRules, sameRules } from '../game/rules';
import { MultiplayerMenu } from '../ui/multiplayer-menu';
import { activity } from '../ui/party-hud';
import type { OtherRider } from '../lifts/ride';
import { Flag, type PlayerState, SLOT } from './codec';
import { type CarrierFrame, playerColour, RemotePlayers } from './remote-players';
import {
  cleanName,
  inviteLink,
  liftCorrection,
  loadName,
  loadParty,
  makeRoomCode,
  NAME_KEY,
  nameProblem,
  partyLink,
  roomId,
  saveParty,
  type SharedClock,
} from './room';
import { type EndKind, NetSession, type Role, SEND_HZ } from './session';
import { openTransport, type TransportKind } from './transport';

/** What multiplayer needs from the running sim. */
export interface MultiplayerSim {
  scene: Scene;
  resort: string;
  /** Container for the floating name tags (shares the labels layer). */
  tags: HTMLElement;
  groundHeight: (x: number, z: number) => number;
  /** Where a lift's carrier is, to seat other riders on it. */
  carrierFrame: CarrierFrame;
  /** Your own avatar, as others should see it. */
  sample(out: PlayerState): void;
  /** The lift clock (shared: guests follow the host's). */
  lifts: { time: number; previousTime: number };
  clock: TimeOfDay;
  /** The time of day was changed by the host; move the sun and refresh the clock. */
  timeChanged(): void;
  /** Teleport next to a world position (another player). */
  goTo(position: Vector3): void;
  /** Joining or leaving changes whether you may run the shared clocks. */
  roomChanged(): void;
  /** Your jacket colour in a game (your player colour), null out of one. */
  setJacket(colour: string | null): void;
  /** A short message on the HUD ("Ben joined"). */
  notify(text: string): void;
  /** Your own rules (Options → Rules), which a game you host starts with. */
  ownRules(): GameRules;
  /** The rules in force changed (the host's arrived or changed, or you left the party). */
  rulesChanged(): void;
}

/** How long a dropped guest keeps trying to get back into the party (ms). */
export const RECONNECT_FOR = 90_000;
/** Between attempts to reach the party again (ms). */
const RETRY_EVERY = 3000;
/** The host gone without a word: the next player waits this long for it to come back
 *  before taking over (a reload into the same resort is quicker than a new host). */
const TAKEOVER_DELAY = 4000;
/** Guests follow the host to another resort after this long (s), unless they stay. */
export const FOLLOW_AFTER = 10;

/**
 * Hosting and joining games: owns the session, the Multiplayer tab and the remote
 * players. Nothing touches the network until you host or join.
 */
export class Multiplayer {
  private session: NetSession | null = null;
  private readonly remote: RemotePlayers;
  readonly menu: MultiplayerMenu;
  private status = '';
  private error = false;
  /** Guest: how far the local lift clock is behind the host's, still to make up (s). */
  private liftError = 0;
  private name: string;
  /** Host/Join presses so far (connecting is async). */
  private attempts = 0;
  /**
   * The party's rules when they aren't your own: the host's (as a guest), or the ones a
   * party you took over or rejoined was playing by. Null when you play by your own.
   */
  private partyRules: GameRules | null = null;

  constructor(
    private readonly sim: MultiplayerSim,
    /** The Multiplayer screen, made before any map loads; this takes over its buttons. */
    menu: MultiplayerMenu,
    private readonly transport: TransportKind,
    autoJoin: string | null,
    /** Chose "Host" before picking a resort: open a game as soon as the map's ready. */
    autoHost = false,
  ) {
    this.name = loadName(localStorage);
    this.remote = new RemotePlayers(sim.scene, sim.tags, sim.groundHeight, sim.carrierFrame);
    this.menu = menu;
    menu.actions = {
      host: () => void this.start('host', makeRoomCode()),
      join: (code) => void this.start('guest', code),
      leave: () => this.leave(),
      goTo: (player) => {
        const at = this.remote.positionOf(player);
        if (!at) return;
        this.menu.close();
        sim.goTo(at);
      },
      rename: (name) => {
        this.name = cleanName(name);
        localStorage.setItem(NAME_KEY, this.name);
        this.session?.rename();
        this.render();
      },
    };
    // Closing the tab hands the party on; moving resort with it (or following) doesn't.
    window.addEventListener('pagehide', () => {
      if (this.travelling) this.session?.close();
      else this.session?.leave();
    });
    // The frame loop stops while the map is open or the tab is in the background; keep
    // sending and pinging anyway, or the host drops you after a few seconds.
    setInterval(() => this.session?.update(), 1000 / SEND_HZ);
    this.render();
    // An invite link: join straight away (progress shows on the Multiplayer screen),
    // once you've a name; without one, the screen asks for it with the code filled in.
    // Back from a reload or a move with the party: carry on in it (a host hosts again
    // under the same code, and keeps it if a guest took over meanwhile).
    const named = !nameProblem(this.name);
    const saved = loadParty(sessionStorage);
    if (autoJoin && named) void this.start('guest', autoJoin);
    else if (autoHost && named) void this.start('host', makeRoomCode());
    else if (autoJoin || autoHost) this.waiting = { code: autoJoin };
    else if (saved && named) {
      this.partyRules = saved.rules ?? null;
      void this.start(saved.role, saved.code, saved.since);
    }
  }

  /** Reloading into another resort with the party (or following it): don't hand over. */
  private travelling = false;
  /** Dropped and finding our way back in: since when (ms), and the party's code. */
  private reconnect: { code: string; since: number; timer: number } | null = null;
  /** Guest: the host is moving the party; follow when this runs out (or stay). */
  private follow_: { resort: string; start: string | null; timer: number } | null = null;
  private lastNames = new Map<number, string>();

  /** An invite link or Host from the menu, held until you've entered a name. */
  private waiting: { code: string | null } | null = null;

  /**
   * Entering the world with an invite waiting for a name: show the Multiplayer screen
   * asking for it (the code filled in) instead. Returns whether it did.
   */
  askForName(): boolean {
    const w = this.waiting;
    if (!w) return false;
    this.waiting = null;
    if (document.pointerLockElement) document.exitPointerLock(); // menus need the mouse
    if (w.code) this.menu.askName(w.code);
    else this.menu.open();
    return true;
  }

  /** In a game (hosting, or joined/joining one). */
  get active(): boolean {
    return this.session !== null;
  }

  /** Guests follow the host's clocks instead of running their own. */
  get isGuest(): boolean {
    return this.session?.role === 'guest';
  }

  /** The party's rules, or null when you play by your own. */
  get rules(): GameRules | null {
    return this.partyRules;
  }

  /** Someone else sets the rules: you're a guest, or finding your way back into a party. */
  get rulesLocked(): boolean {
    // Out of a session with the party's rules: dropped, and finding the way back in.
    return this.isGuest || (this.session === null && this.partyRules !== null);
  }

  /**
   * You changed the rules (only when they aren't locked): the party's, if you took one over
   * (your own are saved by the caller), and guests hear them at once.
   */
  rulesEdited(rules: GameRules): void {
    if (this.partyRules !== null && this.session?.role === 'host') {
      this.partyRules = { ...rules };
      this.saveParty();
    }
    this.session?.pushRules();
  }

  /** Dev/test handle: the session and what remote players are showing. */
  get debug() {
    const s = this.session;
    return {
      role: s?.role ?? null,
      code: s?.code ?? null,
      connected: s?.connected ?? false,
      self: s?.self ?? null,
      players: s?.names() ?? [],
      dots: this.remote.dots,
      modes: this.remote.modes,
    };
  }

  /**
   * Other players on a carrier, by their latest state, and whether each keeps their seat
   * if you chose the same one (the lower player number does; the host is 0).
   */
  ridersOn(line: number, carrier: number): OtherRider[] {
    const s = this.session;
    if (!s) return [];
    const out: OtherRider[] = [];
    const self = s.self ?? Infinity;
    for (const p of s.players.values()) {
      const state = p.interp.latest;
      if (!state || !(state.flags & Flag.OnCarrier) || p.player === s.self) continue;
      const c = SLOT.carrier;
      if (state.pose[c] !== line || state.pose[c + 1] !== carrier) continue;
      out.push({ seat: state.pose[c + 2]!, wins: p.player < self });
    }
    return out;
  }

  /** Host changed the time of day: tell guests straight away. */
  clockChanged(): void {
    this.session?.pushClock();
  }

  update(dt: number, camera: PerspectiveCamera): void {
    const s = this.session;
    if (!s) return;
    s.update();
    if (s.role === 'guest' && this.liftError !== 0) {
      // Ease the lift clock onto the host's, so everyone's chairs line up.
      const lifts = this.sim.lifts;
      const step = liftCorrection(this.liftError, dt);
      lifts.time += step;
      if (Math.abs(step) > 1) lifts.previousTime = lifts.time; // a jump, not a pass
      this.liftError -= step;
    }
    this.remote.update(s.players, dt, performance.now(), camera);
    if (this.menu.isOpen) this.render();
  }

  /** Other players for the minimap. */
  get dots() {
    return this.remote.dots;
  }

  /** The nearest drone another player is flying (distance from `from`, m; its speed). */
  nearestDrone(from: Vector3): { distance: number; speed: number } | null {
    return this.session ? this.remote.nearestDrone(from) : null;
  }

  private async start(role: Role, code: string, since?: number): Promise<void> {
    if (this.session) this.session.close();
    this.session = null;
    // A second click while the first is still connecting: only the latest goes ahead.
    const attempt = ++this.attempts;
    this.setStatus(role === 'host' ? 'Opening a game…' : `Looking for game ${code}…`);
    let transport;
    try {
      transport = await openTransport(this.transport)(roomId(code));
    } catch (e) {
      if (attempt !== this.attempts) return;
      console.warn('[net] could not connect', e);
      this.setStatus('Could not reach the matchmaking relays. Are you online?', true);
      return;
    }
    if (attempt !== this.attempts) return transport.leave();
    this.liftError = 0;
    const hostSince = role === 'host' ? (since ?? Date.now()) : undefined;
    saveParty(sessionStorage, {
      code,
      role,
      since: hostSince,
      rules: this.partyRules ?? undefined,
    });
    this.session = new NetSession(
      transport,
      role,
      code,
      {
        resort: this.sim.resort,
        name: () => this.name,
        sample: (out) => this.sim.sample(out),
        clock: () => ({
          lift: this.sim.lifts.time,
          seconds: this.sim.clock.seconds,
          rate: this.sim.clock.rate,
        }),
        follow: (c) => this.follow(c),
        rules: () => this.partyRules ?? this.sim.ownRules(),
        followRules: (r) => this.followRules(r),
      },
      {
        roster: () => {
          const self = this.session?.self;
          this.sim.setJacket(self === null || self === undefined ? null : playerColour(self));
          if (this.session?.connected) {
            if (this.reconnect) this.sim.notify('Back in the party');
            this.stopReconnecting();
            this.setStatus(role === 'host' ? 'Share the code or the link' : 'Connected');
          }
          this.announce();
        },
        ended: (reason, kind) => this.ended(reason, kind),
        wrongResort: (resort) => {
          // Same game, the host's ski area: reload there and join again.
          this.travelling = true;
          location.href = partyLink(location.href, resort, code);
        },
        moving: (resort, start) => this.hostMoving(resort, start),
        yieldHost: () => {
          // Another host had this party first (we took over while it was reloading).
          this.sim.notify('Rejoining the party');
          void this.start('guest', code);
        },
      },
      undefined,
      hostSince,
    );
    if (role === 'host') {
      this.setStatus('Share the code or the link');
      this.sim.setJacket(playerColour(0));
    }
    this.sim.roomChanged();
  }

  private follow(c: SharedClock): void {
    this.liftError = c.lift - this.sim.lifts.time;
    const clock = this.sim.clock;
    // Time of day: adopt the rate, and the time unless it's already within a moment.
    let d = (c.seconds - clock.seconds) % DAY_SECONDS;
    if (d > DAY_SECONDS / 2) d -= DAY_SECONDS;
    if (d < -DAY_SECONDS / 2) d += DAY_SECONDS;
    if (Math.abs(d) > Math.max(2, c.rate) || clock.rate !== c.rate) {
      clock.set(c.seconds);
      clock.rate = c.rate;
      this.sim.timeChanged();
    }
  }

  /** Guest: the host's rules, on joining and whenever it changes them. */
  private followRules(rules: GameRules): void {
    const before = this.partyRules ?? this.sim.ownRules();
    const first = this.partyRules === null;
    this.partyRules = rules;
    this.saveParty();
    if (!sameRules(before, rules))
      this.sim.notify(first ? "Playing by the host's rules" : 'The host changed the rules');
    this.sim.rulesChanged();
  }

  /** Keep the party (and its rules) for this tab, across reloads. */
  private saveParty(): void {
    const s = this.session;
    if (!s) return;
    const since = loadParty(sessionStorage)?.since;
    saveParty(sessionStorage, {
      code: s.code,
      role: s.role,
      since: s.role === 'host' ? since : undefined,
      rules: this.partyRules ?? undefined,
    });
  }

  /** Leave the party for good (the Leave button, or skiing off to another resort). */
  leave(): void {
    this.stopReconnecting();
    this.cancelFollow();
    this.partyRules = null;
    saveParty(sessionStorage, null);
    this.session?.leave();
    this.reset('');
  }

  /** Host: take the party to another resort. Call just before reloading there. */
  moveParty(resort: string, start: string | null): void {
    const s = this.session;
    if (!s || s.role !== 'host') return;
    s.move(resort, start);
    this.travelling = true;
  }

  /**
   * The party card's rows: everyone else, with how far they are from `you` (world) and
   * what they're doing (`runAt`: the run at a world position). Null out of a party.
   */
  partyMembers(
    you: Vector3,
    runAt: (at: Vector3) => string | null,
  ): import('../ui/party-hud').PartyMember[] | null {
    const s = this.session;
    if (!s) return this.reconnect ? [] : null;
    return s
      .names()
      .filter((p) => !p.you)
      .map((p) => {
        const at = this.remote.positionOf(p.player);
        const mode = this.remote.modeOf(p.player);
        return {
          name: p.name,
          colour: playerColour(p.player),
          host: p.player === 0,
          distance: at ? Math.round(at.distanceTo(you)) : null,
          doing: at && mode ? activity(mode, mode === 'ski' ? runAt(at) : null) : null,
        };
      });
  }

  /** In a party as a guest (picking another resort leaves it). */
  get inPartyAsGuest(): boolean {
    return !!this.session && this.session.role === 'guest';
  }

  /** The host's name, for "You'll leave Ana's party". */
  get hostName(): string | null {
    return this.session?.names().find((p) => p.player === 0)?.name ?? null;
  }

  private ended(reason: string, kind: EndKind): void {
    const s = this.session;
    if (kind !== 'final' && s) {
      // The party carries on: the next player takes over as host, the rest find it.
      const others = [...s.players.keys()].filter((n) => n !== 0);
      const me = s.self;
      const next = me !== null && others.every((n) => n > me);
      const retrying = !!this.reconnect;
      this.reset('Reconnecting…', false, true);
      if (!retrying)
        this.sim.notify(kind === 'handover' ? 'The host left' : 'Lost the host: reconnecting…');
      if (next && !retrying) {
        const delay = kind === 'handover' ? 0 : TAKEOVER_DELAY;
        this.reconnectTo(s.code, delay, 'host');
      } else {
        this.reconnectTo(s.code, retrying ? RETRY_EVERY : kind === 'handover' ? 1500 : 0, 'guest');
      }
      return;
    }
    saveParty(sessionStorage, null);
    this.partyRules = null; // back to your own
    this.reset(reason, true);
    // Make sure they see why, even mid-run.
    if (document.pointerLockElement) document.exitPointerLock();
    this.menu.open();
  }

  /** Keep trying to get back into the party (`as` host: take it over). */
  private reconnectTo(code: string, delay: number, as: Role): void {
    const since = this.reconnect?.since ?? Date.now();
    clearTimeout(this.reconnect?.timer);
    const attempt = () => {
      if (!this.reconnect) return;
      if (Date.now() - this.reconnect.since > RECONNECT_FOR) {
        this.stopReconnecting();
        saveParty(sessionStorage, null);
        this.partyRules = null;
        this.reset("Couldn't get back into the party", true);
        this.sim.notify("Couldn't get back into the party");
        return;
      }
      if (as === 'host') {
        this.sim.notify('You are hosting the party now');
        void this.start('host', code);
        this.stopReconnecting();
        return;
      }
      // Looks for the party for FIND_TIMEOUT; if it's not there yet that session ends as
      // `lost`, which comes back here for the next try (see `ended`).
      void this.start('guest', code);
    };
    this.reconnect = { code, since, timer: window.setTimeout(attempt, delay) };
  }

  private stopReconnecting(): void {
    if (this.reconnect) clearTimeout(this.reconnect.timer);
    this.reconnect = null;
  }

  /** Guest: the host is moving the party. Follow in FOLLOW_AFTER s unless you stay. */
  private hostMoving(resort: string, start: string | null): void {
    const code = this.session?.code;
    if (!code) return;
    this.cancelFollow();
    const host = this.hostName ?? 'The host';
    let left = FOLLOW_AFTER;
    const go = () => {
      this.travelling = true;
      saveParty(sessionStorage, { code, role: 'guest', rules: this.partyRules ?? undefined });
      location.href = partyLink(location.href, resort, code, start);
    };
    const tick = () => {
      if (!this.follow_) return;
      if (left <= 0) return go();
      this.sim.notify(
        `${host} is taking the party to ${resort}: following in ${left} s · L to stay`,
      );
      left--;
      this.follow_.timer = window.setTimeout(tick, 1000);
    };
    this.follow_ = { resort, start, timer: 0 };
    tick();
  }

  /** L while the party's moving: stay here (and leave it). */
  stayBehind(): boolean {
    if (!this.follow_) return false;
    this.cancelFollow();
    this.leave();
    this.sim.notify('You stayed behind and left the party');
    return true;
  }

  private cancelFollow(): void {
    if (this.follow_) clearTimeout(this.follow_.timer);
    this.follow_ = null;
  }

  /** "Ben joined" / "Ben left", from the roster's changes. */
  private announce(): void {
    const now = new Map(
      (this.session?.names() ?? []).filter((p) => !p.you).map((p) => [p.player, p.name]),
    );
    for (const [n, name] of now) if (!this.lastNames.has(n)) this.sim.notify(`${name} joined`);
    for (const [n, name] of this.lastNames) if (!now.has(n)) this.sim.notify(`${name} left`);
    this.lastNames = now;
  }

  private reset(status: string, error = false, keepNames = false): void {
    this.session = null;
    this.remote.clear();
    if (!keepNames) this.lastNames = new Map();
    this.sim.setJacket(null);
    this.setStatus(status, error);
    this.sim.roomChanged();
  }

  private setStatus(text: string, error = false): void {
    this.status = text;
    this.error = error;
    this.render();
  }

  private render(): void {
    const s = this.session;
    this.menu.render({
      role: s?.role ?? null,
      code: s?.code ?? null,
      link: s ? inviteLink(location.href, this.sim.resort, s.code) : null,
      players: (s?.names() ?? []).map((p) => ({
        ...p,
        colour: playerColour(p.player),
        seen: this.remote.positionOf(p.player) !== null,
      })),
      status: this.status,
      error: this.error,
      teleport: (this.partyRules ?? this.sim.ownRules()).teleport,
    });
  }
}
