/** Watch-together UI: room code, peers, view lock, resync (PLAN §4.3, M5). */
import { ROOM_PATH } from "../shared/protocol.ts";
import type { PeerInfo, RoomStatus } from "./room.ts";
import { connectionNote } from "./room.ts";

export interface RoomPanelCallbacks {
  onHost: () => void;
  onJoin: (code: string) => void;
  onLeave: () => void;
  onToggleViewLock: (locked: boolean) => void;
  onResync: () => void;
  onClose: () => void;
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export class RoomPanel {
  readonly root: HTMLElement;
  private readonly cb: RoomPanelCallbacks;
  private readonly idle: HTMLElement;
  private readonly active: HTMLElement;
  private readonly codeEl: HTMLElement;
  private readonly linkEl: HTMLInputElement;
  private readonly statusEl: HTMLElement;
  private readonly peerList: HTMLElement;
  private readonly lockToggle: HTMLInputElement;
  private readonly codeInput: HTMLInputElement;

  constructor(cb: RoomPanelCallbacks) {
    this.cb = cb;
    this.root = el("div", "panel room-panel");

    const header = el("div", "chapters-header");
    header.append(el("h1", undefined, "Watch together"));
    const spacer = el("div", "spacer");
    const close = el("button", "btn", "Close");
    close.addEventListener("click", () => this.cb.onClose());
    header.append(spacer, close);

    // --- idle: host or join -------------------------------------------------
    this.idle = el("div");
    this.idle.append(
      el("p", "dim-text",
        "Both of you open your own copy of the same file. Only the playhead and " +
        "view direction are shared — the video never leaves either machine."),
    );

    const hostBtn = el("button", "btn", "Start a room");
    hostBtn.addEventListener("click", () => this.cb.onHost());

    this.codeInput = el("input", "code-input");
    this.codeInput.placeholder = "code";
    this.codeInput.maxLength = 7;
    this.codeInput.autocapitalize = "characters";
    this.codeInput.spellcheck = false;
    const joinBtn = el("button", "btn", "Join");
    const doJoin = () => {
      const code = this.codeInput.value.trim();
      if (code) this.cb.onJoin(code);
    };
    joinBtn.addEventListener("click", doJoin);
    this.codeInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doJoin();
      e.stopPropagation(); // typing a code must not trigger player shortcuts
    });

    const row = el("div", "room-actions");
    row.append(hostBtn, el("span", "dim-text", "or"), this.codeInput, joinBtn);
    this.idle.append(row);

    // --- active: connected --------------------------------------------------
    this.active = el("div");
    this.active.hidden = true;

    this.codeEl = el("div", "room-code", "-----");
    const codeWrap = el("div", "room-code-wrap");
    codeWrap.append(el("div", "dim-text", "Room code"), this.codeEl);

    this.linkEl = el("input", "room-link");
    this.linkEl.readOnly = true;
    const copy = el("button", "btn", "Copy link");
    copy.addEventListener("click", () => {
      this.linkEl.select();
      void navigator.clipboard?.writeText(this.linkEl.value).catch(() => document.execCommand("copy"));
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy link"), 1600);
    });
    const linkRow = el("div", "room-actions");
    linkRow.append(this.linkEl, copy);

    this.statusEl = el("div", "room-status");
    this.peerList = el("div", "peer-list");

    const lockLabel = el("label", "toggle");
    this.lockToggle = el("input");
    this.lockToggle.type = "checkbox";
    this.lockToggle.checked = true;
    this.lockToggle.addEventListener("change", () => this.cb.onToggleViewLock(this.lockToggle.checked));
    lockLabel.append(this.lockToggle, el("span", undefined, "Lock view to theirs"));

    const resync = el("button", "btn", "Resync to me");
    resync.title = "Force everyone onto your playhead";
    resync.addEventListener("click", () => this.cb.onResync());
    const leave = el("button", "btn danger", "Leave room");
    leave.addEventListener("click", () => this.cb.onLeave());

    const controls = el("div", "room-actions");
    controls.append(lockLabel, el("div", "spacer"), resync, leave);

    this.active.append(codeWrap, linkRow, this.statusEl, this.peerList, controls);

    const note = el("p", "dim-text", connectionNote);
    this.root.append(header, this.idle, this.active, note);
  }

  setRoom(code: string): void {
    this.idle.hidden = true;
    this.active.hidden = false;
    this.codeEl.textContent = code;
    this.linkEl.value = `${location.origin}${ROOM_PATH}${code}`;
  }

  setIdle(): void {
    this.idle.hidden = false;
    this.active.hidden = true;
  }

  setStatus(status: RoomStatus, detail?: string): void {
    const text: Record<RoomStatus, string> = {
      idle: "",
      connecting: "Connecting…",
      waiting: "Waiting for someone to join — send them the link",
      connected: "Connected",
      failed: detail ?? "Connection failed",
      closed: "",
    };
    this.statusEl.textContent = detail && status !== "failed" ? `${text[status]} · ${detail}` : text[status];
    this.statusEl.className = `room-status ${status}`;
  }

  setPeers(peers: PeerInfo[]): void {
    this.peerList.replaceChildren();
    if (!peers.length) return;
    for (const peer of peers) {
      const row = el("div", "peer-row");
      row.append(el("span", "peer-dot " + peer.connectionState));
      row.append(el("span", "peer-name", peer.file ?? peer.name ?? peer.id));
      const meta: string[] = [peer.connectionState];
      if (peer.rtt !== undefined) meta.push(`${Math.round(peer.rtt)} ms`);
      row.append(el("span", "peer-meta", meta.join(" · ")));
      this.peerList.append(row);
    }
  }

  setViewLocked(locked: boolean): void {
    this.lockToggle.checked = locked;
  }
}
