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
  touch: boolean;
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
    touch: navigator.maxTouchPoints > 0 && window.matchMedia("(pointer: coarse)").matches,
  };
  return { ...cap, verdict: judge(cap) };
}

/**
 * Every headline has to make sense to someone who has just arrived and done
 * nothing — so each one names a *file to open*, not a verdict on an action the
 * reader has not taken. ("This will work" reads as an answer to an unasked
 * question: what will?)
 */
function judge(c: Omit<Capability, "verdict">): Verdict {
  const detail: string[] = [];

  if (!c.webgl2) {
    return {
      level: "blocked",
      headline: "This browser can't show 360° video.",
      detail: ["It has no WebGL2. Use a current Chrome, Edge or Safari on a desktop machine."],
    };
  }

  // §5.2 — the hard wall. Not slow: impossible.
  if (c.maxTextureSize < 8192) {
    detail.push(
      `This GPU caps textures at ${c.maxTextureSize} px (${c.renderer}), so an 8K frame cannot ` +
        `be displayed at all — a hard limit, not a speed problem.`,
    );
    if (c.maxTextureSize >= 4096) {
      detail.push("Make a 4K version on your Mac with the homecast fallback command.");
      return {
        level: "degraded",
        headline: `Open a video up to ${c.maxTextureSize} px wide here.`,
        detail,
      };
    }
    return { level: "blocked", headline: "This device can't show 360° video at a useful size.", detail };
  }

  if (!c.hevcMain10) {
    detail.push(
      "This browser reports no HEVC support, so an 8K HEVC master will not decode. On Windows " +
        "that usually means the system has no HEVC decoder installed.",
    );
    if (c.h264) {
      detail.push("Make an H.264 version on your Mac with the homecast fallback command.");
      return { level: "degraded", headline: "Open an H.264 video here, not an HEVC one.", detail };
    }
    return { level: "blocked", headline: "No video decoder this player can use.", detail };
  }

  // PLAN §5.2: phones are not the target. Recent ones clear the texture limit,
  // so this is guidance about which file to bring, not a refusal.
  if (c.touch) {
    detail.push("Drag to look around, pinch to zoom, double-tap to recentre.");
    detail.push(
      "An 8K master can outrun a phone's decoder and stutter. A 4K version plays smoothly — " +
        "make one on your Mac with the homecast fallback command.",
    );
    if (!c.filePicker) {
      detail.push("This browser can't remember files, so you'll pick the video each time.");
    }
    return { level: "degraded", headline: "Open a 4K video here — 8K can outrun a phone.", detail };
  }

  detail.push(`${c.renderer} · textures to ${c.maxTextureSize} px · HEVC Main 10 ${c.hevcMain10}`);
  if (c.devicePixelRatio > 1) detail.push(`Retina display at ${c.devicePixelRatio}× — rendering at full device resolution.`);
  if (!c.filePicker) detail.push("No File System Access API — files open through a normal picker and are not remembered.");

  return { level: "ok", headline: "Ready for 8K 360° video.", detail };
}

/** `canPlayType` is advisory only (§5.3) — confirm against the real file. */
export function describeCanPlay(v: CanPlay): string {
  return v === "" ? "no" : v;
}
