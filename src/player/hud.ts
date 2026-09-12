/**
 * The chrome around the canvas: transport, scrubber with a chapter bar, and the
 * view readout carrying the 1:1 native badge (PLAN §4.3).
 */
import type { Chapter } from "../shared/chapters.ts";
import { formatTime } from "./format.ts";

export interface HudCallbacks {
  onTogglePlay: () => void;
  onSeekTo: (fraction: number) => void;
  onOpenFile: () => void;
  onToggleFullscreen: () => void;
  onChapterJump: (index: number) => void;
  onShowLibrary: () => void;
  onShowChapters: () => void;
  onShowRoom: () => void;
}

export interface HudState {
  title: string;
  currentTime: number;
  duration: number;
  playing: boolean;
  fov: number;
  yaw: number;
  pitch: number;
  magnification?: number;
  native: boolean;
  /** rendered horizontal pixels across the visible arc — the §5.1 number */
  visiblePixels?: number;
  resolution?: string;
  droppedFrames?: number;
  chapters: Chapter[];
}

/**
 * Two labels per button: the full wording on a roomy screen, a short one on a
 * phone. CSS picks; nothing recomputes on resize.
 */
const label = (full: string, short: string): DocumentFragment => {
  const frag = document.createDocumentFragment();
  const a = document.createElement("span");
  a.className = "label-full";
  a.textContent = full;
  const b = document.createElement("span");
  b.className = "label-short";
  b.textContent = short;
  frag.append(a, b);
  return frag;
};

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

export class Hud {
  readonly root: HTMLElement;
  private readonly cb: HudCallbacks;

  private readonly titleEl: HTMLElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly timeEl: HTMLElement;
  private readonly track: HTMLElement;
  private readonly played: HTMLElement;
  private readonly chapterBar: HTMLElement;
  private readonly chapterLabel: HTMLElement;
  private readonly roomBtn: HTMLButtonElement;
  private readonly viewEl: HTMLElement;
  private readonly nativeBadge: HTMLElement;
  private readonly statsEl: HTMLElement;
  private scrubbing = false;
  private lastChapterSignature = "";

  constructor(cb: HudCallbacks) {
    this.cb = cb;
    this.root = el("div", "hud");

    // --- top bar ------------------------------------------------------------
    const top = el("div", "hud-top");
    this.titleEl = el("div", "hud-title", "No file open");
    this.chapterLabel = el("div", "hud-chapter");
    const libraryBtn = el("button", "btn");
    libraryBtn.append(label("Library", "Library"));
    libraryBtn.addEventListener("click", () => this.cb.onShowLibrary());
    const chaptersBtn = el("button", "btn");
    chaptersBtn.append(label("Chapters", "Marks"));
    chaptersBtn.addEventListener("click", () => this.cb.onShowChapters());
    this.roomBtn = el("button", "btn");
    this.roomBtn.append(label("Watch together", "Room"));
    this.roomBtn.addEventListener("click", () => this.cb.onShowRoom());
    const openBtn = el("button", "btn");
    openBtn.append(label("Open file", "Open"));
    openBtn.addEventListener("click", () => this.cb.onOpenFile());
    const fsBtn = el("button", "btn");
    fsBtn.append(label("Fullscreen", "⛶"));
    fsBtn.addEventListener("click", () => this.cb.onToggleFullscreen());
    const topRight = el("div", "hud-top-right");
    topRight.append(this.roomBtn, libraryBtn, chaptersBtn, openBtn, fsBtn);
    top.append(this.titleEl, this.chapterLabel, topRight);

    // --- view readout -------------------------------------------------------
    const right = el("div", "hud-view");
    this.viewEl = el("div", "readout");
    this.nativeBadge = el("div", "badge", "1:1 NATIVE");
    this.nativeBadge.hidden = true;
    this.statsEl = el("div", "readout dim");
    right.append(this.viewEl, this.nativeBadge, this.statsEl);

    // --- transport ----------------------------------------------------------
    const bottom = el("div", "hud-bottom");
    this.playBtn = el("button", "btn play", "▶");
    this.playBtn.addEventListener("click", () => this.cb.onTogglePlay());

    this.track = el("div", "track");
    this.played = el("div", "played");
    this.chapterBar = el("div", "chapter-bar");
    this.track.append(this.played, this.chapterBar);
    this.bindScrub();

    this.timeEl = el("div", "time", "0:00 / 0:00");
    bottom.append(this.playBtn, this.track, this.timeEl);

    const fill = el("div", "hud-fill");
    this.root.append(top, right, fill, bottom);
  }

  private bindScrub(): void {
    const fractionAt = (clientX: number) => {
      const rect = this.track.getBoundingClientRect();
      return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    };
    this.track.addEventListener("pointerdown", (e) => {
      this.scrubbing = true;
      this.track.setPointerCapture(e.pointerId);
      this.cb.onSeekTo(fractionAt(e.clientX));
    });
    this.track.addEventListener("pointermove", (e) => {
      if (this.scrubbing) this.cb.onSeekTo(fractionAt(e.clientX));
    });
    const end = (e: PointerEvent) => {
      this.scrubbing = false;
      this.track.releasePointerCapture?.(e.pointerId);
    };
    this.track.addEventListener("pointerup", end);
    this.track.addEventListener("pointercancel", end);
  }

  update(s: HudState): void {
    this.titleEl.textContent = s.title;
    this.playBtn.textContent = s.playing ? "❚❚" : "▶";
    this.timeEl.textContent = `${formatTime(s.currentTime)} / ${formatTime(s.duration)}`;
    this.played.style.width = s.duration ? `${(s.currentTime / s.duration) * 100}%` : "0%";

    const mag = s.magnification;
    this.viewEl.textContent =
      `yaw ${s.yaw.toFixed(0)}°  pitch ${s.pitch.toFixed(0)}°  fov ${s.fov.toFixed(0)}°` +
      (mag ? `  ·  ${mag.toFixed(2)}×` : "");
    this.nativeBadge.hidden = !s.native;

    const bits: string[] = [];
    if (s.resolution) bits.push(s.resolution);
    // §5.1: the honest number is how many pixels the visible arc actually gets.
    if (s.visiblePixels) bits.push(`${Math.round(s.visiblePixels)} px across view`);
    if (s.droppedFrames) bits.push(`${s.droppedFrames} dropped`);
    this.statsEl.textContent = bits.join("  ·  ");

    this.renderChapters(s);
  }

  private renderChapters(s: HudState): void {
    const signature = `${s.duration}|${s.chapters.map((c) => `${c.start}:${c.title}`).join("|")}`;
    if (signature !== this.lastChapterSignature) {
      this.lastChapterSignature = signature;
      this.chapterBar.replaceChildren();
      if (s.duration) {
        s.chapters.forEach((c, i) => {
          const tick = el("button", "chapter-tick");
          tick.style.left = `${(c.start / s.duration) * 100}%`;
          tick.title = `${formatTime(c.start)} — ${c.title}`;
          tick.addEventListener("pointerdown", (e) => e.stopPropagation());
          tick.addEventListener("click", (e) => {
            e.stopPropagation();
            this.cb.onChapterJump(i);
          });
          this.chapterBar.append(tick);
        });
      }
    }

    const current = s.chapters.reduce<{ i: number; c?: Chapter }>(
      (acc, c, i) => (c.start <= s.currentTime ? { i, c } : acc),
      { i: -1 },
    );
    this.chapterLabel.textContent = current.c ? `${current.i + 1}. ${current.c.title}` : "";
  }

  /** Reflect room state on the toolbar button, so it is visible while watching. */
  setRoom(code: string, status?: string, peers = 0): void {
    const full = this.roomBtn.querySelector(".label-full");
    const short = this.roomBtn.querySelector(".label-short");
    if (!code) {
      if (full) full.textContent = "Watch together";
      if (short) short.textContent = "Room";
      this.roomBtn.classList.remove("live");
      return;
    }
    if (full) full.textContent = peers ? `${code} · ${peers} connected` : `${code} · waiting`;
    if (short) short.textContent = peers ? `${code}·${peers}` : code;
    this.roomBtn.classList.toggle("live", peers > 0);
    if (status) this.roomBtn.title = status;
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle("hidden", !visible);
  }
}
