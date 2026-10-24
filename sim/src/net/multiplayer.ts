import type { PerspectiveCamera, Scene, Vector3 } from 'three/webgpu';

import { DAY_SECONDS, type TimeOfDay } from '../env/time-of-day';
import { MultiplayerMenu } from '../ui/multiplayer-menu';
import type { PlayerState } from './codec';
import { playerColour, RemotePlayers } from './remote-players';
import {
  cleanName,
  nameProblem,
  inviteLink,
  liftCorrection,
  loadName,
  makeRoomCode,
  NAME_KEY,
  roomId,
  type SharedClock,
} from './room';
import { NetSession, type Role, SEND_HZ } from './session';
import { openTransport, type TransportKind } from './transport';

/** What multiplayer needs from the running sim. */
export interface MultiplayerSim {
  scene: Scene;
  resort: string;
  /** Container for the floating name tags (shares the labels layer). */
  tags: HTMLElement;
  groundHeight: (x: number, z: number) => number;
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
}

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
    this.remote = new RemotePlayers(sim.scene, sim.tags, sim.groundHeight);
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
    window.addEventListener('pagehide', () => this.session?.leave());
    // The frame loop stops while the map is open or the tab is in the background; keep
    // sending and pinging anyway, or the host drops you after a few seconds.
    setInterval(() => this.session?.update(), 1000 / SEND_HZ);
    this.render();
    // An invite link: join straight away (progress shows on the Multiplayer screen),
    // once you've a name; without one, the screen asks for it with the code filled in.
    const named = !nameProblem(this.name);
    if (autoJoin && named) void this.start('guest', autoJoin);
    else if (autoHost && named) void this.start('host', makeRoomCode());
    else if (autoJoin || autoHost) this.waiting = { code: autoJoin };
  }

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

  private async start(role: Role, code: string): Promise<void> {
    if (this.session) this.leave();
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
      },
      {
        roster: () => {
          const self = this.session?.self;
          this.sim.setJacket(self === null || self === undefined ? null : playerColour(self));
          if (this.session?.connected) {
            this.setStatus(role === 'host' ? 'Share the code or the link' : 'Connected');
          }
        },
        ended: (reason) => this.ended(reason),
        wrongResort: (resort) => {
          // Same game, the host's ski area: reload there and join again.
          const url = new URL(inviteLink(location.href, resort, code));
          if (this.transport === 'loopback') url.searchParams.set('net', 'loopback');
          location.href = url.toString();
        },
      },
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

  private leave(): void {
    this.session?.leave();
    this.reset('');
  }

  private ended(reason: string): void {
    this.reset(reason, true);
    // Make sure they see why, even mid-run.
    if (document.pointerLockElement) document.exitPointerLock();
    this.menu.open();
  }

  private reset(status: string, error = false): void {
    this.session = null;
    this.remote.clear();
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
    });
  }
}
