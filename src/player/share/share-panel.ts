/**
 * "Share video": pick a format and size, and get a Pingvin link for it.
 *
 * Original uploads the file as it is. Anything else is converted in this
 * browser first (transcode.ts), written to browser storage, uploaded, and the
 * temporary copy deleted. The link opens homecast, which downloads the video
 * and plays it; the Pingvin page is offered too, for a plain download.
 */
import { formatBytes } from "../format.ts";
import { formatEta } from "../transfer/transfer-card.ts";
import {
  expirationChoices, storedUploadKey, storeUploadKey, uploadToPingvin, UploadError, type PingvinStatus,
} from "../transfer/pingvin.ts";
import { deleteScratchFile } from "../transfer/sinks.ts";
import {
  canEncode, estimateBytes, outputSize, probe, resolutionChoices, transcode,
  type Codec, type Preset, type SourceInfo,
} from "./transcode.ts";

export interface SharedLink {
  /** homecast link that downloads and opens the video */
  link: string;
  /** Pingvin's own download page */
  pageUrl?: string;
  /** "4K · H.264" */
  label: string;
  size: number;
  createdAt: number;
  /** ms since epoch; undefined = never */
  expiresAt?: number;
}

export interface SharePanelDeps {
  onClose: () => void;
  pingvin: () => PingvinStatus;
  /** earlier links for this video, newest first */
  saved: () => SharedLink[];
  save: (link: SharedLink) => void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const CODEC_LABEL: Record<Codec, string> = { original: "Original", avc: "H.264", hevc: "HEVC" };
const CODEC_HINT: Record<Codec, string> = {
  original: "Uploads the file unchanged — fastest, full quality",
  avc: "Plays on every device and browser",
  hevc: "About half the size of H.264 at the same quality",
};
const EXPIRY_DAYS: Record<string, number> = { "1-day": 1, "1-week": 7, "1-month": 30, "3-months": 91, "1-year": 365 };

function segmented<T extends string>(options: Array<{ value: T; label: string }>, onPick: (v: T) => void) {
  const root = el("div", "segmented");
  const buttons = new Map<T, HTMLButtonElement>();
  for (const o of options) {
    const b = el("button", "seg", o.label);
    b.type = "button";
    b.addEventListener("click", () => onPick(o.value));
    buttons.set(o.value, b);
    root.append(b);
  }
  return {
    root,
    set(value: T) {
      for (const [v, b] of buttons) b.classList.toggle("on", v === value);
    },
    enable(value: T, on: boolean) {
      const b = buttons.get(value);
      if (b) b.disabled = !on;
    },
  };
}

async function copyText(text: string, button: HTMLButtonElement): Promise<void> {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
  } catch {
    window.prompt("Copy this link", text);
  }
  setTimeout(() => (button.textContent = original), 1500);
}

export class SharePanel {
  readonly root: HTMLElement;
  private readonly deps: SharePanelDeps;
  private file?: File;
  private source?: SourceInfo;
  private preset: Preset = { codec: "original", quality: "high" };
  private expiration = "1-week";
  private running?: { cancel: () => void };

  private readonly info = el("div", "share-info");
  private readonly form = el("div", "share-form");
  private readonly codecSeg;
  private readonly codecHint = el("div", "share-hint");
  private readonly sizeSelect = el("select", "share-select");
  private readonly qualitySeg;
  private readonly expirySelect = el("select", "share-select");
  private readonly estimate = el("div", "share-estimate");
  private readonly createBtn = el("button", "btn primary-small share-create", "Create link");
  private readonly progress = el("div", "share-run");
  private readonly progressLabel = el("div", "share-label");
  private readonly progressFill = el("div", "transfer-fill");
  private readonly result = el("div", "share-result");
  private readonly history = el("div", "share-history");
  private readonly notice = el("div", "share-notice");

  constructor(deps: SharePanelDeps) {
    this.deps = deps;
    this.root = el("div", "panel share-panel");

    const header = el("div", "chapters-header");
    header.append(el("h1", undefined, "Share video"), el("div", "spacer"));
    const close = el("button", "btn", "Close");
    close.addEventListener("click", () => this.deps.onClose());
    header.append(close);

    this.codecSeg = segmented<Codec>(
      (["original", "avc", "hevc"] as const).map((value) => ({ value, label: CODEC_LABEL[value] })),
      (codec) => {
        this.preset = { ...this.preset, codec };
        this.render();
      },
    );
    this.qualitySeg = segmented<Preset["quality"]>(
      [
        { value: "standard", label: "Standard" },
        { value: "high", label: "High" },
      ],
      (quality) => {
        this.preset = { ...this.preset, quality };
        this.render();
      },
    );
    this.sizeSelect.addEventListener("change", () => {
      const w = Number(this.sizeSelect.value);
      this.preset = { ...this.preset, width: w > 0 ? w : undefined };
      this.render();
    });
    this.expirySelect.addEventListener("change", () => (this.expiration = this.expirySelect.value));
    this.createBtn.addEventListener("click", () => void this.create());

    const row = (label: string, ...control: HTMLElement[]) => {
      const r = el("div", "share-row");
      r.append(el("div", "share-row-label", label), ...control);
      return r;
    };
    this.form.append(
      row("Format", this.codecSeg.root),
      this.codecHint,
      row("Resolution", this.sizeSelect),
      row("Quality", this.qualitySeg.root),
      row("Link lasts", this.expirySelect),
    );

    const bar = el("div", "transfer-bar");
    bar.append(this.progressFill);
    const cancel = el("button", "btn ghost", "Cancel");
    cancel.addEventListener("click", () => this.running?.cancel());
    const barRow = el("div", "share-progress");
    barRow.append(bar, cancel);
    this.progress.append(this.progressLabel, barRow);
    this.progress.hidden = true;
    this.result.hidden = true;

    const footer = el("div", "share-footer");
    footer.append(this.estimate, this.createBtn);

    this.root.append(header, this.info, this.notice, this.form, footer, this.progress, this.result, this.history);
  }

  /** Called whenever the panel opens, with the video currently loaded. */
  async open(file: File | undefined): Promise<void> {
    const status = this.deps.pingvin();
    this.renderHistory();
    this.notice.hidden = true;
    if (!status.enabled) {
      this.showNotice("Pingvin is not set up on this server, so links cannot be created.");
      return;
    }
    const expiry = expirationChoices(status.maxExpiration);
    this.expirySelect.replaceChildren(...expiry.map((c) => new Option(c.label, c.value)));
    // Longest allowed by default: a shared video should still be there next month.
    this.expiration = expiry[expiry.length - 1]?.value ?? "1-week";
    this.expirySelect.value = this.expiration;

    if (!file?.size) {
      this.file = undefined;
      this.showNotice("Open a video first — this shares the one that is playing.");
      return;
    }
    if (this.file === file && this.source) return this.render();
    if (this.running) return;

    this.file = file;
    this.source = undefined;
    this.info.textContent = `${file.name} · ${formatBytes(file.size)} · reading…`;
    this.form.hidden = true;
    this.createBtn.disabled = true;
    const source = await probe(file).catch(() => undefined);
    if (this.file !== file) return;
    if (!source) {
      this.info.textContent = `${file.name} · ${formatBytes(file.size)}`;
      this.preset = { codec: "original", quality: "high" };
      this.source = { width: 0, height: 0, duration: 0, frameRate: 30, codec: null };
      this.render();
      this.codecSeg.enable("avc", false);
      this.codecSeg.enable("hevc", false);
      return;
    }
    this.source = source;
    this.info.textContent = `${file.name} · ${source.width}×${source.height} · ${formatBytes(file.size)}`;
    this.sizeSelect.replaceChildren(
      new Option(`Original · ${source.width}×${source.height}`, "0"),
      ...resolutionChoices(source).map((c) => new Option(`${c.label} · ${c.width}×${c.height}`, String(c.width))),
    );
    this.preset = { codec: "original", quality: "high" };
    this.sizeSelect.value = "0";
    this.render();
    // Which encoders exist depends on the browser and the machine.
    for (const codec of ["avc", "hevc"] as const) {
      const smallest = resolutionChoices(source).at(-1) ?? source;
      void canEncode(codec, smallest.width, smallest.height).then((ok) => this.codecSeg.enable(codec, ok));
    }
  }

  private showNotice(text: string): void {
    this.notice.textContent = text;
    this.notice.hidden = false;
    this.form.hidden = true;
    this.createBtn.hidden = true;
    this.estimate.textContent = "";
    this.info.textContent = "";
  }

  private render(): void {
    const source = this.source;
    const file = this.file;
    if (!source || !file) return;
    this.form.hidden = false;
    this.createBtn.hidden = false;
    this.createBtn.disabled = !!this.running;
    this.codecSeg.set(this.preset.codec);
    this.qualitySeg.set(this.preset.quality);
    this.codecHint.textContent = CODEC_HINT[this.preset.codec];
    const original = this.preset.codec === "original";
    this.sizeSelect.disabled = original;
    this.qualitySeg.root.classList.toggle("disabled", original);
    if (original) this.sizeSelect.value = "0";
    for (const b of this.qualitySeg.root.querySelectorAll("button")) b.disabled = original;
    const bytes = estimateBytes(original ? { ...this.preset, width: undefined } : this.preset, source, file.size);
    this.estimate.textContent = original ? formatBytes(file.size) : `≈ ${formatBytes(bytes)}`;
  }

  private label(): string {
    if (this.preset.codec === "original" || !this.source) return "Original";
    const { width, height } = outputSize(this.preset, this.source);
    const size = resolutionChoices(this.source).find((c) => c.width === width)?.label ?? `${width}×${height}`;
    return `${size} · ${CODEC_LABEL[this.preset.codec]}${this.preset.quality === "high" ? "" : " · standard"}`;
  }

  private setRunning(label: string, progress: number): void {
    this.progress.hidden = false;
    this.progressLabel.textContent = label;
    this.progressFill.style.width = `${Math.max(0, Math.min(1, progress)) * 100}%`;
  }

  private async create(): Promise<void> {
    const file = this.file;
    const source = this.source;
    if (!file || !source || this.running) return;

    let key = storedUploadKey();
    if (!key) {
      key = window.prompt("Upload key (HOMECAST_UPLOAD_KEY on the server)")?.trim() || undefined;
      if (!key) return;
    }

    const preset = { ...this.preset };
    const label = this.label();
    const expiration = this.expiration;
    const base = file.name.replace(/\.[^.]+$/, "");
    const outName = preset.codec === "original" ? file.name : `${base} (${label.replace(/ · /g, " ")}).mp4`;
    let cancelled = false;
    const abort = new AbortController();
    let conversion: { cancel(): void } | undefined;
    this.running = {
      cancel: () => {
        cancelled = true;
        conversion?.cancel();
        abort.abort();
      },
    };
    this.result.hidden = true;
    this.render();
    const wake = await navigator.wakeLock?.request("screen").catch(() => undefined);

    try {
      let upload = file;
      if (preset.codec !== "original") {
        const started = performance.now();
        this.setRunning("Converting…", 0);
        const job = transcode(file, preset, source, outName, (p) => {
          const elapsed = (performance.now() - started) / 1000;
          const eta = p > 0.02 ? formatEta((elapsed / p) * (1 - p)) : "";
          this.setRunning(`Converting ${Math.floor(p * 100)}%${eta ? ` · ${eta}` : ""} — keep this tab open`, p);
        });
        conversion = job;
        upload = await job.done;
        upload = new File([upload], outName, { type: "video/mp4", lastModified: upload.lastModified });
      }
      if (cancelled) throw new Error("cancelled");

      this.setRunning("Uploading…", 0);
      const result = await uploadToPingvin(
        upload,
        key,
        (p) => {
          const eta = p.bytesPerSecond > 0 ? formatEta((p.size - p.sent) / p.bytesPerSecond) : "";
          this.setRunning(
            [`Uploading ${Math.floor((p.sent / p.size) * 100)}%`, p.bytesPerSecond ? `${formatBytes(p.bytesPerSecond)}/s` : "", eta]
              .filter(Boolean)
              .join(" · "),
            p.sent / p.size,
          );
        },
        abort.signal,
        { expiration },
      );
      storeUploadKey(key);

      const q = new URLSearchParams({ get: "1", src: result.downloadPath, n: upload.name, s: String(upload.size) });
      const days = EXPIRY_DAYS[expiration];
      const shared: SharedLink = {
        link: `${location.origin}/?${q}`,
        pageUrl: result.pageUrl,
        label,
        size: upload.size,
        createdAt: Date.now(),
        expiresAt: days ? Date.now() + days * 86_400_000 : undefined,
      };
      this.deps.save(shared);
      this.showResult(shared);
      this.renderHistory();
    } catch (err) {
      const status = err instanceof UploadError ? err.status : 0;
      if (status === 401) storeUploadKey(undefined);
      const message = (err as Error).message;
      this.progress.hidden = false;
      this.progressFill.style.width = "0%";
      this.progressLabel.textContent =
        cancelled || message === "cancelled"
          ? "Cancelled"
          : status === 401
            ? "Wrong upload key"
            : `Failed: ${message}`;
    } finally {
      if (preset.codec !== "original") void deleteScratchFile(outName);
      void wake?.release().catch(() => {});
      this.running = undefined;
      this.render();
    }
  }

  private showResult(s: SharedLink): void {
    this.progress.hidden = true;
    this.result.hidden = false;
    this.result.replaceChildren(el("div", "share-title", `Link ready · ${s.label} · ${formatBytes(s.size)}`), ...this.linkRows(s));
  }

  private linkRows(s: SharedLink): HTMLElement[] {
    const rows: HTMLElement[] = [];
    const add = (text: string, url: string, note: string) => {
      const r = el("div", "room-actions share-link-row");
      const input = el("input", "room-link");
      input.readOnly = true;
      input.value = url;
      const copy = el("button", "btn", "Copy");
      copy.addEventListener("click", () => void copyText(url, copy));
      r.append(el("div", "share-link-kind", text), input, copy);
      r.title = note;
      rows.push(r);
    };
    add("Watch", s.link, "Opens homecast, downloads the video and plays it");
    if (s.pageUrl) add("Download", s.pageUrl, "Pingvin's download page");
    return rows;
  }

  private renderHistory(): void {
    const now = Date.now();
    const list = this.deps.saved().filter((s) => !s.expiresAt || s.expiresAt > now);
    this.history.hidden = list.length === 0;
    if (!list.length) return this.history.replaceChildren();
    const items = list.slice(0, 5).map((s) => {
      const item = el("details", "share-old");
      const until = s.expiresAt ? `until ${new Date(s.expiresAt).toLocaleDateString()}` : "no expiry";
      item.append(el("summary", undefined, `${s.label} · ${formatBytes(s.size)} · ${until}`), ...this.linkRows(s));
      return item;
    });
    this.history.replaceChildren(el("h2", undefined, "Earlier links"), ...items);
  }
}
