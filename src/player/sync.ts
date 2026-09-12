/**
 * Keeping two playheads and two viewpoints together (PLAN §4.3, M5).
 *
 * Three problems, three mechanisms:
 *
 * 1. **Clocks differ.** Two machines disagree about `Date.now()` by anything
 *    from milliseconds to minutes, so a timestamped playhead is meaningless
 *    until the offset is measured. NTP-style ping/pong does that.
 *
 * 2. **Playheads drift.** Decoding is never exactly realtime. Small drift is
 *    corrected by nudging `playbackRate` (invisible); large drift by seeking
 *    (visible, but better than being a second apart).
 *
 * 3. **Both people can grab the view at once.** Whoever moved most recently
 *    leads, decided by comparing timestamps on the shared clock — so it settles
 *    without anyone being designated the host.
 */
import {
  HARD_DRIFT_SECONDS, SOFT_DRIFT_SECONDS, SETTLED_DRIFT_SECONDS, MAX_RATE_ADJUST,
  STATE_INTERVAL_MS, VIEW_HZ, ECHO_WINDOW_MS, type SyncMessage, type ViewMessage,
} from "../shared/protocol.ts";
import type { Room } from "./room.ts";
import type { ViewDirection } from "../shared/chapters.ts";

export interface PeerGaze {
  id: string;
  yaw: number;
  pitch: number;
  fov: number;
  updatedAt: number;
}

export interface SyncHooks {
  video: () => HTMLVideoElement;
  view: () => ViewDirection;
  applyView: (view: ViewDirection) => void;
  /** called when a peer's gaze changes, for the presence marker */
  onGaze: (gazes: PeerGaze[]) => void;
  onNotice: (message: string, warn?: boolean) => void;
  /** file name + duration advertised to peers, to catch mismatched files */
  identity: () => { name: string; file?: string; duration?: number };
}

interface PeerClock {
  /** remote clock minus local clock, ms */
  offset: number;
  rtt: number;
  samples: number;
}

export class Sync {
  private readonly room: Room;
  private readonly hooks: SyncHooks;
  private readonly clocks = new Map<string, PeerClock>();
  private readonly gazes = new Map<string, PeerGaze>();

  /** local clock time of our last deliberate view movement */
  private lastLocalMoveAt = 0;
  /** shared-clock time of the newest movement we have seen from anyone */
  private leaderMovedAt = 0;

  private stateTimer?: number;
  private viewTimer?: number;
  private clockTimer?: number;
  private viewDirty = false;
  private rateAdjusted = false;
  private applyingRemote = false;
  /**
   * `video.play()` and `.pause()` emit their events asynchronously, after the
   * synchronous `applyingRemote` guard has already been cleared — so applying a
   * peer's action echoed it straight back, and each round trip added the
   * latency compensation again. Two viewers drifted seconds apart in seconds.
   * A short window suppresses the echo; deliberate actions inside it are
   * recovered by the next state broadcast.
   */
  private remoteAppliedAt = 0;
  private warnedMismatch = new Set<string>();

  /** View sync is locked by default, with an unlink toggle (§4.3). */
  viewLocked = true;

  constructor(room: Room, hooks: SyncHooks) {
    this.room = room;
    this.hooks = hooks;
  }

  start(): void {
    this.stop();
    this.clockTimer = window.setInterval(() => this.probeClocks(), 5000);
    this.stateTimer = window.setInterval(() => this.broadcastState(), STATE_INTERVAL_MS);
    this.viewTimer = window.setInterval(() => this.flushView(), 1000 / VIEW_HZ);
  }

  stop(): void {
    for (const t of [this.stateTimer, this.viewTimer, this.clockTimer]) if (t) clearInterval(t);
    this.stateTimer = this.viewTimer = this.clockTimer = undefined;
    this.clocks.clear();
    this.gazes.clear();
    this.restoreRate();
    this.hooks.onGaze([]);
  }

  /** Say hello and start measuring the clock offset. */
  greet(peerId: string): void {
    const id = this.hooks.identity();
    this.room.sendTo(peerId, { type: "hello", name: id.name, file: id.file, duration: id.duration });
    this.room.sendTo(peerId, { type: "clock-ping", c0: Date.now() });
  }

  private probeClocks(): void {
    this.room.broadcastControl({ type: "clock-ping", c0: Date.now() });
  }

  // --- outbound ------------------------------------------------------------

  /** A deliberate action by this user; peers apply it immediately. */
  sendControl(action: "play" | "pause" | "seek", view?: ViewDirection): void {
    if (this.applyingRemote) return; // do not echo what we were just told
    if (Date.now() - this.remoteAppliedAt < ECHO_WINDOW_MS) return;
    const video = this.hooks.video();
    this.room.broadcastControl({ type: "control", action, t: video.currentTime, at: Date.now(), view });
  }

  /** Called whenever the local user drags, zooms or otherwise moves the view. */
  noteLocalMove(): void {
    if (this.applyingRemote) return;
    this.lastLocalMoveAt = Date.now();
    this.leaderMovedAt = Math.max(this.leaderMovedAt, this.lastLocalMoveAt);
    this.viewDirty = true;
  }

  private flushView(): void {
    if (!this.viewDirty || this.room.peerCount === 0) return;
    this.viewDirty = false;
    const v = this.hooks.view();
    this.room.broadcastView({
      type: "view",
      yaw: v.yaw,
      pitch: v.pitch,
      fov: v.fov,
      movedAt: this.lastLocalMoveAt,
    });
  }

  private broadcastState(): void {
    if (this.room.peerCount === 0) return;
    const video = this.hooks.video();
    if (!Number.isFinite(video.duration)) return;
    this.room.broadcastControl({
      type: "state",
      t: video.currentTime,
      playing: !video.paused,
      at: Date.now(),
      duration: video.duration,
    });
  }

  // --- inbound -------------------------------------------------------------

  handle(from: string, message: SyncMessage): void {
    switch (message.type) {
      case "clock-ping":
        this.room.sendTo(from, { type: "clock-pong", c0: message.c0, s1: Date.now() });
        return;

      case "clock-pong": {
        const c3 = Date.now();
        const rtt = c3 - message.c0;
        // Standard NTP estimate; the remote's clock is `offset` ms ahead.
        const offset = (message.s1 - message.c0 + (message.s1 - c3)) / 2;
        const prev = this.clocks.get(from);
        // Favour the lowest-RTT sample — it has the least asymmetry error.
        if (!prev || rtt <= prev.rtt || prev.samples > 12) {
          this.clocks.set(from, { offset, rtt, samples: (prev?.samples ?? 0) + 1 });
        } else {
          prev.samples++;
        }
        this.room.setRtt(from, rtt);
        return;
      }

      case "hello": {
        const mine = this.hooks.identity();
        if (
          message.duration && mine.duration &&
          Math.abs(message.duration - mine.duration) > 1 &&
          !this.warnedMismatch.has(from)
        ) {
          this.warnedMismatch.add(from);
          this.hooks.onNotice(
            `That viewer's file is ${Math.round(message.duration)}s long, yours is ` +
              `${Math.round(mine.duration)}s — you are probably watching different files.`,
            true,
          );
        }
        return;
      }

      case "control":
        this.applyControl(from, message);
        return;

      case "state":
        this.correctDrift(from, message.t, message.playing, message.at);
        return;

      case "view":
        this.applyView(from, message);
        return;
    }
  }

  private applyControl(from: string, message: Extract<SyncMessage, { type: "control" }>): void {
    const video = this.hooks.video();
    const age = this.ageSeconds(from, message.at);

    this.remoteAppliedAt = Date.now();
    this.applyingRemote = true;
    try {
      if (message.action === "pause") {
        video.pause();
        video.currentTime = message.t;
      } else if (message.action === "seek") {
        // Where they would be now, not where they were when they pressed it.
        video.currentTime = message.t + (video.paused ? 0 : Math.max(0, age));
      } else {
        video.currentTime = message.t + Math.max(0, age);
        void video.play().catch(() => this.hooks.onNotice("Press play — the browser blocked autoplay", true));
      }
      if (message.view && this.viewLocked) this.hooks.applyView(message.view);
    } finally {
      this.applyingRemote = false;
    }
  }

  /**
   * Whoever has the lowest id owns the timeline. It needs no negotiation, every
   * peer computes the same answer, and it survives someone leaving. Without it
   * each peer corrects toward the other and they oscillate instead of settling.
   */
  private timelineOwner(): string {
    return this.room.allIds()[0] ?? "";
  }

  private correctDrift(from: string, remoteT: number, remotePlaying: boolean, at: number): void {
    const video = this.hooks.video();
    if (!Number.isFinite(video.duration)) return;

    // Only ever follow the owner, and never when we are the owner ourselves.
    const owner = this.timelineOwner();
    if (from !== owner || owner === this.room.id) {
      this.restoreRate();
      return;
    }

    // Only follow a peer that is playing while we are; correcting against a
    // paused peer would fight with whoever is scrubbing.
    if (video.paused || !remotePlaying) {
      this.restoreRate();
      return;
    }

    const expected = remoteT + this.ageSeconds(from, at);
    const drift = expected - video.currentTime; // positive: we are behind

    if (Math.abs(drift) > HARD_DRIFT_SECONDS) {
      this.remoteAppliedAt = Date.now();
      this.applyingRemote = true;
      try {
        video.currentTime = expected;
      } finally {
        this.applyingRemote = false;
      }
      this.restoreRate();
      return;
    }

    // Hysteresis: begin easing at SOFT, but keep easing until well inside
    // SETTLED, so the rate returns to exactly 1 instead of hovering.
    const shouldEase = this.rateAdjusted
      ? Math.abs(drift) > SETTLED_DRIFT_SECONDS
      : Math.abs(drift) > SOFT_DRIFT_SECONDS;

    if (shouldEase) {
      const adjust = Math.max(-MAX_RATE_ADJUST, Math.min(MAX_RATE_ADJUST, drift * 0.25));
      video.playbackRate = 1 + adjust;
      this.rateAdjusted = true;
    } else {
      this.restoreRate();
    }
  }

  private applyView(from: string, message: ViewMessage): void {
    const clock = this.clocks.get(from);
    // Convert their movement time onto our clock before comparing.
    const movedAtLocal = message.movedAt - (clock?.offset ?? 0);

    this.gazes.set(from, {
      id: from,
      yaw: message.yaw,
      pitch: message.pitch,
      fov: message.fov,
      updatedAt: Date.now(),
    });
    this.hooks.onGaze([...this.gazes.values()]);

    if (!this.viewLocked) return;
    // Last mover leads. If we moved more recently than they did, we keep the
    // view — which is what stops two locked viewers fighting over it.
    if (movedAtLocal <= this.lastLocalMoveAt) return;
    this.leaderMovedAt = movedAtLocal;

    this.applyingRemote = true;
    try {
      this.hooks.applyView({ yaw: message.yaw, pitch: message.pitch, fov: message.fov });
    } finally {
      this.applyingRemote = false;
    }
  }

  // --- helpers -------------------------------------------------------------

  /** Seconds elapsed since a peer sent something, corrected for clock skew. */
  private ageSeconds(from: string, remoteSentAt: number): number {
    const clock = this.clocks.get(from);
    const localSentAt = remoteSentAt - (clock?.offset ?? 0);
    const age = (Date.now() - localSentAt) / 1000;
    // A wild value means the offset is not measured yet; do not act on it.
    return Number.isFinite(age) && Math.abs(age) < 30 ? age : 0;
  }

  private restoreRate(): void {
    if (!this.rateAdjusted) return;
    this.hooks.video().playbackRate = 1;
    this.rateAdjusted = false;
  }

  /** Keep pitch fixed while the rate is nudged — this is music (§7.3). */
  static preservePitch(video: HTMLVideoElement): void {
    video.preservesPitch = true;
  }

  /** Force everyone onto our playhead — the ad-drift escape hatch (§4.4). */
  resync(): void {
    const video = this.hooks.video();
    this.room.broadcastControl({
      type: "control",
      action: video.paused ? "pause" : "play",
      t: video.currentTime,
      at: Date.now(),
    });
    this.hooks.onNotice("Resynced everyone to your playhead");
  }

  peerRtt(id: string): number | undefined {
    return this.clocks.get(id)?.rtt;
  }

  dropPeer(id: string): void {
    this.clocks.delete(id);
    this.gazes.delete(id);
    this.warnedMismatch.delete(id);
    this.hooks.onGaze([...this.gazes.values()]);
  }
}
