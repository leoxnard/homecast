/**
 * Connection layer for watch-together (PLAN §4.2, M5).
 *
 * Opens a WebSocket to the signalling server, exchanges SDP with the peers in
 * the room, and then talks to them directly over WebRTC data channels. Once the
 * channels are open the server is idle — it is only ever an introducer.
 *
 * Two channels per peer, because the two kinds of traffic want opposite things:
 *   control — ordered and reliable: play, pause, seek. Losing one desyncs.
 *   view    — unordered, no retransmits: gaze at 20 Hz. A late one is worthless.
 */
import type { ServerSignal, SyncMessage } from "../shared/protocol.ts";

/**
 * STUN only. A direct path works for the common case of two home connections;
 * symmetric NAT or strict corporate firewalls would need a TURN relay, which
 * would mean routing peer traffic through a server — see `connectionNote()`.
 */
const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] },
];

export type RoomStatus = "idle" | "connecting" | "waiting" | "connected" | "failed" | "closed";

export interface PeerInfo {
  id: string;
  name?: string;
  file?: string;
  duration?: number;
  connectionState: RTCPeerConnectionState;
  /** round-trip time over the data channel, ms */
  rtt?: number;
}

export interface RoomCallbacks {
  onStatus: (status: RoomStatus, detail?: string) => void;
  onPeers: (peers: PeerInfo[]) => void;
  onMessage: (from: string, message: SyncMessage) => void;
  /** a peer's control/view channel just became usable */
  onPeerReady: (id: string) => void;
}

interface PeerLink {
  id: string;
  pc: RTCPeerConnection;
  control?: RTCDataChannel;
  view?: RTCDataChannel;
  info: PeerInfo;
  /** true when we created the offer */
  initiator: boolean;
}

export class Room {
  private ws?: WebSocket;
  private readonly peers = new Map<string, PeerLink>();
  private readonly cb: RoomCallbacks;
  private selfId = "";
  private code = "";
  private closing = false;
  private reconnectAttempts = 0;
  private reconnectTimer?: number;

  constructor(cb: RoomCallbacks) {
    this.cb = cb;
  }

  get roomCode(): string {
    return this.code;
  }
  get id(): string {
    return this.selfId;
  }
  get peerCount(): number {
    return this.peers.size;
  }
  /** Every id in the room, ours included, sorted — used to pick a timeline owner. */
  allIds(): string[] {
    return [this.selfId, ...this.peers.keys()].filter(Boolean).sort();
  }

  static signalingUrl(): string {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${location.host}/ws`;
  }

  join(code: string): void {
    this.closing = false;
    this.code = code.toUpperCase();
    this.openSocket();
  }

  private openSocket(): void {
    this.cb.onStatus("connecting");
    const ws = new WebSocket(Room.signalingUrl());
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.reconnectAttempts = 0;
      this.sendSignal({ type: "join", room: this.code });
    });

    ws.addEventListener("message", (event) => {
      let message: ServerSignal;
      try {
        message = JSON.parse(String(event.data)) as ServerSignal;
      } catch {
        return;
      }
      void this.handleSignal(message);
    });

    ws.addEventListener("close", () => {
      if (this.closing) return;
      // The data channels survive a signalling blip — peers already connected
      // keep syncing. Reconnect only so that *new* peers can still arrive.
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      if (!this.closing && this.peers.size === 0) this.cb.onStatus("failed", "could not reach the signalling server");
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts++, 15000);
    this.cb.onStatus(this.peers.size ? "connected" : "connecting", "signalling dropped; retrying");
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.closing) this.openSocket();
    }, delay);
  }

  private sendSignal(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  private async handleSignal(message: ServerSignal): Promise<void> {
    switch (message.type) {
      case "hello":
        this.selfId = message.self;
        return;

      case "joined": {
        this.selfId = message.self;
        this.code = message.room;
        // We are the newcomer, so we make the offers to everyone already here.
        for (const peer of message.peers) await this.connectTo(peer, true);
        this.cb.onStatus(message.peers.length ? "connecting" : "waiting");
        this.emitPeers();
        return;
      }

      case "peer-join":
        // They will offer to us; just be ready to answer.
        await this.connectTo(message.peer, false);
        this.emitPeers();
        return;

      case "peer-leave":
        this.dropPeer(message.peer);
        return;

      case "signal":
        await this.acceptSignal(message.from, message.data);
        return;

      case "error":
        this.cb.onStatus("failed", message.message);
        return;
    }
  }

  private async connectTo(id: string, initiator: boolean): Promise<PeerLink> {
    const existing = this.peers.get(id);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const link: PeerLink = {
      id,
      pc,
      initiator,
      info: { id, connectionState: pc.connectionState },
    };
    this.peers.set(id, link);

    pc.addEventListener("icecandidate", (e) => {
      if (e.candidate) this.sendSignal({ type: "signal", to: id, data: { candidate: e.candidate } });
    });

    pc.addEventListener("connectionstatechange", () => {
      link.info.connectionState = pc.connectionState;
      if (pc.connectionState === "failed") {
        this.cb.onStatus("failed", "direct connection failed — see the note about strict NATs");
      } else if (pc.connectionState === "connected") {
        this.cb.onStatus("connected");
      }
      this.emitPeers();
    });

    pc.addEventListener("datachannel", (e) => this.bindChannel(link, e.channel));

    if (initiator) {
      this.bindChannel(link, pc.createDataChannel("control", { ordered: true }));
      this.bindChannel(link, pc.createDataChannel("view", { ordered: false, maxRetransmits: 0 }));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.sendSignal({ type: "signal", to: id, data: { sdp: pc.localDescription } });
    }
    return link;
  }

  private bindChannel(link: PeerLink, channel: RTCDataChannel): void {
    if (channel.label === "control") link.control = channel;
    else if (channel.label === "view") link.view = channel;

    channel.addEventListener("open", () => {
      if (link.control?.readyState === "open") this.cb.onPeerReady(link.id);
      this.cb.onStatus("connected");
      this.emitPeers();
    });

    channel.addEventListener("message", (event) => {
      let message: SyncMessage;
      try {
        message = JSON.parse(String(event.data)) as SyncMessage;
      } catch {
        return;
      }
      if (message.type === "hello") {
        link.info.name = message.name;
        link.info.file = message.file;
        link.info.duration = message.duration;
        this.emitPeers();
      }
      this.cb.onMessage(link.id, message);
    });

    channel.addEventListener("close", () => this.emitPeers());
  }

  private async acceptSignal(from: string, data: unknown): Promise<void> {
    const payload = data as { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
    const link = this.peers.get(from) ?? (await this.connectTo(from, false));

    try {
      if (payload.sdp) {
        await link.pc.setRemoteDescription(payload.sdp);
        if (payload.sdp.type === "offer") {
          const answer = await link.pc.createAnswer();
          await link.pc.setLocalDescription(answer);
          this.sendSignal({ type: "signal", to: from, data: { sdp: link.pc.localDescription } });
        }
      } else if (payload.candidate) {
        await link.pc.addIceCandidate(payload.candidate);
      }
    } catch {
      // A candidate arriving before the remote description is normal; the
      // connection recovers on the next one.
    }
  }

  private dropPeer(id: string): void {
    const link = this.peers.get(id);
    if (!link) return;
    link.control?.close();
    link.view?.close();
    link.pc.close();
    this.peers.delete(id);
    this.emitPeers();
    if (this.peers.size === 0) this.cb.onStatus("waiting");
  }

  private emitPeers(): void {
    this.cb.onPeers([...this.peers.values()].map((p) => ({ ...p.info })));
  }

  /** Send on every peer's control channel (reliable). */
  broadcastControl(message: SyncMessage): void {
    for (const link of this.peers.values()) {
      if (link.control?.readyState === "open") link.control.send(JSON.stringify(message));
    }
  }

  /** Send on every peer's view channel (lossy, latest-wins). */
  broadcastView(message: SyncMessage): void {
    for (const link of this.peers.values()) {
      if (link.view?.readyState === "open") link.view.send(JSON.stringify(message));
    }
  }

  sendTo(id: string, message: SyncMessage): void {
    const link = this.peers.get(id);
    if (link?.control?.readyState === "open") link.control.send(JSON.stringify(message));
  }

  setRtt(id: string, rtt: number): void {
    const link = this.peers.get(id);
    if (link) link.info.rtt = rtt;
  }

  leave(): void {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    for (const id of [...this.peers.keys()]) this.dropPeer(id);
    this.sendSignal({ type: "leave" });
    this.ws?.close();
    this.ws = undefined;
    this.code = "";
    this.cb.onStatus("closed");
  }
}

export const connectionNote =
  "homecast connects the two browsers directly. If a direct path cannot be found — " +
  "some mobile networks and corporate firewalls — the connection fails rather than " +
  "relaying your traffic through a server.";
