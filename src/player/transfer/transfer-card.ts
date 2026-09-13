/**
 * The joining friend's view of a video transfer: what is coming, how far along
 * it is, and what to do when it cannot proceed. Sits above the transport so it
 * stays visible whether or not the room panel is open.
 */
import { formatBytes } from "../format.ts";

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

export interface CardAction {
  label: string;
  primary?: boolean;
  run: () => void;
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s left`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min left`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min left`;
}

export class TransferCard {
  readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly actions: HTMLElement;

  constructor() {
    this.root = el("div", "transfer-card");
    this.root.hidden = true;
    this.title = el("div", "transfer-title");
    this.detail = el("div", "transfer-detail");
    this.bar = el("div", "transfer-bar");
    this.fill = el("div", "transfer-fill");
    this.bar.append(this.fill);
    this.actions = el("div", "transfer-actions");
    this.root.append(this.title, this.detail, this.bar, this.actions);
  }

  show(opts: {
    title: string;
    detail?: string;
    progress?: number;
    tone?: "normal" | "warn" | "done";
    actions?: CardAction[];
  }): void {
    this.root.hidden = false;
    this.root.dataset.tone = opts.tone ?? "normal";
    this.title.textContent = opts.title;
    this.detail.textContent = opts.detail ?? "";
    this.bar.hidden = opts.progress === undefined;
    if (opts.progress !== undefined) this.fill.style.width = `${Math.max(0, Math.min(1, opts.progress)) * 100}%`;
    this.actions.replaceChildren(
      ...(opts.actions ?? []).map((a) => {
        const b = el("button", a.primary ? "btn primary-small" : "btn", a.label);
        b.addEventListener("click", a.run);
        return b;
      }),
    );
  }

  progress(name: string, received: number, size: number, bytesPerSecond: number, onCancel: () => void): void {
    const eta = bytesPerSecond > 0 ? formatEta((size - received) / bytesPerSecond) : "";
    const speed = bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond)}/s` : "starting…";
    this.show({
      title: `Getting ${name}`,
      detail: `${formatBytes(received)} of ${formatBytes(size)} · ${speed}${eta ? ` · ${eta}` : ""}`,
      progress: size ? received / size : 0,
      actions: [{ label: "Cancel", run: onCancel }],
    });
  }

  hide(): void {
    this.root.hidden = true;
  }
}
