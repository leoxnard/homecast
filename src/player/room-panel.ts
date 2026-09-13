/** Watch-together UI: room code, peers, view lock, resync (PLAN §4.3, M5). */
import { ROOM_PATH, safeHttpUrl } from "../shared/protocol.ts";
import type { PeerInfo, RoomStatus } from "./room.ts";
import { connectionNote } from "./room.ts";

export interface RoomPanelCallbacks {
  onHost: () => void;
  onJoin: (code: string) => void;
  onLeave: () => void;
  onToggleViewLock: (locked: boolean) => void;
  onResync: () => void;
  onClose: () => void;
  /** save (or clear, with "") the download link for the file you have open */
  onShareUrl: (url: string) => void;
  /** let people who join download the playing video straight from this browser */
  onOfferVideo: (on: boolean) => void;
  /** turn offering on and return the room link that downloads automatically */
  onCopyVideoLink: () => string;
  /** upload the open video to Pingvin through the server relay */
  onUploadPingvin: () => void;
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
  private readonly shareInput: HTMLInputElement;
  private readonly shareSave: HTMLButtonElement;
  private readonly shareLabel: HTMLElement;
  private readonly getFile: HTMLElement;
  private readonly sendBox: HTMLElement;
  private readonly offerToggle: HTMLInputElement;
  private readonly offerStatus: HTMLElement;
  private readonly copyVideoLink: HTMLButtonElement;
  private readonly uploadBtn: HTMLButtonElement;
  private readonly uploadStatus: HTMLElement;
  private readonly uploadBar: HTMLElement;
  private readonly uploadFill: HTMLElement;
  private readonly uploadCancel: HTMLButtonElement;
  private cancelUpload?: () => void;

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

    // --- send the video directly ------------------------------------------
    this.sendBox = el("div", "send-box");
    const sendTitle = el("div", "send-title", "Send them the video");
    this.copyVideoLink = el("button", "btn primary-small", "Copy link with video");
    this.copyVideoLink.title = "Whoever opens it downloads the video from you, then joins in sync";
    this.copyVideoLink.addEventListener("click", () => {
      const url = this.cb.onCopyVideoLink();
      this.offerToggle.checked = true;
      const done = () => {
        this.copyVideoLink.textContent = "Copied";
        setTimeout(() => (this.copyVideoLink.textContent = "Copy link with video"), 1600);
      };
      void navigator.clipboard?.writeText(url).then(done, () => {
        this.linkEl.value = url;
        this.linkEl.select();
      });
    });
    const offerLabel = el("label", "toggle");
    this.offerToggle = el("input");
    this.offerToggle.type = "checkbox";
    this.offerToggle.addEventListener("change", () => this.cb.onOfferVideo(this.offerToggle.checked));
    offerLabel.append(this.offerToggle, el("span", undefined, "Let anyone in this room download it from me"));
    this.offerStatus = el("div", "dim-text small");
    const sendRow = el("div", "room-actions");
    sendRow.append(this.copyVideoLink, offerLabel);

    // Pingvin: shown only when the server has it configured.
    this.uploadBtn = el("button", "btn", "Upload to Pingvin");
    this.uploadBtn.title = "Upload once, so people can download it even while you're offline";
    this.uploadBtn.hidden = true;
    this.uploadBtn.addEventListener("click", () => this.cb.onUploadPingvin());
    this.uploadCancel = el("button", "btn ghost", "Cancel");
    this.uploadCancel.hidden = true;
    this.uploadCancel.addEventListener("click", () => this.cancelUpload?.());
    this.uploadStatus = el("div", "dim-text small");
    this.uploadBar = el("div", "transfer-bar");
    this.uploadFill = el("div", "transfer-fill");
    this.uploadBar.append(this.uploadFill);
    this.uploadBar.hidden = true;
    const uploadRow = el("div", "room-actions");
    uploadRow.append(this.uploadBtn, this.uploadCancel);

    this.sendBox.append(sendTitle, sendRow, this.offerStatus, uploadRow, this.uploadBar, this.uploadStatus);

    // --- where to get the file ------------------------------------------
    this.getFile = el("div", "get-file");
    this.getFile.hidden = true;

    const share = el("div", "share-box");
    this.shareLabel = el("div", "dim-text", "Download link for your file");
    this.shareInput = el("input", "room-link share-input");
    this.shareInput.type = "url";
    this.shareInput.placeholder = "https://share… (Pingvin, Google Drive, …)";
    this.shareInput.spellcheck = false;
    this.shareInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.saveShare();
      e.stopPropagation();
    });
    this.shareSave = el("button", "btn", "Share link");
    this.shareSave.addEventListener("click", () => this.saveShare());
    const shareRow = el("div", "room-actions");
    shareRow.append(this.shareInput, this.shareSave);
    share.append(
      this.shareLabel,
      shareRow,
      el("p", "dim-text small",
        "Only the link is sent to the others in the room. The video itself never goes through homecast."),
    );

    this.active.append(codeWrap, linkRow, this.statusEl, this.getFile, this.peerList, this.sendBox, share, controls);

    const note = el("p", "dim-text", connectionNote);
    this.root.append(header, this.idle, this.active, note);
  }

  private saveShare(): void {
    const raw = this.shareInput.value.trim();
    if (raw && !safeHttpUrl(raw)) {
      this.shareInput.classList.add("invalid");
      return;
    }
    this.shareInput.classList.remove("invalid");
    this.cb.onShareUrl(raw);
  }

  /** Reflect the file you have open and its saved link. */
  setMyFile(name: string | undefined, shareUrl: string | undefined): void {
    const hasFile = !!name;
    this.shareInput.disabled = !hasFile;
    this.shareSave.disabled = !hasFile;
    this.shareLabel.textContent = hasFile ? `Download link for ${name}` : "Open a video to share a download link for it";
    if (document.activeElement !== this.shareInput) this.shareInput.value = shareUrl ?? "";
    this.shareSave.textContent = shareUrl ? "Update link" : "Share link";
    this.hasOwnFile = hasFile;
  }

  private hasOwnFile = false;

  setPingvin(enabled: boolean): void {
    this.uploadBtn.hidden = !enabled;
  }

  setUpload(message: string, state: "busy" | "done" | "warn", cancel?: () => void, progress?: number): void {
    this.uploadStatus.textContent = message;
    this.uploadStatus.className = `dim-text small${state === "warn" ? " warn-text" : ""}`;
    this.cancelUpload = cancel;
    this.uploadCancel.hidden = state !== "busy" || !cancel;
    this.uploadBtn.disabled = state === "busy";
    this.uploadBtn.textContent = state === "done" ? "Uploaded ✓" : "Upload to Pingvin";
    this.uploadBar.hidden = progress === undefined;
    if (progress !== undefined) this.uploadFill.style.width = `${Math.min(1, Math.max(0, progress)) * 100}%`;
  }

  /** Host controls for sending the playing video directly to people who join. */
  setOffer(hasFile: boolean, on: boolean, sendingCount: number, uploaded = false): void {
    this.sendBox.hidden = !hasFile;
    this.offerToggle.checked = on;
    this.offerStatus.textContent = uploaded
      ? "Offered to everyone who joins. They download it from Pingvin, so you can close this tab."
      : !on
        ? "Sent straight from this browser to theirs — keep this tab open until they have it."
        : sendingCount
          ? `Sending to ${sendingCount} ${sendingCount === 1 ? "person" : "people"} — keep this tab open.`
          : "Offered to everyone who joins. Keep this tab open while they download.";
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

    // Arrived without the file? Put the way to get it front and centre.
    const withLink = peers.find((p) => p.shareUrl);
    this.getFile.replaceChildren();
    this.getFile.hidden = this.hasOwnFile || !withLink;
    if (withLink?.shareUrl && !this.hasOwnFile) {
      this.getFile.append(
        el("div", undefined, withLink.file ? `They're watching ${withLink.file}` : "They shared the video"),
        downloadLink(withLink.shareUrl, "Download it"),
        el("div", "dim-text small", "Then open it here — playback syncs once it's loaded."),
      );
    }

    for (const peer of peers) {
      const row = el("div", "peer-row");
      row.append(el("span", "peer-dot " + peer.connectionState));
      row.append(el("span", "peer-name", peer.file ?? peer.name ?? peer.id));
      if (peer.shareUrl) row.append(downloadLink(peer.shareUrl, "download"));
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

/**
 * A link a *peer* sent. It is revalidated here even though the room already
 * did, opens in a new tab, and passes no referrer or window handle back.
 */
function downloadLink(raw: string, label: string): HTMLElement {
  const href = safeHttpUrl(raw);
  if (!href) return document.createElement("span");
  const a = document.createElement("a");
  a.className = "download-link";
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  let host = "";
  try {
    host = new URL(href).host;
  } catch {
    /* validated above */
  }
  a.textContent = host ? `${label} (${host})` : label;
  a.title = href;
  return a;
}
