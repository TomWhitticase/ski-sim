// How peers reach each other. The session only needs "send to one peer or all of them"
// and join/leave events, so the real WebRTC transport (Trystero) and an in-browser
// loopback (BroadcastChannel, used by the e2e tests) are interchangeable.

import type { Control } from './session';

export interface Transport {
  readonly selfId: string;
  onPeerJoin: (peer: string) => void;
  onPeerLeave: (peer: string) => void;
  onState: (data: ArrayBuffer, peer: string) => void;
  onControl: (message: Control, peer: string) => void;
  /** No `to`: every connected peer. */
  sendState(data: ArrayBuffer, to?: string): void;
  sendControl(message: Control, to?: string): void;
  leave(): void;
}

export type TransportKind = 'webrtc' | 'loopback';
export type OpenTransport = (room: string) => Promise<Transport>;

/** App namespace on the public signalling relays. */
const APP_ID = 'ski-sim-multiplayer';
/** Google's public STUN servers; no TURN, so very strict networks can fail to connect. */
const ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

const ignore = () => {};

/**
 * WebRTC data channels via Trystero, which signals over public Nostr relays: no server
 * of ours. Loaded on demand, so nothing touches the network until you host or join.
 */
export async function openWebRtc(room: string): Promise<Transport> {
  const { joinRoom, selfId } = await import('trystero');
  const r = joinRoom(
    {
      appId: APP_ID,
      rtcConfig: { iceServers: ICE_SERVERS },
      relayConfig: { warnOnRelayFailure: false },
    },
    room,
    { onJoinError: (e) => console.warn(`[net] ${e.error}`) },
  );
  const state = r.makeAction<ArrayBuffer>('state');
  const control = r.makeAction<Control>('control');
  const t: Transport = {
    selfId,
    onPeerJoin: ignore,
    onPeerLeave: ignore,
    onState: ignore,
    onControl: ignore,
    sendState: (data, to) => void state.send(data, { target: to ?? null }).catch(ignore),
    sendControl: (message, to) => void control.send(message, { target: to ?? null }).catch(ignore),
    leave: () => void r.leave().catch(ignore),
  };
  r.onPeerJoin = (peer) => t.onPeerJoin(peer);
  r.onPeerLeave = (peer) => t.onPeerLeave(peer);
  state.onMessage = (data, { peerId }) => {
    if (data instanceof ArrayBuffer) t.onState(data, peerId);
    else if (ArrayBuffer.isView(data)) t.onState(toArrayBuffer(data), peerId);
  };
  control.onMessage = (message, { peerId }) => t.onControl(message, peerId);
  return t;
}

function toArrayBuffer(view: ArrayBufferView): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

type Envelope =
  | { kind: 'here'; from: string; to?: string }
  | { kind: 'present'; from: string; to?: string }
  | { kind: 'gone'; from: string; to?: string }
  | { kind: 'state'; from: string; to?: string; data: ArrayBuffer }
  | { kind: 'control'; from: string; to?: string; message: Control };

/**
 * Peers in other tabs of this browser, over a BroadcastChannel. Same events as WebRTC,
 * no network: the e2e tests run a host and a guest in two pages with it (`?net=loopback`).
 */
export async function openLoopback(room: string): Promise<Transport> {
  const channel = new BroadcastChannel(`ski-sim-net:${room}`);
  const selfId = Math.random().toString(36).slice(2, 10);
  const peers = new Set<string>();
  const post = (e: Envelope) => channel.postMessage(e);
  const t: Transport = {
    selfId,
    onPeerJoin: ignore,
    onPeerLeave: ignore,
    onState: ignore,
    onControl: ignore,
    sendState: (data, to) => post({ kind: 'state', from: selfId, to, data }),
    sendControl: (message, to) => post({ kind: 'control', from: selfId, to, message }),
    leave: () => {
      post({ kind: 'gone', from: selfId });
      channel.close();
    },
  };
  channel.onmessage = ({ data: e }: MessageEvent<Envelope>) => {
    if (e.to && e.to !== selfId) return;
    if (e.kind === 'here' || e.kind === 'present') {
      // A newcomer says hello; everyone already here answers, so both sides meet.
      if (e.kind === 'here') post({ kind: 'present', from: selfId, to: e.from });
      if (!peers.has(e.from)) {
        peers.add(e.from);
        t.onPeerJoin(e.from);
      }
    } else if (e.kind === 'gone') {
      if (peers.delete(e.from)) t.onPeerLeave(e.from);
    } else if (e.kind === 'state') {
      if (peers.has(e.from)) t.onState(e.data, e.from);
    } else if (e.kind === 'control' && peers.has(e.from)) {
      t.onControl(e.message, e.from);
    }
  };
  // Announce on the next tick, after the session has hooked up its handlers.
  setTimeout(() => post({ kind: 'here', from: selfId }), 0);
  return t;
}

export function openTransport(kind: TransportKind): OpenTransport {
  return kind === 'loopback' ? openLoopback : openWebRtc;
}
