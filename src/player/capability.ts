/**
 * Capability probe (PLAN §4.3, §5.2, §5.3).
 *
 * The point is to tell the viewer *which file to open*, rather than failing
 * mysteriously halfway through a concert.
 */

export interface Capability {
  webgl2: boolean;
  maxTextureSize: number;
  /** the widest equirect frame this GPU can bind as a texture */
  maxVideoWidth: number;
  renderer: string;
  hevc: CanPlay;
  hevcMain10: CanPlay;
  h264: CanPlay;
  devicePixelRatio: number;
  wakeLock: boolean;
  filePicker: boolean;
  verdict: Verdict;
}

export type CanPlay = "" | "maybe" | "probably";

export interface Verdict {
  level: "ok" | "degraded" | "blocked";
  headline: string;
  detail: string[];
}

/**
 * §5.3: always probe with a COMPLETE codec string. The bare `codecs="hvc1"`
 * returns "" because Chromium rejects it as malformed, which is what produced
 * the plan's original wrong conclusion.
 */
export const CODEC_STRINGS = {
  /** HEVC Main, level 4.1 — a modest baseline */
  hevcMain: 'video/mp4; codecs="hvc1.1.6.L93.B0"',
  /** HEVC Main 10, level 6.0 — what the 8K masters actually are */
  hevcMain10: 'video/mp4; codecs="hvc1.2.4.L180.B0"',
  hevcMain10Hev1: 'video/mp4; codecs="hev1.2.4.L180.B0"',
  h264: 'video/mp4; codecs="avc1.640028"',
} as const;

function canPlay(type: string): CanPlay {
  const probe = document.createElement("video");
  return probe.canPlayType(type) as CanPlay;
}

function glInfo(): { webgl2: boolean; maxTextureSize: number; renderer: string } {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2");
  if (!gl) return { webgl2: false, maxTextureSize: 0, renderer: "none" };
  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = dbg
    ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
    : String(gl.getParameter(gl.RENDERER));
  // Release the probe context rather than leaving it to the GC.
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return { webgl2: true, maxTextureSize, renderer };
}

export function probeCapability(): Capability {
  const { webgl2, maxTextureSize, renderer } = glInfo();
  const hevcMain10 = canPlay(CODEC_STRINGS.hevcMain10) || canPlay(CODEC_STRINGS.hevcMain10Hev1);

  const cap: Omit<Capability, "verdict"> = {
    webgl2,
    maxTextureSize,
    maxVideoWidth: maxTextureSize,
    renderer,
    hevc: canPlay(CODEC_STRINGS.hevcMain),
    hevcMain10,
    h264: canPlay(CODEC_STRINGS.h264),
    devicePixelRatio: window.devicePixelRatio || 1,
    wakeLock: "wakeLock" in navigator,
    filePicker: "showOpenFilePicker" in window,
  };
  return { ...cap, verdict: judge(cap) };
}

function judge(c: Omit<Capability, "verdict">): Verdict {
  const detail: string[] = [];

  if (!c.webgl2) {
    return {
      level: "blocked",
      headline: "This browser has no WebGL2 — 360° playback is impossible here.",
      detail: ["Use a current Chrome, Edge, or Safari on a desktop machine."],
    };
  }

  // §5.2 — the hard wall. Not slow: impossible.
  if (c.maxTextureSize < 8192) {
    detail.push(
      `This GPU caps textures at ${c.maxTextureSize} px (${c.renderer}), so an 8K equirect ` +
        `frame cannot be bound at all — this is a hard limit, not a speed problem.`,
    );
    if (c.maxTextureSize >= 4096) {
      detail.push("Open a 4K file instead: `homecast fallback <master>` produces 3840×1920.");
      return { level: "degraded", headline: `Open a ≤${c.maxTextureSize} px file on this machine.`, detail };
    }
    return { level: "blocked", headline: "This GPU cannot display 360° video at any useful size.", detail };
  }

  if (!c.hevcMain10) {
    detail.push(
      "This browser reports no HEVC Main 10 support, so the 8K master will not decode. " +
        "On Windows this usually means the OS has no registered HEVC decoder.",
    );
    if (c.h264) {
      detail.push("Open the H.264 fallback instead: `homecast fallback <master>`.");
      return { level: "degraded", headline: "Open the H.264 fallback file, not the master.", detail };
    }
    return { level: "blocked", headline: "No usable video decoder found.", detail };
  }

  detail.push(`${c.renderer} · textures to ${c.maxTextureSize} px · HEVC Main 10 ${c.hevcMain10}`);
  if (c.devicePixelRatio > 1) detail.push(`Retina display at ${c.devicePixelRatio}× — rendering at full device resolution.`);
  if (!c.filePicker) detail.push("No File System Access API — files open through a normal picker and are not remembered.");

  return { level: "ok", headline: "Ready for 8K 360° playback.", detail };
}

/** `canPlayType` is advisory only (§5.3) — confirm against the real file. */
export function describeCanPlay(v: CanPlay): string {
  return v === "" ? "no" : v;
}
