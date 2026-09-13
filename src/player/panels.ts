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
  root.classList.add("takeover", "start-panel");

  const brand = document.createElement("div");
  brand.className = "start-brand";
  const h1 = document.createElement("h1");
  h1.textContent = "homecast";
  const sub = document.createElement("p");
  sub.className = "start-sub";
  // Says what to do, not what the product is — the reader has just arrived.
  sub.textContent = "Play a 360° video from this device.";
  brand.append(h1, sub);

  // The verdict is one line with a coloured dot — the reasoning lives in the
  // disclosure below, so arriving here is not a wall of diagnostics.
  const verdict = document.createElement("div");
  verdict.className = `start-verdict ${cap.verdict.level}`;
  const dot = document.createElement("span");
  dot.className = "verdict-dot";
  const verdictText = document.createElement("span");
  verdictText.textContent = cap.verdict.headline;
  verdict.append(dot, verdictText);

  // --- primary action ------------------------------------------------------
  const actions = document.createElement("div");
  actions.className = "start-actions";

  const open = document.createElement("button");
  open.className = "btn primary";
  open.textContent = "Open a video";
  open.addEventListener("click", () => cb.onOpenFile());

  const secondary = document.createElement("div");
  secondary.className = "start-secondary";
  const help = document.createElement("button");
  help.className = "btn ghost";
  help.textContent = cap.touch ? "How to use it" : "Keyboard shortcuts";
  help.addEventListener("click", () => cb.onShowHelp());
  secondary.append(help);

  actions.append(open, secondary);
  if (cap.verdict.level === "blocked") open.disabled = true;

  // --- everything technical, folded away -----------------------------------
  const details = document.createElement("details");
  details.className = "start-details";
  const summary = document.createElement("summary");
  summary.textContent = "What this device can do";
  details.append(summary);

  for (const line of cap.verdict.detail) {
    const p = document.createElement("p");
    p.className = "detail-line";
    p.textContent = line;
    details.append(p);
  }

  const specs = document.createElement("dl");
  specs.className = "specs";
  const rows: Array<[string, string]> = [
    ["GPU", cap.renderer],
    ["Max texture", `${cap.maxTextureSize} px${cap.maxTextureSize >= 8192 ? " — 8K equirect fits" : " — too small for 8K"}`],
    ["HEVC Main 10", describeCanPlay(cap.hevcMain10)],
    ["H.264", describeCanPlay(cap.h264)],
    ["Pixel ratio", `${cap.devicePixelRatio}×`],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    specs.append(dt, dd);
  }
  details.append(specs);

  const privacy = document.createElement("p");
  privacy.className = "start-privacy";
  privacy.textContent = "Nothing is uploaded — the file is read straight from your device.";

  root.append(brand, verdict, actions, details, privacy);
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
  ["P", "tiny planet — or zoom all the way out"],
  ["F", "fullscreen"],
  ["O", "open another file"],
  ["?", "this list"],
];

const GESTURES: Array<[string, string]> = [
  ["drag", "look around"],
  ["pinch", "zoom — keep pinching out for a tiny planet"],
  ["double-tap", "reset the view"],
  ["tap ⛶", "fullscreen"],
  ["tap the bar", "jump to a point"],
  ["tap a mark", "jump to that chapter"],
];

export function helpPanel(onClose: () => void, touch = false): HTMLElement {
  const root = panel();
  const h1 = document.createElement("h1");
  h1.textContent = touch ? "How to use it" : "Keyboard";

  const keys = document.createElement("div");
  keys.className = "keys";
  for (const [k, v] of (touch ? GESTURES : SHORTCUTS)) {
    const kbd = document.createElement("kbd");
    kbd.textContent = k;
    const desc = document.createElement("div");
    desc.textContent = v;
    keys.append(kbd, desc);
  }

  const note = document.createElement("p");
  note.textContent = touch
    ? "Zoom stops are computed from the file's resolution and your screen size: out at 110°, " +
      "in at 3× upscale. The 1:1 NATIVE badge lights when one source pixel lands on exactly " +
      "one screen pixel."
    : "Zoom stops are computed from the file's resolution and this window's size: " +
      "out at 110°, in at 3× upscale. Hold ⌥ to override them. The 1:1 NATIVE badge " +
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
