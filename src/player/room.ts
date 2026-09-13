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
import { safeHttpUrl, type ServerSignal, type SyncMessage } from "../shared/protocol.ts";

/**
 * STUN finds a direct path for the common case of two home connections.
 * Symmetric NAT (most mobile data) or a UDP-blocking firewall needs a TURN
 * relay, which the server hands out from /api/ice only when one is configured.
 */
const FALLBACK_ICE: RTCIceServer[] = [
  { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] },
];

let iceConfig: Promise<{ iceServers: RTCIceServer[]; turn: boolean }> | undefined;
let iceFetchedAt = 0;
/** TURN credentials expire (server TTL 6 h), so refetch well before that. */
function loadIce(): Promise<{ iceServers: RTCIceServer[]; turn: boolean }> {
  if (!iceConfig || Date.now() - iceFetchedAt > 60 * 60 * 1000) {
    iceFetchedAt = Date.now();
    iceConfig = fetch("/api/ice", { cache: "no-store" })
      .then((r) => r.json() as Promise<{ iceServers?: RTCIceServer[]; turn?: boolean }>)
      .then((b) => ({ iceServers: b.iceServers?.length ? b.iceServers : FALLBACK_ICE, turn: !!b.turn }))
      .catch(() => ({ iceServers: FALLBACK_ICE, turn: false }));
  }
  return iceConfig;
}

/**
 * 64 KiB: within every browser's SCTP message limit. Measured Chrome → Chrome:
 * 64 KiB moved 11.5–15 MB/s; 256 KiB with a 16 MB buffer dropped to ~4 MB/s
 * and stalled — bigger is not faster on a data channel.
 */
const FILE_CHUNK = 64 * 1024;
const FILE_BUFFER_HIGH = 8 * 1024 * 1024;
const FILE_BUFFER_LOW = 2 * 1024 * 1024;

export interface PeerRoute {
  kind: "local" | "internet" | "relay";
  /** ICE over TCP: works through strict firewalls, but far slower for bulk data */
  tcp: boolean;
  rtt?: number;
}

function isPrivateAddress(address: string | undefined): boolean {
  if (!address) return false;
  return (
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.)/.test(address) ||
    /^(fd|fc|fe80)/i.test(address) ||
    address.endsWith(".local")
  );
}

export type RoomStatus = "idle" | "connecting" | "waiting" | "connected" | "failed" | "closed";

export interface PeerInfo {
  id: string;
  name?: string;
  file?: string;
  duration?: number;
  /** validated http(s) download link the peer shared, if any */
  shareUrl?: string;
  connectionState: RTCPeerConnectionState;
  /** round-trip time over the data channel, ms */
  rtt?: number;
}

export interface RoomCallbacks {
  onStatus: (status: RoomStatus, detail?: string) => void;
  onPeers: (peers: PeerInfo[]) => void;
  onMessage: (from: string, message: SyncMessage) => void;
  /** a peer's control channel just became usable (fires once per peer) */
  onPeerReady: (id: string) => void;
  /** raw bytes arrived on a peer's file channel */
  onFileData?: (from: string, data: ArrayBuffer) => void;
  onFileChannel?: (id: string, open: boolean) => void;
  onPeerLeft?: (id: string) => void;
}

interface PeerLink {
  id: string;
  pc: RTCPeerConnection;
  control?: RTCDataChannel;
  view?: RTCDataChannel;
  /** raw video bytes for host → friend transfer; binary, ordered, reliable */
  file?: RTCDataChannel;
  info: PeerInfo;
  /** true when we created the offer */
  initiator: boolean;
  /** onPeerReady fires once per peer, not once per channel that opens */
  readyNotified: boolean;
  /** ICE restarts tried since the connection last worked */
  restarts: number;
  disconnectTimer?: number;
  /** candidates that arrived before the remote description, applied right after it */
  pendingCandidates: RTCIceCandidateInit[];
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
  private signalQueue: Promise<void> = Promise.resolve();

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
      // Strictly in order: an ICE candidate handled before the offer it belongs
      // to is rejected, and a dropped candidate can be the only working path.
      this.signalQueue = this.signalQueue.then(() => this.handleSignal(message)).catch(() => {});
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

    const ice = await loadIce();
    const again = this.peers.get(id); // a signal may have created it while we waited
    if (again) return again;
    const pc = new RTCPeerConnection({ iceServers: ice.iceServers });
    const link: PeerLink = {
      id,
      pc,
      initiator,
      info: { id, connectionState: pc.connectionState },
      readyNotified: false,
      restarts: 0,
      pendingCandidates: [],
    };
    this.peers.set(id, link);

    pc.addEventListener("icecandidate", (e) => {
      if (e.candidate) this.sendSignal({ type: "signal", to: id, data: { candidate: e.candidate } });
    });

    pc.addEventListener("connectionstatechange", () => {
      link.info.connectionState = pc.connectionState;
      if (link.disconnectTimer) clearTimeout(link.disconnectTimer);
      if (pc.connectionState === "connected") {
        link.restarts = 0;
        this.cb.onStatus("connected");
      } else if (pc.connectionState === "disconnected") {
        // Often a network switch (Wi-Fi → mobile); give it a moment, then renegotiate.
        link.disconnectTimer = window.setTimeout(() => void this.restartIce(link), 4000);
      } else if (pc.connectionState === "failed") {
        if (link.restarts < 2) void this.restartIce(link);
        else void this.explainFailure(link).then((why) => this.cb.onStatus("failed", why));
      }
      this.emitPeers();
    });

    pc.addEventListener("datachannel", (e) => this.bindChannel(link, e.channel));

    if (initiator) {
      this.bindChannel(link, pc.createDataChannel("control", { ordered: true }));
      this.bindChannel(link, pc.createDataChannel("view", { ordered: false, maxRetransmits: 0 }));
      this.bindChannel(link, pc.createDataChannel("file", { ordered: true }));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.sendSignal({ type: "signal", to: id, data: { sdp: pc.localDescription } });
    }
    return link;
  }

  private bindChannel(link: PeerLink, channel: RTCDataChannel): void {
    if (channel.label === "file") {
      link.file = channel;
      channel.binaryType = "arraybuffer";
      channel.addEventListener("message", (event) => {
        if (event.data instanceof ArrayBuffer) this.cb.onFileData?.(link.id, event.data);
      });
      channel.addEventListener("open", () => this.cb.onFileChannel?.(link.id, true));
      channel.addEventListener("close", () => this.cb.onFileChannel?.(link.id, false));
      return;
    }
    if (channel.label === "control") link.control = channel;
    else if (channel.label === "view") link.view = channel;

    channel.addEventListener("open", () => {
      if (link.control?.readyState === "open" && !link.readyNotified) {
        link.readyNotified = true;
        this.cb.onPeerReady(link.id);
      }
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
        link.info.shareUrl = safeHttpUrl(message.shareUrl);
        this.emitPeers();
      }
      this.cb.onMessage(link.id, message);
    });

    channel.addEventListener("close", () => this.emitPeers());
  }

  /**
   * Renegotiate the network path without tearing down the data channels. Only
   * the side that made the original offer restarts, so the two never collide;
   * the other side asks it to via a signal.
   */
  private async restartIce(link: PeerLink, force = false): Promise<void> {
    if (!this.peers.has(link.id) || link.pc.signalingState === "closed") return;
    if (link.pc.connectionState === "connected" && !force) return;
    if (!link.initiator) {
      this.sendSignal({ type: "signal", to: link.id, data: { restart: true, force } });
      link.restarts++;
      return;
    }
    link.restarts++;
    try {
      const offer = await link.pc.createOffer({ iceRestart: true });
      await link.pc.setLocalDescription(offer);
      this.sendSignal({ type: "signal", to: link.id, data: { sdp: link.pc.localDescription } });
    } catch {
      /* the next state change tries again or reports */
    }
  }

  /**
   * Safari only reveals this device's local network address to WebRTC once the
   * page has microphone or camera access. Without it, two Apple devices on the
   * same Wi-Fi cannot see each other and fall back to the router's public
   * address — which most home routers will not loop back — and then to the
   * relay, where every byte crosses the home uplink twice. Asking for the
   * microphone and stopping it at once (nothing is recorded) lifts that, and an
   * ICE restart then finds the local path. One side doing this is enough.
   */
  async unlockLocalNetwork(): Promise<boolean> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
    } catch {
      return false;
    }
    for (const link of this.peers.values()) void this.restartIce(link, true);
    return true;
  }

  /** Say why no path was found, from the candidates each side gathered. */
  private async explainFailure(link: PeerLink): Promise<string> {
    const { turn } = await loadIce();
    const local = new Set<string>();
    const remote = new Set<string>();
    try {
      (await link.pc.getStats()).forEach((s: { type: string; candidateType?: string }) => {
        if (s.type === "local-candidate" && s.candidateType) local.add(s.candidateType);
        if (s.type === "remote-candidate" && s.candidateType) remote.add(s.candidateType);
      });
    } catch {
      /* closed meanwhile */
    }
    const share = " Share the video via Pingvin instead.";
    if (remote.size === 0) return "Couldn't reach the other device — its network gave no way in." + (turn ? "" : share);
    if (!local.has("srflx") && !local.has("relay")) return "Your network blocks direct connections (UDP)." + (turn ? "" : share);
    return turn
      ? "Couldn't connect, not even through the relay."
      : "Your networks can't connect directly (common on mobile data)." + share;
  }

  private async acceptSignal(from: string, data: unknown): Promise<void> {
    const payload = data as {
      sdp?: RTCSessionDescriptionInit;
      candidate?: RTCIceCandidateInit;
      restart?: boolean;
      force?: boolean;
    };
    const link = this.peers.get(from) ?? (await this.connectTo(from, false));

    try {
      if (payload.restart) {
        if (link.initiator) await this.restartIce(link, payload.force === true);
      } else if (payload.sdp) {
        await link.pc.setRemoteDescription(payload.sdp);
        for (const candidate of link.pendingCandidates.splice(0)) {
          await link.pc.addIceCandidate(candidate).catch(() => {});
        }
        if (payload.sdp.type === "offer") {
          const answer = await link.pc.createAnswer();
          await link.pc.setLocalDescription(answer);
          this.sendSignal({ type: "signal", to: from, data: { sdp: link.pc.localDescription } });
        }
      } else if (payload.candidate) {
        if (link.pc.remoteDescription) await link.pc.addIceCandidate(payload.candidate);
        else link.pendingCandidates.push(payload.candidate);
      }
    } catch {
      // A malformed or stale message; the connection state handler recovers.
    }
  }

  private dropPeer(id: string): void {
    const link = this.peers.get(id);
    if (!link) return;
    if (link.disconnectTimer) clearTimeout(link.disconnectTimer);
    this.cb.onPeerLeft?.(id);
    link.control?.close();
    link.view?.close();
    link.file?.close();
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

  /**
   * Send one chunk of file bytes to a peer, waiting while the channel's send
   * buffer is full. Without this back-pressure the browser queues the whole
   * file in memory — fatal at 88 GB — and eventually closes the channel.
   */
  async sendFileChunk(id: string, chunk: ArrayBuffer): Promise<boolean> {
    const channel = this.peers.get(id)?.file;
    if (!channel || channel.readyState !== "open") return false;
    if (channel.bufferedAmount > FILE_BUFFER_HIGH) {
      channel.bufferedAmountLowThreshold = FILE_BUFFER_LOW;
      await new Promise<void>((resolve) => {
        const done = () => {
          channel.removeEventListener("bufferedamountlow", done);
          channel.removeEventListener("close", done);
          resolve();
        };
        channel.addEventListener("bufferedamountlow", done);
        channel.addEventListener("close", done);
      });
      if (channel.readyState !== "open") return false;
    }
    channel.send(chunk);
    return true;
  }

  /**
   * Resolve once everything queued on the file channel has actually left.
   * Control messages travel on a different SCTP stream with no ordering
   * relative to this one, so "file-end" sent before draining overtakes the
   * last megabytes of data — measured: a transfer "ended" 2.25 MB short.
   */
  async drainFileChannel(id: string): Promise<boolean> {
    const channel = this.peers.get(id)?.file;
    if (!channel) return false;
    while (channel.readyState === "open" && channel.bufferedAmount > 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return channel.readyState === "open";
  }

  /** Largest message this peer connection accepts, capped for cross-browser safety. */
  fileChunkSize(id: string): number {
    const max = this.peers.get(id)?.pc.sctp?.maxMessageSize ?? 0;
    return Math.max(16 * 1024, Math.min(max || FILE_CHUNK, FILE_CHUNK));
  }

  /**
   * How the connection to a peer actually travels, from the selected ICE
   * candidate pair. Shown during a transfer so a slow one can be explained:
   * two devices at home should say "same network"; "over the internet"
   * between them means the router did not keep the traffic local.
   */
  async route(id: string): Promise<PeerRoute | undefined> {
    const pc = this.peers.get(id)?.pc;
    if (!pc) return undefined;
    const stats = await pc.getStats();
    type Pair = { localCandidateId?: string; remoteCandidateId?: string; currentRoundTripTime?: number; nominated?: boolean; state?: string };
    type Candidate = { candidateType?: string; address?: string; protocol?: string };
    let pair: Pair | undefined;
    stats.forEach((s: { type: string; selectedCandidatePairId?: string }) => {
      if (s.type === "transport" && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId) as Pair;
    });
    if (!pair) {
      // Firefox and Safari do not expose the transport's selected pair.
      stats.forEach((s: Pair & { type: string }) => {
        if (!pair && s.type === "candidate-pair" && s.nominated && s.state === "succeeded") pair = s;
      });
    }
    if (!pair) return undefined;
    const local = stats.get(pair.localCandidateId ?? "") as Candidate | undefined;
    const remote = stats.get(pair.remoteCandidateId ?? "") as Candidate | undefined;
    const ends = [local, remote];
    const kind: PeerRoute["kind"] = ends.some((c) => c?.candidateType === "relay")
      ? "relay"
      : ends.every((c) => c?.candidateType === "host" || isPrivateAddress(c?.address))
        ? "local"
        : "internet";
    return {
      kind,
      tcp: local?.protocol === "tcp",
      rtt: pair.currentRoundTripTime !== undefined ? pair.currentRoundTripTime * 1000 : undefined,
    };
  }

  isFileChannelOpen(id: string): boolean {
    return this.peers.get(id)?.file?.readyState === "open";
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
