/**
 * Chapter authoring (PLAN §4.3, M4).
 *
 * A keypress drops a marker at the current frame, asks for a name, and captures
 * the view direction you were looking at — which is the part MP4 has nowhere to
 * store, and the reason the JSON sidecar exists alongside embedded chapters
 * (§5.4).
 *
 * Export writes both outputs, because browsers cannot read MP4 chapter atoms
 * and VLC cannot load an external chapter file (§5.4, §5.5).
 */
import {
  normaliseChapters, toFfmetadata, sidecarPathFor,
  type Chapter, type ChapterSidecar, type ViewDirection,
} from "../shared/chapters.ts";
import { formatTime } from "./format.ts";

export interface ChapterEditorCallbacks {
  onChange: (chapters: Chapter[]) => void;
  onJump: (index: number) => void;
  onClose: () => void;
  /** current playhead and view, read at the moment a marker is dropped */
  readState: () => { time: number; view: ViewDirection };
  meta: () => { videoName: string; duration: number; title?: string; artist?: string };
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

function download(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export class ChapterEditor {
  readonly root: HTMLElement;
  private readonly cb: ChapterEditorCallbacks;
  private readonly list: HTMLElement;
  private readonly summary: HTMLElement;
  private chapters: Chapter[] = [];

  constructor(cb: ChapterEditorCallbacks) {
    this.cb = cb;
    this.root = el("div", "panel chapters-panel");

    const header = el("div", "chapters-header");
    header.append(el("h1", undefined, "Chapters"));
    const spacer = el("div", "spacer");
    const close = el("button", "btn", "Close");
    close.addEventListener("click", () => this.cb.onClose());
    header.append(spacer, close);

    this.summary = el("p", undefined, "");
    this.list = el("div", "chapter-list");

    const actions = el("div", "actions");
    const mark = el("button", "btn", "Mark here (M)");
    mark.addEventListener("click", () => this.mark());
    const exportJson = el("button", "btn", "Export sidecar");
    exportJson.addEventListener("click", () => this.exportSidecar());
    const exportMeta = el("button", "btn", "Export ffmetadata");
    exportMeta.addEventListener("click", () => this.exportFfmetadata());
    const importBtn = el("button", "btn", "Import…");
    importBtn.addEventListener("click", () => this.importSidecar());
    actions.append(mark, exportJson, exportMeta, importBtn);

    const note = el(
      "p",
      "dim-text",
      "The sidecar feeds the player and carries each chapter's view direction. " +
        "The ffmetadata file feeds `homecast prepare -c`, which embeds the chapters " +
        "so VLC and QuickTime see them too.",
    );

    this.root.append(header, this.summary, this.list, actions, note);
  }

  setChapters(chapters: Chapter[]): void {
    this.chapters = normaliseChapters(chapters);
    this.render();
  }

  getChapters(): Chapter[] {
    return this.chapters;
  }

  /** Drop a marker at the current frame, capturing where we were looking. */
  mark(): void {
    const { time, view } = this.cb.readState();
    const title = window.prompt(`Chapter at ${formatTime(time)}`, `Chapter ${this.chapters.length + 1}`);
    if (title === null) return;
    this.chapters = normaliseChapters([
      ...this.chapters,
      { start: time, title: title.trim() || `Chapter ${this.chapters.length + 1}`, view },
    ]);
    this.commit();
  }

  private commit(): void {
    this.render();
    this.cb.onChange(this.chapters);
  }

  private render(): void {
    this.list.replaceChildren();
    const { duration } = this.cb.meta();
    this.summary.textContent = this.chapters.length
      ? `${this.chapters.length} chapter${this.chapters.length === 1 ? "" : "s"}`
      : "No chapters yet — press M while watching to drop one.";

    this.chapters.forEach((chapter, index) => {
      const row = el("div", "chapter-row");

      const time = el("button", "chapter-time", formatTime(chapter.start));
      time.title = "Jump here";
      time.addEventListener("click", () => this.cb.onJump(index));

      const title = el("input", "chapter-title-input");
      title.value = chapter.title;
      title.addEventListener("change", () => {
        const next = [...this.chapters];
        const current = next[index];
        if (!current) return;
        next[index] = { ...current, title: title.value };
        this.chapters = next;
        this.cb.onChange(this.chapters);
      });

      const view = el(
        "div",
        "chapter-view",
        chapter.view ? `${chapter.view.yaw.toFixed(0)}° / ${chapter.view.pitch.toFixed(0)}° / ${chapter.view.fov.toFixed(0)}°` : "—",
      );
      view.title = chapter.view ? "yaw / pitch / fov captured with this marker" : "No view captured";

      const recapture = el("button", "chapter-mini", "⟳");
      recapture.title = "Replace the captured view with the current one";
      recapture.addEventListener("click", () => {
        const next = [...this.chapters];
        const current = next[index];
        if (!current) return;
        next[index] = { ...current, view: this.cb.readState().view };
        this.chapters = next;
        this.commit();
      });

      const remove = el("button", "chapter-mini", "×");
      remove.title = "Delete this chapter";
      remove.addEventListener("click", () => {
        this.chapters = this.chapters.filter((_, i) => i !== index);
        this.commit();
      });

      if (duration && chapter.start > duration) row.classList.add("out-of-range");
      row.append(time, title, view, recapture, remove);
      this.list.append(row);
    });
  }

  private sidecar(): ChapterSidecar {
    const { videoName, duration, title, artist } = this.cb.meta();
    return {
      version: 1,
      video: videoName,
      ...(title ? { title } : {}),
      ...(artist ? { artist } : {}),
      duration: duration || undefined,
      chapters: this.chapters,
    };
  }

  private exportSidecar(): void {
    const { videoName } = this.cb.meta();
    download(
      sidecarPathFor(videoName).split("/").pop() ?? "chapters.homecast.json",
      JSON.stringify(this.sidecar(), null, 2) + "\n",
      "application/json",
    );
  }

  private exportFfmetadata(): void {
    const { videoName } = this.cb.meta();
    const stem = videoName.replace(/\.[^./\\]+$/, "");
    download(`${stem}.ffmeta.txt`, toFfmetadata(this.sidecar()), "text/plain");
  }

  private importSidecar(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) void file.text().then((text) => this.ingest(text));
    });
    input.click();
  }

  /** Shared by the import button and by dropping a sidecar on the window. */
  ingest(text: string): boolean {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null) return false;
      const candidate = parsed as ChapterSidecar;
      if (candidate.version !== 1 || !Array.isArray(candidate.chapters)) return false;
      this.setChapters(candidate.chapters);
      this.cb.onChange(this.chapters);
      return true;
    } catch {
      return false;
    }
  }
}
