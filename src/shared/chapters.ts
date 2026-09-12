/**
 * The chapter sidecar format.
 *
 * Two outputs are required (PLAN §5.4): embedded MP4 chapters for VLC/QuickTime,
 * and this JSON sidecar for the web player. Browsers expose no chapter API, and
 * MP4 has nowhere to put a per-chapter view direction anyway.
 */

/** Where the camera was pointing when the marker was dropped (PLAN §4.3, M4). */
export interface ViewDirection {
  /** degrees, [0, 360) — increases turning left, matching YouTube's convention (§3.5) */
  yaw: number;
  /** degrees, [-90, 90] — increases looking up */
  pitch: number;
  /** degrees, vertical field of view */
  fov: number;
}

export interface Chapter {
  /** seconds from the start of the file */
  start: number;
  title: string;
  /** optional — restored when the viewer jumps to this chapter */
  view?: ViewDirection;
}

export interface ChapterSidecar {
  version: 1;
  /** basename of the video this belongs to, for a sanity check on import */
  video?: string;
  /** maps to the ffmetadata global `title` */
  title?: string;
  /** maps to the ffmetadata global `artist` */
  artist?: string;
  /** seconds — needed to give the final chapter an END; may be omitted on import */
  duration?: number;
  chapters: Chapter[];
}

export const SIDECAR_SUFFIX = ".homecast.json";

/** Sidecar path for a video path: `foo.mp4` -> `foo.homecast.json`. */
export function sidecarPathFor(videoPath: string): string {
  return videoPath.replace(/\.[^./\\]+$/, "") + SIDECAR_SUFFIX;
}

export function isChapterSidecar(value: unknown): value is ChapterSidecar {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  if (!Array.isArray(v.chapters)) return false;
  return v.chapters.every((c: unknown) => {
    if (typeof c !== "object" || c === null) return false;
    const ch = c as Record<string, unknown>;
    return typeof ch.start === "number" && Number.isFinite(ch.start) && typeof ch.title === "string";
  });
}

/** Chapters sorted by start time, with any negative starts clamped to 0. */
export function normaliseChapters(chapters: Chapter[]): Chapter[] {
  return [...chapters]
    .map((c) => ({ ...c, start: Math.max(0, c.start) }))
    .sort((a, b) => a.start - b.start);
}

/** Index of the chapter covering `t`, or -1 before the first one. */
export function chapterIndexAt(chapters: Chapter[], t: number): number {
  let idx = -1;
  for (let i = 0; i < chapters.length; i++) {
    const c = chapters[i];
    if (c !== undefined && c.start <= t) idx = i;
    else break;
  }
  return idx;
}

/**
 * Render an ffmetadata file (PLAN §6 M1 — this exact format round-tripped).
 * TIMEBASE=1/1000, so START/END are integer milliseconds.
 */
export function toFfmetadata(sidecar: ChapterSidecar): string {
  const chapters = normaliseChapters(sidecar.chapters);
  const lines: string[] = [";FFMETADATA1"];
  if (sidecar.title) lines.push(`title=${escapeFfmetadata(sidecar.title)}`);
  if (sidecar.artist) lines.push(`artist=${escapeFfmetadata(sidecar.artist)}`);

  for (let i = 0; i < chapters.length; i++) {
    const c = chapters[i];
    if (c === undefined) continue;
    const next = chapters[i + 1];
    // ffmpeg drops a chapter whose END is not strictly after its START, so give
    // the last one a nominal second if we were not told the duration.
    const endSeconds = next ? next.start : (sidecar.duration ?? c.start + 1);
    const start = Math.round(c.start * 1000);
    const end = Math.max(start + 1, Math.round(endSeconds * 1000));
    lines.push("[CHAPTER]", "TIMEBASE=1/1000", `START=${start}`, `END=${end}`, `title=${escapeFfmetadata(c.title)}`);
  }
  return lines.join("\n") + "\n";
}

/** ffmetadata escapes =, ;, #, \ and newlines with a backslash. */
function escapeFfmetadata(s: string): string {
  return s.replace(/([=;#\\])/g, "\\$1").replace(/\n/g, "\\\n");
}
