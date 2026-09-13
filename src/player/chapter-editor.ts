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
  normaliseChapters, toFfmetadata, sidecarPathFor, parseTimestampList, toTimestampList,
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
  private readonly paste: HTMLElement;
  private pasteArea!: HTMLTextAreaElement;
  private pastePreview!: HTMLElement;
  private pasteReplace!: HTMLButtonElement;
  private pasteMerge!: HTMLButtonElement;

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
    const pasteBtn = el("button", "btn", "Paste timestamps…");
    pasteBtn.addEventListener("click", () => this.togglePaste(true));
    const copyYt = el("button", "btn", "Copy as timestamps");
    copyYt.title = "Copy in YouTube description format";
    copyYt.addEventListener("click", () => this.copyTimestamps(copyYt));
    actions.append(mark, pasteBtn, importBtn, exportJson, exportMeta, copyYt);

    this.paste = this.buildPasteBox();

    const note = el(
      "p",
      "dim-text",
      "The sidecar feeds the player and carries each chapter's view direction. " +
        "The ffmetadata file feeds `homecast prepare -c`, which embeds the chapters " +
        "so VLC and QuickTime see them too.",
    );

    this.root.append(header, this.summary, this.paste, this.list, actions, note);
  }

  // --- YouTube-style timestamp import ------------------------------------

  private buildPasteBox(): HTMLElement {
    const box = el("div", "paste-box");
    box.hidden = true;

    this.pasteArea = el("textarea", "paste-area");
    this.pasteArea.rows = 8;
    this.pasteArea.spellcheck = false;
    this.pasteArea.placeholder =
      "Paste a YouTube chapter list, e.g.\n\n0:00:00 Fanfare for The Common Man\n0:07:47 LOVE\n1:06:23 Boom Boom";
    this.pasteArea.addEventListener("input", () => this.previewPaste());

    this.pastePreview = el("div", "paste-preview dim-text");

    const row = el("div", "room-actions");
    this.pasteReplace = el("button", "btn primary-small", "Replace chapters");
    this.pasteReplace.addEventListener("click", () => this.applyPaste("replace"));
    this.pasteMerge = el("button", "btn", "Add to existing");
    this.pasteMerge.addEventListener("click", () => this.applyPaste("merge"));
    const cancel = el("button", "btn ghost", "Cancel");
    cancel.addEventListener("click", () => this.togglePaste(false));
    row.append(this.pasteReplace, this.pasteMerge, cancel);

    box.append(this.pasteArea, this.pastePreview, row);
    return box;
  }

  private togglePaste(show: boolean): void {
    this.paste.hidden = !show;
    if (show) {
      this.pasteArea.value = "";
      this.previewPaste();
      this.pasteArea.focus();
    }
  }

  private previewPaste(): void {
    const { chapters, skipped } = parseTimestampList(this.pasteArea.value);
    const { duration } = this.cb.meta();
    const beyond = duration ? chapters.filter((c) => c.start > duration).length : 0;

    const parts: string[] = [];
    if (!this.pasteArea.value.trim()) parts.push("Timestamps can be H:MM:SS or M:SS, at the start or end of a line.");
    else if (!chapters.length) parts.push("No timestamps found.");
    else {
      const first = chapters[0], last = chapters.at(-1);
      parts.push(
        `${chapters.length} chapter${chapters.length === 1 ? "" : "s"} found` +
          (first && last && chapters.length > 1 ? ` — “${first.title}” to “${last.title}”` : ""),
      );
      if (skipped.length) parts.push(`${skipped.length} line${skipped.length === 1 ? "" : "s"} without a timestamp ignored`);
      if (beyond) parts.push(`⚠ ${beyond} start after the end of this video — wrong file?`);
      if (first && first.start > 0) parts.push("first chapter doesn't start at 0:00");
    }
    this.pastePreview.textContent = parts.join(" · ");
    this.pastePreview.classList.toggle("warn-text", beyond > 0);

    const disabled = chapters.length === 0;
    this.pasteReplace.disabled = disabled;
    this.pasteMerge.disabled = disabled;
    const n = this.chapters.length;
    this.pasteReplace.textContent = n ? `Replace ${n} chapter${n === 1 ? "" : "s"}` : "Import chapters";
    this.pasteMerge.hidden = this.chapters.length === 0;
  }

  private applyPaste(mode: "replace" | "merge"): void {
    const { chapters: pasted } = parseTimestampList(this.pasteArea.value);
    if (!pasted.length) return;

    // A pasted chapter landing within a second of an existing one keeps that
    // chapter's captured view direction — YouTube lists carry titles only, and
    // re-importing a corrected list should not throw the authored views away.
    const withViews = pasted.map((c) => {
      const match = this.chapters.find((e) => e.view && Math.abs(e.start - c.start) <= 1);
      return match?.view ? { ...c, view: match.view } : c;
    });

    let next: Chapter[];
    if (mode === "replace") next = withViews;
    else {
      const kept = this.chapters.filter((e) => !withViews.some((c) => Math.abs(c.start - e.start) <= 1));
      next = [...kept, ...withViews];
    }
    this.chapters = normaliseChapters(next);
    this.togglePaste(false);
    this.commit();
  }

  private copyTimestamps(button: HTMLButtonElement): void {
    if (!this.chapters.length) return;
    const text = toTimestampList(this.chapters);
    const done = () => {
      const label = button.textContent;
      button.textContent = "Copied";
      setTimeout(() => (button.textContent = label), 1500);
    };
    void navigator.clipboard?.writeText(text).then(done, () => {
      this.togglePaste(true);
      this.pasteArea.value = text;
      this.pasteArea.select();
    });
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
    input.accept = ".json,.txt,application/json,text/plain";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) void file.text().then((text) => this.ingest(text));
    });
    input.click();
  }

  /** Shared by the import button and by dropping a sidecar on the window. */
  /** Accepts a sidecar JSON or a plain YouTube-style timestamp list. */
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
      const { chapters } = parseTimestampList(text);
      if (!chapters.length) return false;
      this.setChapters(chapters);
      this.cb.onChange(this.chapters);
      return true;
    }
  }
}
