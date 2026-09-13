/**
 * homecast player — M2 renderer, M3 library, M4 chapter authoring (PLAN §6).
 *
 * The video element is never added to the DOM; three.js binds it straight to a
 * texture. §3.1 measured that upload at 0.8 ms for a 128 MB 8192×4096 frame,
 * because ANGLE zero-copy binds the hardware-decoded frame via IOSurface.
 */
import "./style.css";
import { Viewer, DEFAULT_FOV, PLANET_FOV } from "./viewer.ts";
import { Controls } from "./controls.ts";
import { Hud } from "./hud.ts";
import { probeCapability } from "./capability.ts";
import { startPanel, helpPanel, toast } from "./panels.ts";
import { pickVideo, fromDataTransfer, revoke, type OpenedVideo } from "./source.ts";
import { WakeLock } from "./wakelock.ts";
import { Library } from "./library.ts";
import { ChapterEditor } from "./chapter-editor.ts";
import { captureThumbnail } from "./thumbnail.ts";
import {
  entryId, getEntry, patchEntry, putEntry, requestAccess, queryAccess,
  type LibraryEntry,
} from "./db.ts";
import { chapterIndexAt, normaliseChapters, type Chapter, type ViewDirection } from "../shared/chapters.ts";
import { formatBytes } from "./format.ts";
import { Room, type PeerInfo, type RoomStatus } from "./room.ts";
import { Sync, type PeerGaze } from "./sync.ts";
import { Presence } from "./presence.ts";
import { RoomPanel } from "./room-panel.ts";
import { FileSender, FileReceiver, type ReceiveState } from "./transfer/p2p.ts";
import { TransferCard, formatEta } from "./transfer/transfer-card.ts";
import {
  canSaveToDisk, checkBrowserStorage, openBrowserStorageSink, openDiskSink,
  findInBrowserStorage, partialInBrowserStorage, deleteFromBrowserStorage, type Sink,
} from "./transfer/sinks.ts";
import { relayPath, type FileMessage, type FileOffer } from "../shared/protocol.ts";
import {
  pingvinStatus, uploadToPingvin, downloadFromRelay, storedUploadKey, storeUploadKey,
  UploadError, type PingvinStatus,
} from "./transfer/pingvin.ts";
import { ROOM_PATH, safeHttpUrl } from "../shared/protocol.ts";

const canvasElement = document.querySelector<HTMLCanvasElement>("#view");
if (!canvasElement) throw new Error("#view canvas missing");
// Re-bound as non-nullable: the narrowing above does not reach into the
// functions declared below.
const canvas: HTMLCanvasElement = canvasElement;

const capability = probeCapability();
const viewer = new Viewer(canvas);
const wakeLock = new WakeLock();

const video = document.createElement("video");
video.preload = "auto";
video.playsInline = true;
// Drift correction nudges playbackRate; keep pitch fixed, since this is music.
video.preservesPitch = true;

let opened: OpenedVideo | undefined;
let entry: LibraryEntry | undefined;
let chapters: Chapter[] = [];
let currentPanel: HTMLElement | undefined;
let hudTimer: number | undefined;
/** Cleared once a file's resume position has been applied, so a later
 *  `loadedmetadata` (e.g. after a seek-driven reload) does not re-seek. */
let resumePending = false;

// --- panels -----------------------------------------------------------------

function showPanel(node: HTMLElement): void {
  currentPanel?.remove();
  currentPanel = node;
  document.body.append(node);
  // A full-height sheet hides the player chrome behind it rather than letting
  // the toolbar show through its edge.
  document.body.classList.toggle("has-takeover", node.classList.contains("takeover"));
}

function closePanel(): void {
  currentPanel?.remove();
  currentPanel = undefined;
  document.body.classList.remove("has-takeover");
}

function showHelp(): void {
  showPanel(helpPanel(closePanel, capability.touch));
}

function showStart(): void {
  showPanel(startPanel(capability, { onOpenFile: () => void openFile(), onShowHelp: showHelp }));
}

// --- library (M3) -----------------------------------------------------------

const library = new Library({
  onOpenEntry: (e) => void openFromLibrary(e),
  onPickFile: () => void openFile(),
  onClose: () => library.setVisible(false),
});
document.body.append(library.root);

async function showLibrary(): Promise<void> {
  closePanel();
  library.setCurrent(opened ? entry?.id : undefined, !video.paused);
  await library.refresh();
  library.setVisible(true);
}

/**
 * Reopening a remembered file. The handle survives in IndexedDB, but its
 * permission does not necessarily — `requestPermission` needs a user gesture,
 * which is why this only ever runs from a click (M3).
 */
/** True when `id` is the file already loaded — reopening it should not restart it. */
function isCurrent(id: string | undefined): boolean {
  return !!id && !!opened && entry?.id === id;
}

async function openFromLibrary(e: LibraryEntry): Promise<void> {
  // Picking the video that is already playing just returns to it: reloading
  // would stop the music, re-seek to the saved position and reset the view.
  if (isCurrent(e.id)) {
    library.setVisible(false);
    return;
  }
  if (!e.handle) {
    toast("That file was dropped rather than picked, so it cannot be reopened automatically", { warn: true, ms: 6000 });
    return void openFile();
  }
  const access = await queryAccess(e.handle);
  if (access !== "granted" && !(await requestAccess(e.handle))) {
    toast("Access to that file was not granted", { warn: true });
    return;
  }
  try {
    const file = await e.handle.getFile();
    library.setVisible(false);
    await load({ name: file.name, size: file.size, url: URL.createObjectURL(file), file, handle: e.handle }, e);
  } catch (err) {
    toast(`Could not reopen that file: ${(err as Error).message}`, { warn: true, ms: 7000 });
  }
}

// --- chapter authoring (M4) -------------------------------------------------

const chapterEditor = new ChapterEditor({
  onChange: (next) => {
    chapters = next;
    if (entry) void patchEntry(entry.id, { chapters: next });
  },
  onJump: (index) => jumpToChapter(index),
  onClose: closePanel,
  readState: () => ({ time: video.currentTime, view: viewer.state }),
  onShareUrl: (url) => void setShareUrl(url),
  meta: () => ({
    videoName: opened?.name ?? "video.mp4",
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    title: entry?.title,
    artist: entry?.artist,
    shareUrl: entry?.shareUrl,
  }),
});

function showChapters(): void {
  chapterEditor.setChapters(chapters);
  showPanel(chapterEditor.root);
}

function markChapter(): void {
  if (!opened) return void toast("Open a video first", { warn: true });
  chapterEditor.setChapters(chapters);
  chapterEditor.mark();
}

// --- playback ---------------------------------------------------------------

async function openFile(): Promise<void> {
  const picked = await pickVideo().catch((e: unknown) => {
    toast(`Could not open that file: ${(e as Error).message}`, { warn: true });
    return undefined;
  });
  if (!picked) return;
  library.setVisible(false);
  const existing = await getEntry(entryId(picked.file));
  await load(picked, existing);
}

async function load(next: OpenedVideo, known?: LibraryEntry): Promise<void> {
  // The same file re-picked or dropped again: keep playing, drop the new handle.
  if (isCurrent(known?.id)) {
    revoke(next);
    closePanel();
    library.setVisible(false);
    return;
  }
  closePanel();
  persistResume();
  revoke(opened);
  opened = next;
  entry = known;
  chapters = known ? normaliseChapters(known.chapters) : [];
  resumePending = true;

  video.src = next.url;
  video.load();
  viewer.attachVideo(video);
  viewer.look(0, 0);
  viewer.setFov(DEFAULT_FOV);

  toast(`${next.name} · ${formatBytes(next.size)}`);
}

const THUMBNAIL_VERSION = 2;

/** Record the entry once we know the file's real dimensions and duration. */
async function remember(): Promise<void> {
  if (!opened) return;
  const now = Date.now();
  const file = opened.file;
  const id = entryId({ name: opened.name, size: opened.size, lastModified: file.lastModified });
  const existing = await getEntry(id);

  const record: LibraryEntry = {
    id,
    name: opened.name,
    size: opened.size,
    lastModified: file.lastModified,
    ...(opened.handle ? { handle: opened.handle } : {}),
    duration: Number.isFinite(video.duration) ? video.duration : existing?.duration,
    width: video.videoWidth || existing?.width,
    height: video.videoHeight || existing?.height,
    thumbnail: existing?.thumbnail,
    thumbnailVersion: existing?.thumbnailVersion,
    resumeAt: existing?.resumeAt,
    chapters: chapters.length ? chapters : (existing?.chapters ?? []),
    title: existing?.title,
    artist: existing?.artist,
    shareUrl: existing?.shareUrl,
    relayPath: existing?.relayPath,
    addedAt: existing?.addedAt ?? now,
    lastOpenedAt: now,
  };
  entry = record;
  chapters = record.chapters;
  await putEntry(record);
  // Peers only heard our identity at connect time; now there is a file to describe.
  sync.announce();
  uploadedPath = relayPath(record.relayPath);
  // Sharing was for the previous video; a new one starts unshared.
  if (sharedEntryId !== record.id) shareMode = "none";
  sharedEntryId = record.id;
  offerCurrent();
  refreshShare();

  // Resume from whatever the store actually holds. Deciding it here rather than
  // in load() means it works the same however the file was opened.
  const resumeAt = existing?.resumeAt ?? 0;
  if (resumePending && resumeAt > 10 && video.currentTime < 1) {
    resumePending = false;
    video.currentTime = resumeAt;
    toast("Resumed where you left off — press Home to start over", { ms: 5000 });
  }
  resumePending = false;

  if (!record.thumbnail || record.thumbnailVersion !== THUMBNAIL_VERSION) {
    const thumb = await captureThumbnail(video, (w) => viewer.snapshot(w));
    if (thumb) await patchEntry(id, { thumbnail: thumb.blob, thumbnailVersion: THUMBNAIL_VERSION });
  }
}

function persistResume(): void {
  if (!entry || !Number.isFinite(video.duration) || video.currentTime < 5) return;
  // Finished means finished — do not offer to resume the last few seconds.
  // The window scales with duration: a flat 15 s would mark a 40 s clip as
  // watched from 25 s in, while being about right for a 2 h concert.
  const tail = Math.min(15, video.duration * 0.05);
  const done = video.duration - video.currentTime < tail;
  void patchEntry(entry.id, { resumeAt: done ? 0 : video.currentTime, lastOpenedAt: Date.now() });
}

function togglePlay(): void {
  if (!opened) return void openFile();
  if (video.paused) void video.play().catch((e: Error) => toast(`Playback failed: ${e.message}`, { warn: true }));
  else video.pause();
}

function seek(delta: number): void {
  if (!Number.isFinite(video.duration)) return;
  video.currentTime = Math.min(Math.max(0, video.currentTime + delta), video.duration);
  sync.sendControl("seek");
}

function seekTo(fraction: number): void {
  if (!Number.isFinite(video.duration)) return;
  video.currentTime = video.duration * Math.min(Math.max(0, fraction), 1);
  sync.sendControl("seek");
}

function jumpToChapter(index: number): void {
  const chapter = chapters[index];
  if (!chapter) return;
  video.currentTime = chapter.start;
  // §4.3 / M4: a chapter restores the view direction it was authored at.
  if (chapter.view) {
    viewer.look(chapter.view.yaw, chapter.view.pitch);
    viewer.setFov(chapter.view.fov, true);
  }
  // Take everyone to the same chapter, view included.
  sync.sendControl("seek", chapter.view);
}

function stepChapter(direction: -1 | 1): void {
  if (!chapters.length) return void toast("No chapters yet — press M to drop one", { warn: true });
  const here = chapterIndexAt(chapters, video.currentTime - (direction < 0 ? 1.5 : 0));
  jumpToChapter(Math.min(Math.max(0, here + direction), chapters.length - 1));
}

async function toggleFullscreen(): Promise<void> {
  if (document.fullscreenElement) await document.exitFullscreen();
  else await document.documentElement.requestFullscreen().catch(() => toast("Fullscreen refused", { warn: true }));
}

// --- watch-together (M5) ----------------------------------------------------

const presence = new Presence(document.body);
viewer.scene.add(presence.group);

const room = new Room({
  onStatus: (status: RoomStatus, detail?: string) => {
    roomPanel.setStatus(status, detail);
    if (status === "failed" && detail) toast(detail, { warn: true, ms: 7000 });
    hud.setRoom(room.roomCode, status, room.peerCount);
  },
  onPeers: (peers: PeerInfo[]) => {
    roomPanel.setPeers(peers);
    hud.setRoom(room.roomCode, undefined, peers.length);
  },
  onMessage: (from, message) => {
    if (message.type.startsWith("file-")) handleFileMessage(from, message as FileMessage);
    else sync.handle(from, message);
  },
  onPeerReady: (id) => {
    sync.greet(id);
    sender.offerTo(id); // no-op unless the video is being shared
    toast("Someone joined the room");
  },
  onFileData: (from, data) => receiver.data(from, data),
  onPeerLeft: (id) => {
    sync.dropPeer(id);
    sender.peerLeft(id);
    if (receiver.current?.from === id) void receiver.interrupt("the host left the room");
    if (pendingOffer?.from === id) pendingOffer = undefined;
  },
});

// --- host → friend video transfer --------------------------------------------

const sender = new FileSender(room);
const receiver = new FileReceiver(room);
const transferCard = new TransferCard();
document.body.append(transferCard.root);

/** Host: how the open video is being shared, if at all. */
let shareMode: "none" | "direct" | "pingvin" = "none";
let sharedEntryId: string | undefined;
/** Friend: clicked "Download & watch together", so start as soon as an offer is here. */
let wantVideo = false;
/** Friend: the most recent offer, kept so an interrupted transfer can resume. */
let pendingOffer: { from: string; offer: FileOffer } | undefined;
/** Friend: jump onto the host's playhead once the received file has loaded. */
let catchUpPending = false;

/** How the bytes travel to/from the peer in a transfer, refreshed every few seconds. */
let routeLabel = "";
/** The route is not the local network, so Safari's local-address unlock may help. */
let routeNotLocal = false;
let localUnlockTried = false;
setInterval(() => {
  const peer = receiver.current && receiver.busy ? receiver.current.from : sender.sendingTo[0];
  if (!peer || peer === "relay") return void (routeLabel = "");
  void room.route(peer).then((r) => {
    routeNotLocal = !!r && r.kind !== "local";
    if (!r) return void (routeLabel = "");
    const where = { local: "same network", internet: "over the internet", relay: "via a relay" }[r.kind];
    routeLabel = [where, r.tcp ? "TCP" : "", r.rtt !== undefined ? `${Math.round(r.rtt)} ms` : ""].filter(Boolean).join(" ");
  });
}, 2000);

/** Host: bytes/second per friend being sent to, over the last few seconds. */
const sendSpeed = new Map<string, Array<{ t: number; b: number }>>();
sender.onProgress = (p) => {
  const now = performance.now();
  const samples = sendSpeed.get(p.peer) ?? [];
  samples.push({ t: now, b: p.sent });
  while (samples.length > 2 && now - (samples[0]?.t ?? now) > 5000) samples.shift();
  sendSpeed.set(p.peer, samples);
  refreshShare(p.sent / p.size, samples);
};
sender.onFinished = (peer) => {
  sendSpeed.delete(peer);
  refreshShare();
};

function shareLink(): string {
  const q = new URLSearchParams({ get: "1" });
  if (opened) {
    q.set("n", opened.name);
    q.set("s", String(opened.size));
  }
  if (shareMode === "pingvin" && uploadedPath) q.set("src", uploadedPath);
  return `${location.origin}${ROOM_PATH}${room.roomCode}?${q}`;
}

/** (Re)announce the open file to the room with the current share mode. */
function offerCurrent(): void {
  const file = shareMode !== "none" && opened?.file.size ? opened.file : undefined;
  const duration = Number.isFinite(video.duration) ? video.duration : undefined;
  sender.offer(file, duration, shareMode === "pingvin" ? uploadedPath : undefined);
}

function refreshShare(progress?: number, samples?: Array<{ t: number; b: number }>): void {
  roomPanel.setHasFile(!!opened?.file.size);
  if (uploading) return; // the upload reports its own progress
  if (shareMode === "none") return roomPanel.setShare({ phase: "idle" });
  const link = shareLink();
  if (shareMode === "pingvin") {
    return roomPanel.setShare({ phase: "ready", label: "On Pingvin — works even when you're offline", link });
  }
  const sending = sender.sendingTo.length;
  if (!sending) return roomPanel.setShare({ phase: "ready", label: "Keep this tab open while they download", link });
  const first = samples?.[0];
  const last = samples?.[samples.length - 1];
  const dt = first && last ? (last.t - first.t) / 1000 : 0;
  const speed = first && last && dt > 0.5 ? (last.b - first.b) / dt : 0;
  const percent = progress !== undefined ? `${Math.floor(progress * 100)}%` : "";
  roomPanel.setShare({
    phase: "ready",
    label: [`Sending${sending > 1 ? ` to ${sending}` : ""}`, percent, speed ? `${formatBytes(speed)}/s` : "", routeLabel]
      .filter(Boolean)
      .join(" · "),
    progress: progress ?? 0,
    link,
  });
}

let pingvin: PingvinStatus = { enabled: false };
void pingvinStatus().then((status) => {
  pingvin = status;
  roomPanel.setPingvin(status.enabled);
});

/** Relay path for the open video once uploaded, so offers and links can carry it. */
let uploadedPath: string | undefined;
let uploading: AbortController | undefined;

async function shareViaPingvin(): Promise<void> {
  const file = opened?.file;
  if (!file?.size) return void toast("Open a video first", { warn: true });
  if (uploading) return;
  if (uploadedPath) {
    // Already on Pingvin from an earlier upload of this exact file.
    shareMode = "pingvin";
    offerCurrent();
    return refreshShare();
  }
  if (pingvin.maxSize && file.size > pingvin.maxSize) {
    return roomPanel.setShare({
      phase: "error",
      label: `Too big for Pingvin (${formatBytes(file.size)}, limit ${formatBytes(pingvin.maxSize)})`,
    });
  }
  let key = storedUploadKey();
  if (!key) {
    key = window.prompt("Upload key (HOMECAST_UPLOAD_KEY on the server)")?.trim() || undefined;
    if (!key) return;
  }

  const abort = new AbortController();
  uploading = abort;
  roomPanel.setShare({ phase: "working", label: "Uploading…", progress: 0, onCancel: () => abort.abort() });
  try {
    const result = await uploadToPingvin(
      file,
      key,
      (p) => {
        const eta = p.bytesPerSecond > 0 ? formatEta((p.size - p.sent) / p.bytesPerSecond) : "";
        roomPanel.setShare({
          phase: "working",
          label: [`Uploading ${Math.floor((p.sent / p.size) * 100)}%`, p.bytesPerSecond ? `${formatBytes(p.bytesPerSecond)}/s` : "", eta]
            .filter(Boolean)
            .join(" · "),
          progress: p.sent / p.size,
          onCancel: () => abort.abort(),
        });
      },
      abort.signal,
    );
    storeUploadKey(key);
    uploadedPath = result.downloadPath;
    if (entry) {
      const absolute = `${location.origin}${uploadedPath}`;
      entry = { ...entry, shareUrl: absolute, relayPath: uploadedPath };
      void patchEntry(entry.id, { shareUrl: absolute, relayPath: uploadedPath });
    }
    uploading = undefined;
    shareMode = "pingvin";
    offerCurrent();
    sync.announce();
    refreshShare();
  } catch (err) {
    uploading = undefined;
    const status = err instanceof UploadError ? err.status : 0;
    if (status === 401) storeUploadKey(undefined);
    const message = (err as Error).message;
    roomPanel.setShare(
      message === "cancelled"
        ? { phase: "idle" }
        : { phase: "error", label: status === 401 ? "Wrong upload key" : `Upload failed: ${message}` },
    );
  } finally {
    if (uploading === abort) uploading = undefined;
  }
}

const isOpen = (offer: FileOffer): boolean =>
  !!opened && opened.name === offer.name && opened.size === offer.size;

function handleFileMessage(from: string, message: FileMessage): void {
  if (message.type === "file-request" || (message.type === "file-cancel" && sender.sendingTo.includes(from))) {
    sender.handle(from, message);
    return;
  }
  if (message.type === "file-offer") {
    void onOffer(from, message);
    return;
  }
  receiver.handle(from, message);
}

async function onOffer(from: string, offer: FileOffer): Promise<void> {
  // A relay path from a peer is only kept if it has the exact relay shape.
  const url = relayPath(offer.url);
  pendingOffer = { from, offer: { ...offer, url } };
  if (isOpen(offer) || receiver.busy || relayDownload) return;

  // Already downloaded earlier? Open that copy instead of fetching it again.
  const stored = await findInBrowserStorage(offer.name, offer.size);
  if (stored) {
    transferCard.show({ title: "You already have this video", detail: "Opening it…", tone: "done" });
    openReceived(stored, undefined);
    return;
  }

  if (wantVideo) void startReceive(false);
  else showInvite(offer.name, offer.size);
}

/** The friendly first thing a friend sees: what was shared, and one button. */
function showInvite(name?: string, size?: number): void {
  transferCard.show({
    title: "A video was shared with you",
    detail: name ? `${name}${size ? ` · ${formatBytes(size)}` : ""}` : "Download it, then watch it together in sync",
    tone: "invite",
    actions: [{ label: "Download & watch together", primary: true, run: acceptInvite }],
  });
}

function acceptInvite(): void {
  wantVideo = true;
  if (pendingOffer) return void startReceive(true);
  // Came in through the link before the host's browser has connected.
  transferCard.show({
    title: "Connecting to the host…",
    detail: "The download starts by itself once they're here — their tab has to be open",
    tone: "invite",
    actions: [{ label: "Cancel", run: () => {
      wantVideo = false;
      showInvite(invite?.name, invite?.size);
    } }],
  });
}

/**
 * Pick where the bytes go and start. Browser storage needs no dialog, so it
 * works for the automatic path; a real file needs a click (Chrome/Edge only).
 */
async function startReceive(fromClick: boolean, prefer?: "disk"): Promise<void> {
  const target = pendingOffer;
  if (!target) return;
  const { from, offer } = target;

  let sink: Sink | undefined;
  try {
    if (prefer === "disk" && canSaveToDisk()) {
      sink = await openDiskSink(offer.name);
    } else {
      let partial = await partialInBrowserStorage(offer.name);
      if (partial > offer.size) {
        await deleteFromBrowserStorage(offer.name);
        partial = 0;
      }
      const room = await checkBrowserStorage(offer.size, partial);
      if (room.ok) {
        sink = await openBrowserStorageSink(offer.name, partial > 0);
      } else if (canSaveToDisk() && fromClick) {
        sink = await openDiskSink(offer.name);
      } else if (canSaveToDisk()) {
        transferCard.show({
          title: `${offer.name} is too big for browser storage`,
          detail: `${formatBytes(offer.size)} needed, ${formatBytes(room.availableBytes)} available — save it as a file instead`,
          tone: "warn",
          actions: [{ label: "Save as file…", primary: true, run: () => void startReceive(true, "disk") }],
        });
        return;
      } else {
        transferCard.show({
          title: `Not enough space for ${offer.name}`,
          detail:
            `It is ${formatBytes(offer.size)}, but this browser can store ${formatBytes(room.availableBytes)} here. ` +
            "Free up disk space, or join from Chrome, which can save it as a normal file.",
          tone: "warn",
          actions: [{ label: "Try again", run: () => void startReceive(true) }],
        });
        return;
      }
    }
  } catch (err) {
    if ((err as DOMException).name === "AbortError") return; // closed the save dialog
    transferCard.show({ title: "Could not start the download", detail: (err as Error).message, tone: "warn" });
    return;
  }
  const url = relayPath(offer.url);
  if (url) void receiveFromRelay(url, offer, sink);
  else receiver.start(from, offer, sink);
}

/** Download in progress from the Pingvin relay, if any. */
let relayDownload: AbortController | undefined;

async function receiveFromRelay(url: string, offer: FileOffer, sink: Sink): Promise<void> {
  const abort = new AbortController();
  relayDownload = abort;
  try {
    const result = await downloadFromRelay(
      url,
      offer.size,
      sink,
      (p) => transferCard.progress(p.received, p.size, p.bytesPerSecond, () => abort.abort(), "from Pingvin"),
      abort.signal,
    );
    if (result.file.size !== offer.size) throw new Error(`saved file is ${result.file.size} bytes, expected ${offer.size}`);
    receiver.onState?.({ phase: "done", file: result.file, handle: result.handle });
  } catch (err) {
    const received = (err as { received?: number }).received;
    if (received !== undefined) {
      receiver.onState?.({ phase: "interrupted", received, size: offer.size, reason: (err as Error).message });
    } else {
      receiver.onState?.({ phase: "failed", reason: (err as Error).message });
    }
  } finally {
    if (relayDownload === abort) relayDownload = undefined;
  }
}

receiver.onState = (state: ReceiveState) => {
  switch (state.phase) {
    case "receiving":
      transferCard.progress(
        state.received,
        state.size,
        state.bytesPerSecond,
        () => receiver.cancel(),
        routeLabel,
        routeNotLocal && !localUnlockTried ? { label: "Same Wi-Fi? Speed up", run: () => void speedUpLocal() } : undefined,
      );
      return;
    case "interrupted":
      transferCard.show({
        title: "Download paused",
        detail: `${state.reason === "cancelled" ? "" : `${state.reason} · `}${formatBytes(state.received)} of ${formatBytes(state.size)} kept`,
        progress: state.size ? state.received / state.size : 0,
        tone: "warn",
        actions: pendingOffer ? [{ label: "Resume", primary: true, run: () => void startReceive(true) }] : [],
      });
      return;
    case "failed":
      transferCard.show({
        title: "Download failed",
        detail: state.reason,
        tone: "warn",
        actions: pendingOffer ? [{ label: "Try again", run: () => void startReceive(true) }] : [],
      });
      return;
    case "done":
      transferCard.show({ title: "Downloaded", detail: "Opening it and joining the others…", tone: "done" });
      openReceived(state.file, state.handle);
      return;
  }
};

/** See Room.unlockLocalNetwork: Safari needs mic access before it uses the local network. */
async function speedUpLocal(): Promise<void> {
  localUnlockTried = true;
  const ok = await room.unlockLocalNetwork();
  toast(
    ok
      ? "Looking for a direct path on your Wi-Fi… (the microphone was switched off straight away)"
      : "Needs microphone permission — Safari only allows local connections with it. Nothing is recorded.",
    { warn: !ok, ms: 6000 },
  );
  if (!ok) localUnlockTried = false;
}

function openReceived(file: File, handle: FileSystemFileHandle | undefined): void {
  wantVideo = false;
  catchUpPending = true;
  void load({ name: file.name, size: file.size, url: URL.createObjectURL(file), file, handle });
  setTimeout(() => transferCard.hide(), 4000);
}

const sync = new Sync(room, {
  onCatchUp: (t, playing) => {
    video.currentTime = t;
    if (!playing) return;
    video.play().catch(() => {
      // Autoplay with sound needs a gesture the automatic path never had.
      transferCard.show({
        title: "Ready — the others are already watching",
        tone: "done",
        actions: [{ label: "▶ Join playback", primary: true, run: () => {
          transferCard.hide();
          sync.catchUp() || void video.play();
        } }],
      });
    });
  },
  video: () => video,
  view: () => viewer.state,
  applyView: (v: ViewDirection) => {
    viewer.look(v.yaw, v.pitch);
    viewer.setFov(v.fov, true);
  },
  onGaze: (gazes: PeerGaze[]) => {
    presence.update(gazes);
    viewer.invalidate();
  },
  onNotice: (message, warn) => toast(message, { warn, ms: warn ? 8000 : 3500 }),
  identity: () => ({
    name: "viewer",
    file: opened?.name,
    duration: Number.isFinite(video.duration) ? video.duration : undefined,
    shareUrl: entry?.shareUrl,
  }),
});

const roomPanel = new RoomPanel({
  onHost: () => startRoom(randomRoomCode()),
  onJoin: (code) => startRoom(code),
  onLeave: () => leaveRoom(),
  onToggleViewLock: (locked) => {
    sync.viewLocked = locked;
    toast(locked ? "View locked to theirs" : "View unlinked — you can look around freely");
  },
  onResync: () => sync.resync(),
  onClose: closePanel,
  onShareDirect: () => {
    shareMode = "direct";
    offerCurrent();
    refreshShare();
    return shareLink();
  },
  onSharePingvin: () => void shareViaPingvin(),
});

/** Save the download link for the open file and tell everyone in the room. */
async function setShareUrl(raw: string): Promise<void> {
  if (!entry) return void toast("Open a video first", { warn: true });
  const url = raw ? safeHttpUrl(raw) : undefined;
  if (raw && !url) return void toast("That doesn't look like a web link", { warn: true });
  entry = { ...entry, shareUrl: url };
  await patchEntry(entry.id, { shareUrl: url });
  sync.announce();
  toast(url ? "Download link shared with the room" : "Download link removed");
}

/** Same alphabet as the server (no 0/O/1/I/L). */
function randomRoomCode(): string {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  return [...crypto.getRandomValues(new Uint8Array(5))]
    .map((b) => alphabet[b % alphabet.length])
    .join("");
}

function startRoom(code: string): void {
  const clean = code.toUpperCase().replace(/[\s-]/g, "");
  room.join(clean);
  sync.start();
  roomPanel.setRoom(clean);
  roomPanel.setViewLocked(sync.viewLocked);
  history.replaceState(null, "", `${ROOM_PATH}${clean}`);
  if (!opened && !invite) toast("Open the video, or ask them to share it with you", { ms: 6000 });
}

function leaveRoom(): void {
  room.leave();
  sync.stop();
  presence.clear();
  viewer.invalidate();
  roomPanel.setIdle();
  hud.setRoom("", "closed", 0);
  history.replaceState(null, "", "/");
  toast("Left the room");
}

function showRoom(): void {
  refreshShare();
  showPanel(roomPanel.root);
}

// --- HUD --------------------------------------------------------------------

const hud = new Hud({
  onTogglePlay: togglePlay,
  onSeekTo: seekTo,
  onOpenFile: () => void openFile(),
  onToggleFullscreen: () => void toggleFullscreen(),
  onChapterJump: jumpToChapter,
  onShowLibrary: () => void showLibrary(),
  onShowChapters: showChapters,
  onShowRoom: showRoom,
});
document.body.append(hud.root);

function nudgeHud(): void {
  hud.setVisible(true);
  if (hudTimer) clearTimeout(hudTimer);
  hudTimer = window.setTimeout(() => {
    if (!video.paused && !currentPanel) hud.setVisible(false);
  }, 2600);
}
window.addEventListener("pointermove", nudgeHud);
nudgeHud();

new Controls(viewer, canvas, {
  onViewChange: () => {
    nudgeHud();
    sync.noteLocalMove();
  },
  onTogglePlay: togglePlay,
  onSeek: seek,
  onSeekTo: seekTo,
  onChapterStep: stepChapter,
  onToggleFullscreen: () => void toggleFullscreen(),
  onToggleHelp: () => (currentPanel ? closePanel() : showHelp()),
  onOpenFile: () => void openFile(),
  onMarkChapter: markChapter,
  onShowLibrary: () => (library.root.classList.contains("hidden") ? void showLibrary() : library.setVisible(false)),
  onShowChapters: () => (currentPanel === chapterEditor.root ? closePanel() : showChapters()),
  onShowRoom: () => (currentPanel === roomPanel.root ? closePanel() : showRoom()),
  onTogglePlanet: togglePlanet,
});

// --- video events -----------------------------------------------------------

video.addEventListener("play", () => {
  void wakeLock.acquire();
  nudgeHud();
  sync.sendControl("play");
});
video.addEventListener("seeked", () => {
  // A seek while paused fires no other event that would record the position.
  if (video.paused) persistResume();
});
video.addEventListener("pause", () => {
  void wakeLock.release();
  persistResume();
  hud.setVisible(true);
  sync.sendControl("pause");
});
video.addEventListener("error", () => {
  const code = video.error?.code;
  toast(
    code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
      ? "This browser cannot decode that file — try the H.264 fallback (homecast fallback)."
      : `Video error (${code ?? "?"})`,
    { warn: true, ms: 8000 },
  );
});
video.addEventListener("loadedmetadata", () => {
  // Catch up before touching the library: joining in sync must not wait on
  // IndexedDB, which can be slow, blocked by another tab, or unavailable
  // (Safari private browsing).
  if (catchUpPending && room.roomCode) {
    catchUpPending = false;
    sync.announce();
    // The owner's heartbeat arrives every second; give it one if none is stored yet.
    if (!sync.catchUp()) setTimeout(() => sync.catchUp(), 1200);
  }
  void remember();

  if (video.videoWidth > capability.maxTextureSize) {
    toast(
      `This file is ${video.videoWidth} px wide but the GPU caps textures at ` +
        `${capability.maxTextureSize} px — open a smaller rendition.`,
      { warn: true, ms: 9000 },
    );
  }
  if (Math.abs(video.videoWidth / video.videoHeight - 2) > 0.01) {
    toast(`${video.videoWidth}×${video.videoHeight} is not 2:1 — equirect video must be (§5.7)`, {
      warn: true,
      ms: 7000,
    });
  }

});
wakeLock.bindVisibility(() => !video.paused);

// Persist the playhead on the way out, not only on pause.
window.addEventListener("pagehide", persistResume);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") persistResume();
});
setInterval(persistResume, 15000);

// --- drag & drop: a video, or a chapter sidecar -----------------------------

window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  if (!e.dataTransfer) return;

  const json = Array.from(e.dataTransfer.files).find((f) => /\.(json|txt)$/i.test(f.name));
  if (json) {
    void json.text().then((text) => {
      chapterEditor.setChapters(chapters);
      if (chapterEditor.ingest(text)) {
        chapters = chapterEditor.getChapters();
        toast(`${chapters.length} chapter${chapters.length === 1 ? "" : "s"} imported`);
      } else {
        toast("No chapters found — expected a sidecar or a timestamp list", { warn: true });
      }
    });
    return;
  }

  const dropped = fromDataTransfer(e.dataTransfer);
  if (dropped) {
    library.setVisible(false);
    void getEntry(entryId(dropped.file)).then((known) => load(dropped, known));
  }
});

// --- render loop ------------------------------------------------------------

window.addEventListener("resize", () => viewer.resize());

/**
 * P: glide into a tiny planet, or back out to where you were. Animated because
 * a jump from a 100° view to a 300° planet is disorienting.
 */
let planetTween = 0;
let planetReturn: { yaw: number; pitch: number; fov: number } | undefined;
function togglePlanet(): void {
  cancelAnimationFrame(planetTween);
  const from = viewer.state;
  const entering = from.fov < 200;
  if (entering) planetReturn = from;
  const to = entering
    ? { yaw: from.yaw, pitch: -89.9, fov: PLANET_FOV }
    : (planetReturn ?? { yaw: from.yaw, pitch: 0, fov: DEFAULT_FOV });
  const started = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - started) / 900);
    const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    viewer.look(from.yaw + (to.yaw - from.yaw) * e, from.pitch + (to.pitch - from.pitch) * e);
    viewer.setFov(from.fov + (to.fov - from.fov) * e, true);
    sync.noteLocalMove();
    if (t < 1) planetTween = requestAnimationFrame(step);
  };
  planetTween = requestAnimationFrame(step);
}

function frame(): void {
  viewer.resize();
  viewer.render();
  // Markers are placed through the perspective camera, which no longer matches
  // the picture once the projection bends — hide rather than mislead.
  if (viewer.isRectilinear) presence.updateArrow(viewer.camera, canvas);
  else presence.hideArrow();

  const quality = video.getVideoPlaybackQuality?.();
  hud.update({
    title: opened?.name ?? "No file open",
    currentTime: video.currentTime,
    duration: video.duration,
    playing: !video.paused,
    yaw: viewer.yaw,
    pitch: viewer.pitch,
    fov: viewer.fov,
    magnification: viewer.magnification(),
    native: viewer.isNative(),
    // §5.1: the visible arc is what actually matters, not the frame width.
    visiblePixels: video.videoWidth && viewer.isRectilinear
      ? (video.videoWidth / 360) * viewer.fov * viewer.camera.aspect
      : undefined,
    resolution: video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : undefined,
    droppedFrames: quality?.droppedVideoFrames,
    chapters,
  });

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --- start ------------------------------------------------------------------

// The bundle ran, so the reload-once guard in index.html can re-arm. Clearing
// it here rather than on `load` matters: `load` also fires when the script
// failed, which would let a persistently broken deploy reload forever.
try {
  sessionStorage.removeItem("homecast-reloaded");
} catch {
  /* storage blocked; the guard simply stays spent for this tab */
}

// A room code in the URL is the whole invitation (§4.3: no accounts).
const roomFromUrl = location.pathname.startsWith(ROOM_PATH)
  ? location.pathname.slice(ROOM_PATH.length).toUpperCase()
  : "";
const linkParams = new URLSearchParams(location.search);
/** Opened a "watch this video with me" link rather than a plain room invite. */
const invite: { name?: string; size?: number } | undefined =
  roomFromUrl && linkParams.get("get") === "1"
    ? { name: linkParams.get("n") ?? undefined, size: Number(linkParams.get("s")) || undefined }
    : undefined;

// Dev-only: `?src=/path.mp4` loads a file over HTTP without the native picker,
// so the renderer can be driven from a test harness. Never built into production.
const devSrc = import.meta.env.DEV ? new URLSearchParams(location.search).get("src") : null;
if (devSrc) {
  // lastModified must be fixed, or every reload mints a new library entry.
  const devFile = new File([], "dev", { lastModified: 0 });
  const devOpened = { name: devSrc.split("/").pop() ?? devSrc, size: 0, url: devSrc, file: devFile };
  void getEntry(entryId({ name: devOpened.name, size: 0, lastModified: 0 })).then((known) =>
    load(devOpened, known),
  );
} else {
  void library.refresh().then(() => {
    if (invite) return; // the invitation card is the page
    if (library.isEmpty) showStart();
    else library.setVisible(true);
  });
}

if (roomFromUrl) {
  startRoom(roomFromUrl);
  if (!invite) showRoom();
  const src = relayPath(linkParams.get("src"));
  if (invite?.name && invite.size) {
    if (src) {
      // Uploaded to Pingvin: the host may be offline, the link alone is enough.
      void onOffer("relay", { type: "file-offer", name: invite.name, size: invite.size, lastModified: 0, url: src });
    } else {
      showInvite(invite.name, invite.size);
    }
  } else if (invite) {
    showInvite();
  }
}

if (import.meta.env.DEV) {
  const report = (...parts: unknown[]) =>
    void fetch("/__log", { method: "POST", body: parts.map((p) => (p instanceof Error ? `${p.name}: ${p.message}` : String(p))).join(" ") }).catch(() => {});
  window.addEventListener("error", (e) => report("error", e.message, e.filename, e.lineno));
  window.addEventListener("unhandledrejection", (e) => report("rejection", e.reason));
  const origError = console.error.bind(console);
  console.error = (...args: unknown[]) => (report("console.error", ...args), origError(...args));
  (window as unknown as { __report: typeof report }).__report = report;
}

// Dev-only: `?devhost=CODE` hosts public/__send.mp4 in that room and shares it
// from this browser, so a browser that can't be scripted (iOS Safari) can be
// measured as the sender.
const devHost = import.meta.env.DEV ? new URLSearchParams(location.search).get("devhost") : null;
if (devHost) {
  void fetch("/__send.mp4").then(async (r) => {
    const file = new File([await r.blob()], "concert-360.mp4", { type: "video/mp4", lastModified: 1700000000000 });
    await load({ name: file.name, size: file.size, url: URL.createObjectURL(file), file });
    startRoom(devHost);
    while (!sharedEntryId) await new Promise((r) => setTimeout(r, 100)); // wait for remember()
    shareMode = "direct";
    offerCurrent();
    showRoom();
  });
}

if (import.meta.env.DEV) {
  Object.assign(window as unknown as Record<string, unknown>, {
    __homecast: {
      viewer, video, capability, library, chapterEditor, room, sync, presence, roomPanel,
      startRoom, leaveRoom, load, sender, receiver,
      get chapters() { return chapters; },
      get entry() { return entry; },
    },
  });
}
