import {
  createState,
  decodeBatch,
  decodeState,
  encodeBatch,
  encodeState,
  type PlayerState,
} from './codec';
import { Interpolator } from './interpolation';
import { advanceShared, cleanName, DEFAULT_NAME, MAX_PLAYERS, type SharedClock } from './room';
import type { Transport } from './transport';

/** A guest's name as everyone sees it: cleaned, and never blank (old or odd clients). */
const shownName = (name: string) => cleanName(name) || DEFAULT_NAME;

export type Role = 'host' | 'guest';

/** Bump when the wire format changes, so mismatched builds refuse rather than garble. */
export const NET_VERSION = 3;
/** States sent per second. */
export const SEND_HZ = 12;
/** A peer silent for this long has gone (ms). */
export const PEER_TIMEOUT = 5000;
/** How long a guest looks for the host before giving up (ms). */
export const FIND_TIMEOUT = 20_000;
/** Host → guests clock broadcast, and guest → host round-trip probe (ms). */
const SYNC_INTERVAL = 1000;
const PING_INTERVAL = 2000;

export type Control =
  | { t: 'hello'; v: number; role: Role; name: string; resort: string; since?: number }
  | { t: 'welcome'; player: number }
  | { t: 'roster'; players: { player: number; name: string }[] }
  | { t: 'reject'; reason: 'full' | 'version' }
  | { t: 'ping'; at: number }
  | { t: 'pong'; at: number; clock: SharedClock }
  | { t: 'sync'; clock: SharedClock }
  | { t: 'end' }
  | { t: 'bye' }
  /** The host is leaving: the party carries on under the next host (no waiting). */
  | { t: 'handover' }
  /** The host is moving the party to another resort (guests follow, or stay behind). */
  | { t: 'move'; resort: string; start: string | null };

/**
 * Why a session ended, for what happens next: `lost` (the host went quiet or its tab
 * closed: reconnect, and take over if it doesn't come back), `handover` (the host left:
 * the next one takes over now), `final` (rejected, not found, or you left: stop).
 */
export type EndKind = 'lost' | 'handover' | 'final';

/** What the session needs from the running sim. */
export interface SessionWorld {
  readonly resort: string;
  /** Your player name (it can change mid-game). */
  name(): string;
  /** Fill in your own current state (time is set by the session). */
  sample(out: PlayerState): void;
  /** Host: the clocks guests follow. */
  clock(): SharedClock;
  /** Guest: the host's clocks, already advanced by the one-way latency. */
  follow(clock: SharedClock): void;
}

export interface SessionEvents {
  /** Players changed (joined, left, renamed). */
  roster(): void;
  /** The session is over for you (host left, rejected, lost, not found). */
  ended(reason: string, kind: EndKind): void;
  /** Guest: the host is skiing another resort; reload there and join again. */
  wrongResort(resort: string): void;
  /** Guest: the host is moving the party to `resort`. */
  moving(resort: string, start: string | null): void;
  /** Host: another host has this code and has hosted longer; become its guest. */
  yieldHost(): void;
}

export interface Player {
  /** 0 is the host; guests get 1..15. */
  player: number;
  name: string;
  /** Host side: the guest's transport id. */
  peer?: string;
  readonly interp: Interpolator;
}

/**
 * A multiplayer session. The host's browser relays: guests send their state to the host
 * only, and the host sends everyone's latest states back out in one batch. The host also
 * owns the room's roster and its clocks (time of day and the lift clock).
 */
export class NetSession {
  /** Everyone else in the room, by player number. */
  readonly players = new Map<number, Player>();
  /** Your player number (0 for the host; guests learn theirs on welcome). */
  self: number | null;
  /** Guest: the host's transport id once found. */
  private host: string | null = null;
  private heardHost = 0;
  private started: number;
  private lastSend = -Infinity;
  private lastSync = -Infinity;
  private lastPing = -Infinity;
  /** Guest: the host dropped us; say hello again on the next update. */
  private rejoin = false;
  /** Guest: last measured round trip to the host (ms). */
  rtt = 0;
  private over = false;
  /** Host: guests whose state arrived since the last batch. */
  private readonly fresh = new Set<number>();
  private readonly mine = createState();

  constructor(
    private readonly transport: Transport,
    readonly role: Role,
    readonly code: string,
    private readonly world: SessionWorld,
    private readonly events: SessionEvents,
    private readonly now: () => number = () => performance.now(),
    /** When this player started hosting (epoch ms): of two hosts, the earlier keeps it. */
    private readonly since: number = Date.now(),
  ) {
    this.started = now();
    this.self = role === 'host' ? 0 : null;
    transport.onPeerJoin = (peer) => this.sendHello(peer);
    transport.onPeerLeave = (peer) => this.peerLeft(peer);
    transport.onControl = (message, peer) => this.control(message, peer, this.now());
    transport.onState = (data, peer) => this.state(data, peer, this.now());
  }

  get ended(): boolean {
    return this.over;
  }

  /** Guest: welcomed into the room by the host. */
  get connected(): boolean {
    return this.role === 'host' || this.self !== null;
  }

  /** Roster names, you included, host first. */
  names(): { player: number; name: string; you: boolean }[] {
    const all = [...this.players.values()].map(({ player, name }) => ({
      player,
      name,
      you: false,
    }));
    if (this.self !== null) all.push({ player: this.self, name: this.world.name(), you: true });
    return all.sort((a, b) => a.player - b.player);
  }

  /** Call every frame: sends, clock sync, timeouts. */
  update(): void {
    if (this.over) return;
    const now = this.now();
    if (this.role === 'guest') {
      if (this.rejoin && this.host) {
        this.rejoin = false;
        this.started = now; // the find timeout counts from the new hello
        this.sendHello(this.host);
      }
      if (!this.connected) {
        if (now - this.started > FIND_TIMEOUT)
          this.end(`No game found with code ${this.code}`, 'lost');
        return;
      }
      if (now - this.heardHost > PEER_TIMEOUT)
        return this.end('Lost connection to the host', 'lost');
      if (now - this.lastPing > PING_INTERVAL) {
        this.lastPing = now;
        this.transport.sendControl({ t: 'ping', at: now }, this.host!);
      }
    } else {
      for (const p of this.players.values()) {
        if (now - p.interp.heardAt > PEER_TIMEOUT) this.removeGuest(p);
      }
      if (now - this.lastSync > SYNC_INTERVAL) this.pushClock(now);
    }
    if (now - this.lastSend < 1000 / SEND_HZ) return;
    this.lastSend = now;
    this.world.sample(this.mine);
    this.mine.time = now;
    if (this.role === 'guest') {
      this.transport.sendState(encodeState(this.mine), this.host!);
    } else if (this.players.size > 0) {
      // Everyone's latest, each only once; guests skip their own entry.
      const entries = [{ player: 0, state: this.mine }];
      for (const n of this.fresh) {
        const latest = this.players.get(n)?.interp.latest;
        if (latest) entries.push({ player: n, state: latest });
      }
      this.fresh.clear();
      this.transport.sendState(encodeBatch(entries));
    }
  }

  /** Host: send the clocks now (e.g. the time of day was just changed). */
  pushClock(now = this.now()): void {
    if (this.role !== 'host' || this.over) return;
    this.lastSync = now;
    if (this.players.size > 0) this.transport.sendControl({ t: 'sync', clock: this.world.clock() });
  }

  /** Your name changed: the host updates the roster. */
  rename(): void {
    if (this.over) return;
    if (this.role === 'host') this.broadcastRoster();
    else if (this.host) this.sendHello(this.host);
  }

  /** Leave for good. A host hands the party over to the next player. */
  leave(): void {
    if (this.over) return;
    this.transport.sendControl(this.role === 'host' ? { t: 'handover' } : { t: 'bye' });
    this.finish();
  }

  /** Host: tell the party it's moving to `resort` (then reload there and host again). */
  move(resort: string, start: string | null): void {
    if (this.over || this.role !== 'host') return;
    this.transport.sendControl({ t: 'move', resort, start });
  }

  /** Close the connections without a word (a host reloading into another resort). */
  close(): void {
    if (this.over) return;
    this.finish();
  }

  private end(reason: string, kind: EndKind = 'final'): void {
    if (this.over) return;
    this.finish();
    this.events.ended(reason, kind);
  }

  private finish(): void {
    this.over = true;
    // Let the goodbye go out before the connections close.
    setTimeout(() => this.transport.leave(), 100);
  }

  private sendHello(peer: string): void {
    if (this.over) return;
    const { resort } = this.world;
    const name = this.world.name();
    this.transport.sendControl(
      { t: 'hello', v: NET_VERSION, role: this.role, name, resort, since: this.since },
      peer,
    );
  }

  private control(m: Control, peer: string, now: number): void {
    if (this.over) return;
    if (this.role === 'host') this.hostControl(m, peer, now);
    else this.guestControl(m, peer, now);
  }

  private hostControl(m: Control, peer: string, now: number): void {
    if (m.t === 'hello' && m.role === 'host') {
      // Two hosts for one code (a guest took over while the host was reloading): the one
      // hosting longer keeps the party; ties go to the lower transport id.
      const theirs = m.since ?? Infinity;
      if (theirs < this.since || (theirs === this.since && peer < this.transport.selfId)) {
        this.finish();
        this.events.yieldHost();
      }
      return;
    }
    if (m.t === 'hello') {
      if (m.role !== 'guest' || m.resort !== this.world.resort) return; // they'll move resort
      if (m.v !== NET_VERSION)
        return this.transport.sendControl({ t: 'reject', reason: 'version' }, peer);
      let guest = this.guestByPeer(peer);
      if (!guest) {
        const player = freeNumber(this.players);
        if (player === null)
          return this.transport.sendControl({ t: 'reject', reason: 'full' }, peer);
        guest = { player, name: shownName(m.name), peer, interp: new Interpolator() };
        this.players.set(player, guest);
      }
      guest.name = shownName(m.name);
      guest.interp.heard(now);
      this.transport.sendControl({ t: 'welcome', player: guest.player }, peer);
      this.transport.sendControl({ t: 'sync', clock: this.world.clock() }, peer);
      this.broadcastRoster();
      return;
    }
    const guest = this.guestByPeer(peer);
    if (!guest) return;
    guest.interp.heard(now);
    if (m.t === 'ping') {
      this.transport.sendControl({ t: 'pong', at: m.at, clock: this.world.clock() }, peer);
    } else if (m.t === 'bye') {
      this.removeGuest(guest);
    }
  }

  private guestControl(m: Control, peer: string, now: number): void {
    if (m.t === 'hello') {
      if (m.role !== 'host' || (this.host && this.host !== peer)) return;
      if (m.resort !== this.world.resort) return this.events.wrongResort(m.resort);
      this.host = peer;
      this.heardHost = now;
      return;
    }
    if (peer !== this.host) return; // guests only listen to the host
    this.heardHost = now;
    if (m.t === 'welcome') {
      this.self = m.player;
      this.events.roster();
    } else if (m.t === 'roster') {
      const listed = new Set(m.players.map((p) => p.player));
      if (this.self !== null && !listed.has(this.self)) {
        // The host dropped us (we went quiet, e.g. a backgrounded tab) but we can still
        // hear it: ask to be let back in once we're running again (update), rather than
        // ski on unseen.
        this.self = null;
        this.rejoin = true;
      }
      for (const n of this.players.keys()) if (!listed.has(n)) this.players.delete(n);
      for (const { player, name } of m.players) {
        if (player === this.self) continue;
        const p = this.players.get(player);
        if (p) p.name = name;
        else this.players.set(player, { player, name, interp: new Interpolator() });
      }
      this.events.roster();
    } else if (m.t === 'reject') {
      this.end(
        m.reason === 'full'
          ? `That game is full (${MAX_PLAYERS} players)`
          : 'That game is running a different version of ski-sim',
      );
    } else if (m.t === 'pong') {
      this.rtt = Math.max(0, now - m.at);
      this.world.follow(advanceShared(m.clock, this.rtt / 2000));
    } else if (m.t === 'sync') {
      this.world.follow(advanceShared(m.clock, this.rtt / 2000));
    } else if (m.t === 'end') {
      this.end('The host ended the game');
    } else if (m.t === 'handover') {
      this.end('The host left', 'handover');
    } else if (m.t === 'move') {
      this.events.moving(m.resort, m.start);
    }
  }

  private state(data: ArrayBuffer, peer: string, now: number): void {
    if (this.over) return;
    if (this.role === 'host') {
      const guest = this.guestByPeer(peer);
      const s = guest && decodeState(data);
      if (guest && s && guest.interp.push(s, now)) this.fresh.add(guest.player);
      return;
    }
    if (peer !== this.host || this.self === null) return;
    this.heardHost = now;
    for (const { player, state } of decodeBatch(data)) {
      if (player === this.self) continue;
      this.players.get(player)?.interp.push(state, now);
    }
  }

  private peerLeft(peer: string): void {
    if (this.over) return;
    if (this.role === 'guest') {
      if (peer === this.host) this.end('The host left the game', 'lost');
      return;
    }
    const guest = this.guestByPeer(peer);
    if (guest) this.removeGuest(guest);
  }

  private removeGuest(guest: Player): void {
    this.players.delete(guest.player);
    this.fresh.delete(guest.player);
    this.broadcastRoster();
  }

  private broadcastRoster(): void {
    const players = this.names().map(({ player, name }) => ({ player, name }));
    this.transport.sendControl({ t: 'roster', players });
    this.events.roster();
  }

  private guestByPeer(peer: string): Player | undefined {
    for (const p of this.players.values()) if (p.peer === peer) return p;
    return undefined;
  }
}

/** Lowest free guest number, or null when the room is full. */
function freeNumber(players: Map<number, Player>): number | null {
  for (let n = 1; n < MAX_PLAYERS; n++) if (!players.has(n)) return n;
  return null;
}
