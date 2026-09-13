/** Watch-together panel: room code, who is here, and sharing the video. */
import { ROOM_PATH } from "../shared/protocol.ts";
import type { PeerInfo, RoomStatus } from "./room.ts";

export interface RoomPanelCallbacks {
  onHost: () => void;
  onJoin: (code: string) => void;
  onLeave: () => void;
  onToggleViewLock: (locked: boolean) => void;
  onResync: () => void;
  onClose: () => void;
  /** start offering the video from this browser; returns the link to send */
  onShareDirect: () => string;
  /** upload to Pingvin; progress arrives through setShare */
  onSharePingvin: () => void;
}

export interface ShareState {
  phase: "idle" | "working" | "ready" | "error";
  /** one short line: "Uploading 34%", "Link ready", "Sending · 34%" */
  label?: string;
  progress?: number;
  link?: string;
  onCancel?: () => void;
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

async function copy(text: string, input?: HTMLInputElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (input) {
      input.value = text;
      input.select();
    }
    return false;
  }
}

export class RoomPanel {
  readonly root: HTMLElement;
  private readonly cb: RoomPanelCallbacks;
  private readonly idle: HTMLElement;
  private readonly active: HTMLElement;
  private readonly codeEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly peerList: HTMLElement;
  private readonly lockToggle: HTMLInputElement;
  private readonly codeInput: HTMLInputElement;
  private code = "";

  private readonly shareBox: HTMLElement;
  private readonly pingvinBtn: HTMLButtonElement;
  private readonly directBtn: HTMLButtonElement;
  private readonly shareLabel: HTMLElement;
  private readonly shareBar: HTMLElement;
  private readonly shareFill: HTMLElement;
  private readonly shareCancel: HTMLButtonElement;
  private readonly linkRow: HTMLElement;
  private readonly linkInput: HTMLInputElement;
  private readonly linkCopy: HTMLButtonElement;
  private cancel?: () => void;

  constructor(cb: RoomPanelCallbacks) {
    this.cb = cb;
    this.root = el("div", "panel room-panel");

    const header = el("div", "chapters-header");
    header.append(el("h1", undefined, "Watch together"));
    const close = el("button", "btn", "Close");
    close.addEventListener("click", () => this.cb.onClose());
    header.append(el("div", "spacer"), close);

    // --- not in a room -------------------------------------------------------
    this.idle = el("div", "room-idle");
    const hostBtn = el("button", "btn primary-small", "Start a room");
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

    // --- in a room -----------------------------------------------------------
    this.active = el("div");
    this.active.hidden = true;

    const codeRow = el("div", "room-code-row");
    this.codeEl = el("div", "room-code", "-----");
    const invite = el("button", "btn", "Copy invite");
    invite.addEventListener("click", () => {
      void copy(`${location.origin}${ROOM_PATH}${this.code}`).then((ok) => flash(invite, ok ? "Copied" : "Copy failed"));
    });
    codeRow.append(this.codeEl, invite);
    this.statusEl = el("div", "room-status");
    this.peerList = el("div", "peer-list");

    // Share the video: two buttons, one progress line, one link.
    this.shareBox = el("div", "share-video");
    this.shareBox.hidden = true;
    const shareTitle = el("div", "share-title", "Share the video");
    const buttons = el("div", "share-buttons");
    this.pingvinBtn = el("button", "btn share-btn", "Pingvin");
    this.pingvinBtn.hidden = true;
    this.pingvinBtn.addEventListener("click", () => this.cb.onSharePingvin());
    this.directBtn = el("button", "btn share-btn", "From this browser");
    this.directBtn.addEventListener("click", () => {
      const link = this.cb.onShareDirect();
      this.setShare({ phase: "ready", label: "Keep this tab open while they download", link });
      void copy(link, this.linkInput).then((ok) => ok && flash(this.linkCopy, "Copied"));
    });
    buttons.append(this.pingvinBtn, this.directBtn);

    this.shareLabel = el("div", "share-label");
    this.shareBar = el("div", "transfer-bar");
    this.shareFill = el("div", "transfer-fill");
    this.shareBar.append(this.shareFill);
    this.shareCancel = el("button", "btn ghost", "Cancel");
    this.shareCancel.addEventListener("click", () => this.cancel?.());
    const progressRow = el("div", "share-progress");
    progressRow.append(this.shareBar, this.shareCancel);

    this.linkRow = el("div", "room-actions");
    this.linkInput = el("input", "room-link");
    this.linkInput.readOnly = true;
    this.linkCopy = el("button", "btn", "Copy link");
    this.linkCopy.addEventListener("click", () => {
      void copy(this.linkInput.value, this.linkInput).then((ok) => ok && flash(this.linkCopy, "Copied"));
    });
    this.linkRow.append(this.linkInput, this.linkCopy);

    this.shareBox.append(shareTitle, buttons, this.shareLabel, progressRow, this.linkRow);
    this.setShare({ phase: "idle" });

    const lockLabel = el("label", "toggle");
    this.lockToggle = el("input");
    this.lockToggle.type = "checkbox";
    this.lockToggle.checked = true;
    this.lockToggle.addEventListener("change", () => this.cb.onToggleViewLock(this.lockToggle.checked));
    lockLabel.append(this.lockToggle, el("span", undefined, "Follow their view"));
    const resync = el("button", "btn", "Resync");
    resync.title = "Put everyone on your playhead";
    resync.addEventListener("click", () => this.cb.onResync());
    const leave = el("button", "btn danger", "Leave");
    leave.addEventListener("click", () => this.cb.onLeave());
    const controls = el("div", "room-actions room-controls");
    controls.append(lockLabel, el("div", "spacer"), resync, leave);

    this.active.append(codeRow, this.statusEl, this.peerList, this.shareBox, controls);
    this.root.append(header, this.idle, this.active);
  }

  setRoom(code: string): void {
    this.code = code;
    this.idle.hidden = true;
    this.active.hidden = false;
    this.codeEl.textContent = code;
  }

  setIdle(): void {
    this.idle.hidden = false;
    this.active.hidden = true;
    this.setShare({ phase: "idle" });
  }

  setStatus(status: RoomStatus, detail?: string): void {
    const text: Record<RoomStatus, string> = {
      idle: "",
      connecting: "Connecting…",
      waiting: "Waiting for someone to join",
      connected: "Connected",
      failed: detail ?? "Connection failed",
      closed: "",
    };
    this.statusEl.textContent = text[status];
    this.statusEl.className = `room-status ${status}`;
  }

  setPeers(peers: PeerInfo[]): void {
    this.peerList.replaceChildren(
      ...peers.map((peer) => {
        const row = el("div", "peer-row");
        row.append(el("span", "peer-dot " + peer.connectionState));
        row.append(el("span", "peer-name", peer.file ?? "Viewer"));
        if (peer.rtt !== undefined) row.append(el("span", "peer-meta", `${Math.round(peer.rtt)} ms`));
        return row;
      }),
    );
  }

  setViewLocked(locked: boolean): void {
    this.lockToggle.checked = locked;
  }

  /** The share section only makes sense with a video open. */
  setHasFile(hasFile: boolean): void {
    this.shareBox.hidden = !hasFile;
  }

  setPingvin(enabled: boolean): void {
    this.pingvinBtn.hidden = !enabled;
  }

  setShare(state: ShareState): void {
    const working = state.phase === "working";
    this.pingvinBtn.disabled = working;
    this.directBtn.disabled = working;
    this.shareLabel.textContent = state.label ?? "";
    this.shareLabel.hidden = !state.label;
    this.shareLabel.classList.toggle("warn-text", state.phase === "error");
    this.shareBar.hidden = state.progress === undefined;
    this.shareFill.style.width = `${Math.min(1, Math.max(0, state.progress ?? 0)) * 100}%`;
    this.cancel = state.onCancel;
    this.shareCancel.hidden = !state.onCancel;
    this.shareCancel.parentElement!.hidden = state.progress === undefined && !state.onCancel;
    this.linkRow.hidden = !state.link;
    if (state.link) this.linkInput.value = state.link;
  }
}

function flash(button: HTMLButtonElement, text: string): void {
  const original = button.dataset.label ?? button.textContent ?? "";
  button.dataset.label = original;
  button.textContent = text;
  setTimeout(() => (button.textContent = original), 1500);
}
