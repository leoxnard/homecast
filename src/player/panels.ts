/** The capability verdict and the keyboard help sheet (PLAN §4.3). */
import type { Capability } from "./capability.ts";
import { describeCanPlay } from "./capability.ts";

function panel(): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "panel";
  return div;
}

export interface StartPanelCallbacks {
  onOpenFile: () => void;
  onShowHelp: () => void;
}

/**
 * §4.3: "tell the viewer which file to open, rather than failing mysteriously".
 * This is the first thing on screen, and it states the verdict before anything
 * has been loaded.
 */
export function startPanel(cap: Capability, cb: StartPanelCallbacks): HTMLElement {
  const root = panel();

  const h1 = document.createElement("h1");
  h1.textContent = "homecast";
  const sub = document.createElement("p");
  sub.textContent = "Local-first 360° video. Your file never leaves this machine.";

  const verdict = document.createElement("p");
  verdict.className = `verdict ${cap.verdict.level}`;
  verdict.textContent = cap.verdict.headline;

  const detail = document.createElement("ul");
  for (const line of cap.verdict.detail) {
    const li = document.createElement("li");
    li.textContent = line;
    detail.append(li);
  }

  const h2 = document.createElement("h2");
  h2.textContent = "This machine";
  const specs = document.createElement("div");
  specs.className = "keys";
  const rows: Array<[string, string]> = [
    ["GPU", cap.renderer],
    ["Max texture", `${cap.maxTextureSize} px${cap.maxTextureSize >= 8192 ? " — 8K equirect fits" : " — too small for 8K"}`],
    ["HEVC Main 10", describeCanPlay(cap.hevcMain10)],
    ["H.264", describeCanPlay(cap.h264)],
    ["Pixel ratio", `${cap.devicePixelRatio}×`],
  ];
  for (const [k, v] of rows) {
    const kbd = document.createElement("kbd");
    kbd.textContent = k;
    const val = document.createElement("div");
    val.textContent = v;
    specs.append(kbd, val);
  }

  const actions = document.createElement("div");
  actions.className = "actions";
  const open = document.createElement("button");
  open.className = "btn";
  open.textContent = "Open a video…";
  open.addEventListener("click", () => cb.onOpenFile());
  const help = document.createElement("button");
  help.className = "btn";
  help.textContent = "Keyboard shortcuts";
  help.addEventListener("click", () => cb.onShowHelp());
  actions.append(open, help);

  root.append(h1, sub, verdict, detail, h2, specs, actions);
  if (cap.verdict.level === "blocked") open.disabled = true;
  return root;
}

const SHORTCUTS: Array<[string, string]> = [
  ["drag", "pan the view"],
  ["← → ↑ ↓", "pan (hold shift for bigger steps)"],
  ["scroll / + −", "zoom (hold ⌥ to pass the clamps)"],
  ["space / K", "play or pause"],
  ["J / L", "back or forward 10 s"],
  [", / .", "step one frame"],
  ["[ / ]", "previous / next chapter"],
  ["M", "drop a chapter marker here"],
  ["C", "chapter list"],
  ["B", "library"],
  ["W", "watch together"],
  ["0–9", "jump to 0–90% of the file"],
  ["R", "reset the view"],
  ["F", "fullscreen"],
  ["O", "open another file"],
  ["?", "this list"],
];

export function helpPanel(onClose: () => void): HTMLElement {
  const root = panel();
  const h1 = document.createElement("h1");
  h1.textContent = "Keyboard";

  const keys = document.createElement("div");
  keys.className = "keys";
  for (const [k, v] of SHORTCUTS) {
    const kbd = document.createElement("kbd");
    kbd.textContent = k;
    const desc = document.createElement("div");
    desc.textContent = v;
    keys.append(kbd, desc);
  }

  const note = document.createElement("p");
  note.textContent =
    "Zoom stops are computed from the file's resolution and this window's size: " +
    "out at 110°, in at 2× upscale. Hold ⌥ to override them. The 1:1 NATIVE badge " +
    "lights when one source pixel lands on exactly one screen pixel.";

  const actions = document.createElement("div");
  actions.className = "actions";
  const close = document.createElement("button");
  close.className = "btn";
  close.textContent = "Close";
  close.addEventListener("click", onClose);
  actions.append(close);

  root.append(h1, keys, note, actions);
  return root;
}

export function toast(message: string, opts: { warn?: boolean; ms?: number } = {}): void {
  const node = document.createElement("div");
  node.className = `toast${opts.warn ? " warn" : ""}`;
  node.textContent = message;
  document.body.append(node);
  setTimeout(() => node.remove(), opts.ms ?? 3200);
}
