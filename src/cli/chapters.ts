import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { probe } from "./ffmpeg.ts";
import { formatDuration } from "./disk.ts";
import {
  isChapterSidecar, normaliseChapters, toFfmetadata, sidecarPathFor,
  type Chapter, type ChapterSidecar,
} from "../shared/chapters.ts";
import { bold, dim, ok, step, warn } from "./log.ts";

export async function loadSidecar(path: string): Promise<ChapterSidecar> {
  const raw = await readFile(resolve(path), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${(e as Error).message}`);
  }
  if (!isChapterSidecar(parsed)) {
    throw new Error(`${path} is not a homecast chapter sidecar (expected { version: 1, chapters: [...] })`);
  }
  return { ...parsed, chapters: normaliseChapters(parsed.chapters) };
}

export async function saveSidecar(path: string, sidecar: ChapterSidecar): Promise<void> {
  await writeFile(resolve(path), JSON.stringify(sidecar, null, 2) + "\n", "utf8");
}

/** Read embedded MP4 chapters back out into a sidecar (round-trip / recovery). */
export async function extractChapters(video: string, outPath?: string): Promise<void> {
  const p = await probe(video);
  // ffprobe reports start_time in seconds, already scaled by time_base.
  const chapters: Chapter[] = p.chapters.map((ch) => ({
    start: Number(ch.start_time),
    title: ch.tags?.title ?? "(untitled)",
  }));

  const sidecar: ChapterSidecar = {
    version: 1,
    video: basename(video),
    ...(p.format.tags?.title ? { title: p.format.tags.title } : {}),
    ...(p.format.tags?.artist ? { artist: p.format.tags.artist } : {}),
    duration: Number(p.format.duration ?? 0) || undefined,
    chapters: normaliseChapters(chapters),
  };

  const target = resolve(outPath ?? sidecarPathFor(video));
  await saveSidecar(target, sidecar);
  if (!chapters.length) warn("the file has no embedded chapters — wrote an empty sidecar");
  ok(`wrote ${bold(basename(target))} (${chapters.length} chapter${chapters.length === 1 ? "" : "s"})`);
  for (const c of sidecar.chapters) console.log(`  ${dim(formatDuration(c.start).padStart(8))}  ${c.title}`);
}

/** Convert a sidecar to an ffmetadata file for use with `prepare --chapters`. */
export async function sidecarToFfmetadata(sidecarPath: string, outPath: string): Promise<void> {
  const sidecar = await loadSidecar(sidecarPath);
  step(`${sidecar.chapters.length} chapters → ffmetadata`);
  await writeFile(resolve(outPath), toFfmetadata(sidecar), "utf8");
  ok(`wrote ${bold(basename(outPath))}`);
}
