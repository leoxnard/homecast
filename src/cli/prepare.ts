import { writeFile, unlink, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, dirname, extname, resolve } from "node:path";
import {
  ffmpegPath, probe, runOrThrow, videoStream, hasSphericalMetadata, type ProbeResult,
} from "./ffmpeg.ts";
import { checkFreeSpace, formatBytes, formatDuration } from "./disk.ts";
import { loadSidecar, loadTimestampList, sniffChapterFile } from "./chapters.ts";
import { ensureSpherical } from "./spherical.ts";
import { toFfmetadata, type ChapterSidecar } from "../shared/chapters.ts";
import { bold, dim, green, yellow, ok, warn, step, table, progress, progressDone, info } from "./log.ts";

export interface PrepareOptions {
  input: string;
  output?: string;
  /** path to a sidecar .json or a raw ffmetadata .txt */
  chapters?: string;
  title?: string;
  artist?: string;
  /** retag hvc1 -> hev1. Optional insurance, NOT a prerequisite (PLAN §5.3). */
  retag: boolean;
  /** skip the 2×-input free-space guard (PLAN §3.6) */
  force: boolean;
  /** re-inject spherical metadata that ffmpeg drops (see §5.8 correction) */
  spherical: boolean;
  /** additionally write the Google st3d/sv3d form, which VLC 3 reads */
  googleForm: boolean;
  overwrite: boolean;
}

export function defaultOutputPath(input: string): string {
  const dir = dirname(input);
  const stem = basename(input, extname(input));
  return join(dir, `${stem}.homecast.mp4`);
}

export async function prepare(opts: PrepareOptions): Promise<void> {
  const input = resolve(opts.input);
  const output = resolve(opts.output ?? defaultOutputPath(input));
  if (input === output) throw new Error("output would overwrite the input; pass -o");

  step(`probing ${bold(basename(input))}`);
  const before = await probe(input);
  const v = videoStream(before);
  const sphericalBefore = hasSphericalMetadata(before);
  const durationBefore = Number(before.format.duration ?? 0);

  table([
    ["source", `${v?.codec_name} ${v?.profile ?? ""} ${v?.width}×${v?.height} [${v?.codec_tag_string}]`],
    ["duration", formatDuration(durationBefore)],
    ["spherical", sphericalBefore ? green("present") : yellow("absent")],
    ["chapters in", before.chapters.length ? String(before.chapters.length) : dim("none")],
  ]);

  // --- free-space guard (PLAN §3.6) -----------------------------------------
  const space = await checkFreeSpace(input, dirname(output));
  if (!space.ok) {
    const msg =
      `not enough free disk: ${formatBytes(space.freeBytes)} available, ` +
      `${formatBytes(space.requiredBytes)} required (2× the ${formatBytes(space.inputBytes)} input).\n` +
      `  \`-c copy\` writes a whole new file — it does not edit in place.\n` +
      `  Free space, write -o to another volume, or re-run with --force to override.`;
    if (!opts.force) throw new Error(msg);
    warn(msg.split("\n")[0] ?? msg);
    warn("--force given; continuing anyway");
  }

  if (!opts.overwrite) {
    try {
      await stat(output);
      throw new Error(`${output} already exists; pass --overwrite`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  // --- metadata -------------------------------------------------------------
  let sidecar: ChapterSidecar | undefined;
  let metadataFile: string | undefined;
  let tempDir: string | undefined;

  if (opts.chapters) {
    const kind = await sniffChapterFile(opts.chapters);
    if (kind === "ffmetadata") metadataFile = resolve(opts.chapters);
    else if (kind === "timestamps") sidecar = await loadTimestampList(opts.chapters);
    else sidecar = await loadSidecar(opts.chapters);
  }
  if (opts.title || opts.artist) {
    sidecar = {
      version: 1,
      chapters: [],
      ...sidecar,
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.artist ? { artist: opts.artist } : {}),
    };
  }
  if (sidecar) {
    if (sidecar.duration === undefined && durationBefore > 0) sidecar.duration = durationBefore;
    tempDir = await mkdtemp(join(tmpdir(), "homecast-"));
    metadataFile = join(tempDir, "chapters.ffmeta");
    await writeFile(metadataFile, toFfmetadata(sidecar), "utf8");
  }

  // --- remux (PLAN §6 M1 — this exact command form round-tripped) -----------
  const args: string[] = ["-hide_banner", "-y", "-i", input];
  if (metadataFile) args.push("-i", metadataFile, "-map_metadata", "1", "-map_chapters", "1");
  args.push("-map", "0");

  // ffmpeg renders chapters as a QuickTime text track *in addition* to the
  // chapter metadata, and `-map 0` would copy any existing one straight through
  // — so re-running prepare accumulates a junk text track per run. Chapters
  // live in the metadata; the muxer regenerates the track from it. Drop the old.
  const staleChapterTracks = chapterTextStreams(before);
  for (const index of staleChapterTracks) args.push("-map", `-0:${index}`);

  args.push("-c", "copy");
  if (opts.retag) args.push("-tag:v", "hev1");
  args.push(output);

  if (staleChapterTracks.length) {
    step(dim(`dropping ${staleChapterTracks.length} stale chapter text track(s); ffmpeg regenerates one`));
  }
  step(`remuxing → ${bold(basename(output))} ${dim("(-c copy, no re-encode)")}`);
  info(dim(`  ffmpeg ${args.join(" ")}`));

  const bin = await ffmpegPath();
  const started = Date.now();
  try {
    await runOrThrow(bin, args, {
      onStderr: (chunk) => {
        const m = /time=(\d+):(\d\d):(\d\d\.\d+)/.exec(chunk);
        if (!m) return;
        const done = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        const pct = durationBefore ? ((done / durationBefore) * 100).toFixed(1) : "?";
        progress(`  ${formatDuration(done)} / ${formatDuration(durationBefore)}  (${pct}%)`);
      },
    });
  } catch (e) {
    progressDone();
    await unlink(output).catch(() => {});
    throw e;
  } finally {
    progressDone();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
  const elapsed = (Date.now() - started) / 1000;

  // --- restore spherical metadata (§5.8 correction) -------------------------
  // ffmpeg's mov muxer never writes a spherical box, so `-c copy` silently
  // strips 360° from the output. Put it back by rewriting the trailing moov.
  if (opts.spherical && sphericalBefore) {
    const injection = await ensureSpherical(output, { source: input, addGoogleForm: opts.googleForm });
    if (injection.injected.length) {
      step(`re-injected spherical metadata: ${injection.injected.join(", ")} (+${injection.bytesAdded} bytes)`);
    }
  }

  // --- verify (PLAN §5.8: confirm the side data actually survived) ----------
  step("verifying output");
  const after = await probe(output);
  const problems = verify(before, after, { expectRetag: opts.retag, sphericalBefore });
  const outSize = Number(after.format.size ?? 0);

  table([
    ["written", `${formatBytes(outSize)} in ${elapsed.toFixed(1)} s`],
    ["fourcc", `${videoStream(before)?.codec_tag_string} → ${videoStream(after)?.codec_tag_string}`],
    ["chapters", `${before.chapters.length} → ${after.chapters.length}`],
    ["spherical", hasSphericalMetadata(after) ? green("present") : sphericalBefore ? yellow("LOST") : dim("n/a")],
  ]);

  if (problems.length) {
    for (const p of problems) warn(p);
    throw new Error("verification failed — see the warnings above");
  }
  ok(`${basename(output)} is ready`);
}

/**
 * Stream indexes of ffmpeg-generated chapter text tracks.
 *
 * Matched by handler, not by tag: copying such a track through `-c copy`
 * re-tags it (`text` becomes `gpmd`), so a tag-based filter misses exactly the
 * stale ones we are trying to drop. The handler survives the copy.
 *
 * A genuine telemetry data stream carries its own handler name and is kept.
 */
function chapterTextStreams(p: ProbeResult): number[] {
  return p.streams
    .filter(
      (s) =>
        s.codec_type === "data" &&
        (s.codec_tag_string === "text" || s.tags?.handler_name === "SubtitleHandler"),
    )
    .map((s) => s.index);
}

function verify(
  before: ProbeResult,
  after: ProbeResult,
  o: { expectRetag: boolean; sphericalBefore: boolean },
): string[] {
  const problems: string[] = [];
  const vb = videoStream(before);
  const va = videoStream(after);

  if (!va) problems.push("output has no video stream");
  if (vb && va) {
    if (vb.width !== va.width || vb.height !== va.height)
      problems.push(`resolution changed: ${vb.width}×${vb.height} → ${va.width}×${va.height}`);
    if (vb.codec_name !== va.codec_name)
      problems.push(`codec changed: ${vb.codec_name} → ${va.codec_name} (a re-encode happened — it should not have)`);
    if (vb.pix_fmt !== va.pix_fmt) problems.push(`pix_fmt changed: ${vb.pix_fmt} → ${va.pix_fmt}`);
    if (o.expectRetag && va.codec_tag_string !== "hev1")
      problems.push(`asked for -tag:v hev1 but the output is tagged ${va.codec_tag_string}`);
  }

  const db = Number(before.format.duration ?? 0);
  const da = Number(after.format.duration ?? 0);
  if (db && Math.abs(db - da) > 1)
    problems.push(`duration changed by ${(da - db).toFixed(2)} s (${db.toFixed(1)} → ${da.toFixed(1)})`);

  // §5.8 asks us to confirm rather than assume that -c copy carries this through.
  if (o.sphericalBefore && !hasSphericalMetadata(after))
    problems.push("spherical (equirectangular) metadata is missing from the output and could not be re-injected");

  const ab = before.streams.filter((s) => s.codec_type === "audio").length;
  const aa = after.streams.filter((s) => s.codec_type === "audio").length;
  if (ab !== aa) problems.push(`audio track count changed: ${ab} → ${aa}`);

  // At most one chapter text track should ever exist; more means they piled up.
  const texts = chapterTextStreams(after).length;
  if (texts > 1) problems.push(`${texts} chapter text tracks in the output — they are accumulating`);

  return problems;
}
