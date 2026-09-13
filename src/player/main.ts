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
    resumeAt: existing?.resumeAt,
    chapters: chapters.length ? chapters : (existing?.chapters ?? []),
    title: existing?.title,
    artist: existing?.artist,
    shareUrl: existing?.shareUrl,
    addedAt: existing?.addedAt ?? now,
    lastOpenedAt: now,
  };
  entry = record;
  chapters = record.chapters;
  await putEntry(record);
  // Peers only heard our identity at connect time; now there is a file to describe.
  roomPanel.setMyFile(opened?.name, record.shareUrl);
  sync.announce();

  // Resume from whatever the store actually holds. Deciding it here rather than
  // in load() means it works the same however the file was opened.
  const resumeAt = existing?.resumeAt ?? 0;
  if (resumePending && resumeAt > 10 && video.currentTime < 1) {
    resumePending = false;
    video.currentTime = resumeAt;
    toast("Resumed where you left off — press Home to start over", { ms: 5000 });
  }
  resumePending = false;

  if (!record.thumbnail) {
    const thumb = await captureThumbnail(video);
    if (thumb) await patchEntry(id, { thumbnail: thumb.blob });
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
  onMessage: (from, message) => sync.handle(from, message),
  onPeerReady: (id) => {
    sync.greet(id);
    toast("Someone joined the room");
  },
});

const sync = new Sync(room, {
  video: () => video,
  view: () => viewer.state,
  applyView: (v: ViewDirection) => {
    viewer.look(v.yaw, v.pitch);
    viewer.setFov(v.fov, true);
  },
  onGaze: (gazes: PeerGaze[]) => presence.update(gazes),
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
  onShareUrl: (raw) => void setShareUrl(raw),
});

/** Save the download link for the open file and tell everyone in the room. */
async function setShareUrl(raw: string): Promise<void> {
  if (!entry) return void toast("Open a video first", { warn: true });
  const url = raw ? safeHttpUrl(raw) : undefined;
  if (raw && !url) return void toast("That doesn't look like a web link", { warn: true });
  entry = { ...entry, shareUrl: url };
  await patchEntry(entry.id, { shareUrl: url });
  roomPanel.setMyFile(opened?.name, url);
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
  if (!opened) toast("Open your copy of the video — the file is never sent", { ms: 6000 });
}

function leaveRoom(): void {
  room.leave();
  sync.stop();
  presence.clear();
  roomPanel.setIdle();
  hud.setRoom("", "closed", 0);
  history.replaceState(null, "", "/");
  toast("Left the room");
}

function showRoom(): void {
  roomPanel.setMyFile(opened?.name, entry?.shareUrl);
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
    if (library.isEmpty) showStart();
    else library.setVisible(true);
  });
}

if (roomFromUrl) {
  startRoom(roomFromUrl);
  showRoom();
}

if (import.meta.env.DEV) {
  Object.assign(window as unknown as Record<string, unknown>, {
    __homecast: {
      viewer, video, capability, library, chapterEditor, room, sync, presence, roomPanel,
      startRoom, leaveRoom,
      get chapters() { return chapters; },
      get entry() { return entry; },
    },
  });
}
