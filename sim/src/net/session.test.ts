import { describe, expect, it } from 'vitest';

import type { PlayerState } from './codec';
import type { SharedClock } from './room';
import { type Control, FIND_TIMEOUT, NetSession, PEER_TIMEOUT, type Role } from './session';
import type { Transport } from './transport';

/** In-memory signalling: every transport sees every other; messages queue until `flush`. */
function createHub() {
  const members = new Map<string, Transport>();
  const queue: (() => void)[] = [];
  /** Peers whose network has silently died: nothing in or out, no leave event. */
  const cut = new Set<string>();
  let next = 0;
  const hub = {
    cut: (t: Transport) => cut.add(t.selfId),
    flush() {
      while (queue.length) queue.shift()!();
    },
    join(): Transport {
      const selfId = `p${next++}`;
      const deliver = (to: string | undefined, fn: (t: Transport) => void) => {
        if (cut.has(selfId)) return;
        for (const [id, t] of members) {
          if (id === selfId || (to && to !== id) || cut.has(id)) continue;
          queue.push(() => members.has(id) && fn(t));
        }
      };
      const t: Transport = {
        selfId,
        onPeerJoin: () => {},
        onPeerLeave: () => {},
        onState: () => {},
        onControl: () => {},
        sendState: (data, to) => deliver(to, (o) => o.onState(data, selfId)),
        sendControl: (m, to) => deliver(to, (o) => o.onControl(structuredClone(m), selfId)),
        leave: () => {
          members.delete(selfId);
          for (const o of members.values()) queue.push(() => o.onPeerLeave(selfId));
        },
      };
      // Meet everyone already here (both directions), on the next flush.
      for (const o of members.values()) {
        queue.push(() => o.onPeerJoin(selfId));
        queue.push(() => t.onPeerJoin(o.selfId));
      }
      members.set(selfId, t);
      return t;
    },
  };
  return hub;
}

let clockNow = 0;
const now = () => clockNow;

function player(
  hub: ReturnType<typeof createHub>,
  role: Role,
  name: string,
  opts: { resort?: string; clock?: SharedClock } = {},
) {
  const log = { ended: [] as string[], moved: [] as string[], followed: [] as SharedClock[] };
  let x = 0;
  const world = {
    resort: opts.resort ?? 'les-3-vallees',
    name: () => name,
    sample: (out: PlayerState) => {
      out.mode = 'ski';
      out.pose[0] = x;
    },
    clock: () => opts.clock ?? { lift: 0, seconds: 0, rate: 1 },
    follow: (c: SharedClock) => log.followed.push(c),
  };
  const transport = hub.join();
  const session = new NetSession(
    transport,
    role,
    'ABCDEF',
    world,
    {
      roster: () => {},
      ended: (r) => log.ended.push(r),
      wrongResort: (r) => log.moved.push(r),
    },
    now,
  );
  return { session, transport, log, move: (to: number) => (x = to) };
}

/** Advance time in frames, delivering messages each frame. */
function run(hub: ReturnType<typeof createHub>, sessions: NetSession[], ms: number) {
  for (let t = 0; t < ms; t += 16) {
    clockNow += 16;
    for (const s of sessions) s.update();
    hub.flush();
  }
}

describe('NetSession', () => {
  it('host and guests see each other through the host relay', () => {
    clockNow = 1000;
    const hub = createHub();
    const host = player(hub, 'host', 'Host', { clock: { lift: 42, seconds: 36000, rate: 60 } });
    const a = player(hub, 'guest', 'Ana');
    const b = player(hub, 'guest', 'Ben');
    const all = [host.session, a.session, b.session];
    run(hub, all, 500);

    expect(a.session.connected && b.session.connected).toBe(true);
    expect(host.session.names().map((p) => p.name)).toEqual(['Host', 'Ana', 'Ben']);
    expect(b.session.names()).toEqual([
      { player: 0, name: 'Host', you: false },
      { player: 1, name: 'Ana', you: false },
      { player: 2, name: 'Ben', you: true },
    ]);
    // Guests follow the host's clocks.
    expect(a.log.followed.at(-1)!.seconds).toBeGreaterThanOrEqual(36000);
    expect(a.log.followed.at(-1)!.rate).toBe(60);

    a.move(123);
    host.move(-7);
    run(hub, all, 500);
    // Ben gets Ana's state relayed by the host, and the host's own.
    expect(b.session.players.get(1)!.interp.latest!.pose[0]).toBe(123);
    expect(b.session.players.get(0)!.interp.latest!.pose[0]).toBe(-7);
    expect(host.session.players.get(1)!.interp.latest!.pose[0]).toBe(123);
    // Nobody receives themselves.
    expect(a.session.players.has(1)).toBe(false);
  });

  it('ends the game for guests when the host leaves', () => {
    clockNow = 1000;
    const hub = createHub();
    const host = player(hub, 'host', 'Host');
    const a = player(hub, 'guest', 'Ana');
    run(hub, [host.session, a.session], 300);
    host.session.leave();
    run(hub, [a.session], 300);
    expect(a.session.ended).toBe(true);
    expect(a.log.ended).toEqual(['The host ended the game']);
  });

  it('drops a silent guest, and a guest gives up on a silent host', () => {
    clockNow = 1000;
    const hub = createHub();
    const host = player(hub, 'host', 'Host');
    const a = player(hub, 'guest', 'Ana');
    run(hub, [host.session, a.session], 300);
    expect(host.session.players.size).toBe(1);
    // Ana stops sending (frozen tab): the host drops her.
    run(hub, [host.session], PEER_TIMEOUT + 500);
    expect(host.session.players.size).toBe(0);

    // The other way round: the host's connection dies.
    const b = player(hub, 'guest', 'Ben');
    run(hub, [host.session, b.session], 300);
    expect(b.session.connected).toBe(true);
    hub.cut(host.transport);
    run(hub, [host.session, b.session], PEER_TIMEOUT + 100);
    expect(b.log.ended).toEqual(['Lost connection to the host']);
  });

  it('a dropped guest that can still hear the host joins again', () => {
    clockNow = 1000;
    const hub = createHub();
    const host = player(hub, 'host', 'Host');
    const a = player(hub, 'guest', 'Ana');
    run(hub, [host.session, a.session], 300);
    // Ana's tab is frozen long enough to be dropped, then she comes back.
    run(hub, [host.session], PEER_TIMEOUT + 500);
    expect(host.session.players.size).toBe(0);
    run(hub, [host.session, a.session], 500);
    expect(host.session.names().map((p) => p.name)).toEqual(['Host', 'Ana']);
    expect(a.session.connected).toBe(true);
    expect(a.session.ended).toBe(false);
  });

  it('reports a code nobody is hosting', () => {
    clockNow = 1000;
    const hub = createHub();
    const a = player(hub, 'guest', 'Ana');
    run(hub, [a.session], FIND_TIMEOUT + 200);
    expect(a.log.ended).toEqual(['No game found with code ABCDEF']);
  });

  it("sends a guest on another resort to the host's", () => {
    clockNow = 1000;
    const hub = createHub();
    const host = player(hub, 'host', 'Host', { resort: 'arlberg' });
    const a = player(hub, 'guest', 'Ana');
    run(hub, [host.session, a.session], 200);
    expect(a.log.moved).toEqual(['arlberg']);
    expect(host.session.players.size).toBe(0);
  });

  it('turns players away once the room is full', () => {
    clockNow = 1000;
    const hub = createHub();
    const host = player(hub, 'host', 'Host');
    const guests = Array.from({ length: 16 }, (_, i) => player(hub, 'guest', `G${i}`));
    run(hub, [host.session, ...guests.map((g) => g.session)], 300);
    expect(host.session.players.size).toBe(15);
    expect(guests.filter((g) => g.log.ended.length).map((g) => g.log.ended[0])).toEqual([
      'That game is full (16 players)',
    ]);
  });

  it('ignores control messages from other guests', () => {
    clockNow = 1000;
    const hub = createHub();
    const host = player(hub, 'host', 'Host');
    const a = player(hub, 'guest', 'Ana');
    run(hub, [host.session, a.session], 300);
    // A rogue peer claims the game has ended.
    const rogue = hub.join();
    hub.flush();
    rogue.sendControl({ t: 'end' } satisfies Control);
    hub.flush();
    expect(a.session.ended).toBe(false);
  });
});
