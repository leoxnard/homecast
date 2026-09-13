/**
 * The library view (PLAN §4.3, M3): a grid of videos with locally-generated
 * thumbnails, duration, chapter count and resume position. Local only — there
 * is no index on any server, because there is no server in this path at all.
 */
import { listEntries, deleteEntry, queryAccess, type LibraryEntry } from "./db.ts";
import { formatTime, formatBytes } from "./format.ts";

export interface LibraryCallbacks {
  onOpenEntry: (entry: LibraryEntry) => void;
  onPickFile: () => void;
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

export class Library {
  readonly root: HTMLElement;
  private readonly cb: LibraryCallbacks;
  private readonly grid: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly objectUrls: string[] = [];
  private hasEntries = false;
  private currentId?: string;
  private currentPlaying = false;

  constructor(cb: LibraryCallbacks) {
    this.cb = cb;
    this.root = el("div", "library hidden");

    const header = el("div", "library-header");
    const heading = el("h1", undefined, "Library");
    const spacer = el("div", "spacer");
    const add = el("button", "btn", "Open a file…");
    add.addEventListener("click", () => this.cb.onPickFile());
    const close = el("button", "btn", "Close");
    close.addEventListener("click", () => this.cb.onClose());
    header.append(heading, spacer, add, close);

    this.grid = el("div", "library-grid");
    this.empty = el("div", "library-empty");
    this.empty.append(
      el("p", undefined, "Nothing here yet."),
      el(
        "p",
        "dim-text",
        "Open a video and it is remembered — the file stays where it is on disk, " +
          "and homecast keeps only a reference to it.",
      ),
    );

    this.root.append(header, this.grid, this.empty);
  }

  /** Which entry is loaded in the player, so its card can say so. */
  setCurrent(id: string | undefined, playing: boolean): void {
    this.currentId = id;
    this.currentPlaying = playing;
  }

  async refresh(): Promise<void> {
    const entries = await listEntries();
    this.releaseUrls();
    this.grid.replaceChildren();
    this.hasEntries = entries.length > 0;
    this.empty.hidden = this.hasEntries;

    for (const entry of entries) {
      this.grid.append(await this.card(entry));
    }
  }

  private async card(entry: LibraryEntry): Promise<HTMLElement> {
    const card = el("button", "card");
    card.addEventListener("click", () => this.cb.onOpenEntry(entry));

    const thumb = el("div", "card-thumb");
    if (entry.thumbnail) {
      const url = URL.createObjectURL(entry.thumbnail);
      this.objectUrls.push(url);
      const img = el("img");
      img.src = url;
      img.alt = "";
      thumb.append(img);
    } else {
      thumb.classList.add("no-thumb");
      thumb.textContent = "360°";
    }

    if (entry.duration) {
      thumb.append(el("div", "card-duration", formatTime(entry.duration)));
    }
    if (entry.resumeAt && entry.duration) {
      const bar = el("div", "card-progress");
      const fill = el("div", "card-progress-fill");
      fill.style.width = `${Math.min(100, (entry.resumeAt / entry.duration) * 100)}%`;
      bar.append(fill);
      thumb.append(bar);
    }

    if (entry.id === this.currentId) {
      card.classList.add("current");
      thumb.append(el("div", "card-now", this.currentPlaying ? "▶ Playing" : "❚❚ Open"));
    }

    const body = el("div", "card-body");
    body.append(el("div", "card-title", entry.title ?? entry.name));

    const meta: string[] = [];
    if (entry.width && entry.height) meta.push(`${entry.width}×${entry.height}`);
    meta.push(formatBytes(entry.size));
    if (entry.chapters.length) meta.push(`${entry.chapters.length} chapters`);
    if (entry.resumeAt && entry.resumeAt > 5) meta.push(`resume ${formatTime(entry.resumeAt)}`);
    body.append(el("div", "card-meta", meta.join(" · ")));

    // A handle whose permission has lapsed still works — it just needs one
    // click to re-grant, which only a user gesture can do (M3).
    if (entry.handle) {
      const access = await queryAccess(entry.handle);
      if (access === "prompt") body.append(el("div", "card-note", "Click to re-allow access"));
      else if (access === "denied") body.append(el("div", "card-note warn-text", "Access denied — re-pick this file"));
    } else {
      body.append(el("div", "card-note", "Dropped file — pick it again to reopen"));
    }

    const remove = el("button", "card-remove", "×");
    remove.title = "Forget this file (the file itself is not touched)";
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      void deleteEntry(entry.id).then(() => this.refresh());
    });

    card.append(thumb, body);
    const wrap = el("div", "card-wrap");
    wrap.append(card, remove);
    return wrap;
  }

  private releaseUrls(): void {
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls.length = 0;
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle("hidden", !visible);
  }

  get isEmpty(): boolean {
    return !this.hasEntries;
  }

  dispose(): void {
    this.releaseUrls();
  }
}
