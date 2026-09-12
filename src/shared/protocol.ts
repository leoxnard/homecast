/**
 * Watch-together wire protocol (PLAN §4.2, §4.3, M5).
 *
 * Two transports, both carrying a few hundred bytes at a time:
 *
 *  - **signalling** (WebSocket, via the server) — only until the peers connect
 *  - **sync** (WebRTC data channel, peer-to-peer) — everything after that
 *
 * No video, no file contents, no file paths. Each viewer opens their own local
 * copy; the only thing shared is where they are in it and where they are
 * looking (§1).
 */
import type { ViewDirection } from "./chapters.ts";

// --- signalling (client ↔ server) -------------------------------------------

export type ClientSignal =
  | { type: "join"; room: string }
  | { type: "signal"; to: string; data: unknown }
  | { type: "leave" }
  | { type: "ping"; t: number };

export type ServerSignal =
  | { type: "hello"; self: string }
  | { type: "joined"; room: string; self: string; peers: string[] }
  | { type: "peer-join"; peer: string }
  | { type: "peer-leave"; peer: string }
  | { type: "signal"; from: string; data: unknown }
  | { type: "left" }
  | { type: "pong"; t: number }
  | { type: "error"; message: string; code?: string };

// --- sync (peer ↔ peer, over the data channel) ------------------------------

/** Clock alignment, NTP-style. Machine clocks differ; playheads must not. */
export interface ClockPing {
  type: "clock-ping";
  /** sender's clock when it sent this */
  c0: number;
}
export interface ClockPong {
  type: "clock-pong";
  c0: number;
  /** responder's clock when it replied */
  s1: number;
}

/** Periodic heartbeat from whoever currently owns the timeline. */
export interface StateMessage {
  type: "state";
  /** playhead in seconds */
  t: number;
  playing: boolean;
  /** sender's clock when sampled, for latency compensation */
  at: number;
  /** so a peer can tell it is watching a different file */
  duration: number;
}

/** A deliberate action: someone pressed play, paused, or jumped. */
export interface ControlMessage {
  type: "control";
  action: "play" | "pause" | "seek";
  t: number;
  at: number;
  /** set when the jump came from a chapter, so the view can follow too */
  view?: ViewDirection;
}

/** Where this peer is looking. Sent often, cheap, and safe to lose. */
export interface ViewMessage {
  type: "view";
  yaw: number;
  pitch: number;
  fov: number;
  /** sender's clock at their last deliberate movement — decides who leads */
  movedAt: number;
}

/** Sent once when a channel opens, so each side can label the other. */
export interface HelloMessage {
  type: "hello";
  name: string;
  /** basename only — never a path (§1) */
  file?: string;
  duration?: number;
}

export type SyncMessage = ClockPing | ClockPong | StateMessage | ControlMessage | ViewMessage | HelloMessage;

// --- tuning -----------------------------------------------------------------

/** Beyond this the playheads are visibly apart: jump rather than ease. */
export const HARD_DRIFT_SECONDS = 0.75;
/** Start easing above this. Below it, correcting is more distracting than drift. */
export const SOFT_DRIFT_SECONDS = 0.15;
/**
 * Stop easing below this. Without the gap between the two, a correction that
 * lands near the threshold oscillates in and out of it and the rate never
 * returns to 1 — audible on sustained music even with pitch preservation.
 */
export const SETTLED_DRIFT_SECONDS = 0.05;
/**
 * Gentle rate nudge between the thresholds. 2% is inaudible on music; 4% is
 * not, and this player exists for concert footage.
 */
export const MAX_RATE_ADJUST = 0.02;
/** How often the timeline owner broadcasts where it is. */
export const STATE_INTERVAL_MS = 1000;
/** View updates per second while someone is actually moving. */
export const VIEW_HZ = 20;

/**
 * How long after applying a peer's play/pause to ignore our own media events.
 * Those events are asynchronous, so without this the action echoes back and
 * each round trip re-applies the latency compensation.
 */
export const ECHO_WINDOW_MS = 500;

/** Room codes look like `/w/7QK2M`. */
export const ROOM_PATH = "/w/";
