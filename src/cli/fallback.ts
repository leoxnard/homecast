import { basename, dirname, extname, join, resolve } from "node:path";
import { unlink } from "node:fs/promises";
import { ffmpegPath, probe, runOrThrow, videoStream } from "./ffmpeg.ts";
import { formatBytes, formatDuration } from "./disk.ts";
import { ensureSpherical } from "./spherical.ts";
import { bold, dim, green, ok, step, table, warn, progress, progressDone, info } from "./log.ts";

export interface FallbackOptions {
  input: string;
  output?: string;
  /** target equirect width; height is always width/2 (PLAN §5.7) */
  width: number;
  /** Mbps */
  bitrate: number;
  overwrite: boolean;
}

export function defaultFallbackPath(input: string, width: number): string {
  const stem = basename(input, extname(input)).replace(/\.homecast$/, "");
  return join(dirname(input), `${stem}.${width}.h264.mp4`);
}

/**
 * PLAN §4.1: the only real encode in the whole pipeline, and it is conditional —
 * produce it only for a viewer whose machine cannot decode HEVC, or whose GPU
 * reports MAX_TEXTURE_SIZE < the master's width (§5.2).
 *
 * h264_videotoolbox caps at 4096 px wide, so 3840×1920 is the practical ceiling (§5.7).
 */
export async function fallback(opts: FallbackOptions): Promise<void> {
  const input = resolve(opts.input);
  const width = opts.width;
  const height = Math.round(width / 2); // equirect is ALWAYS 2:1 (§5.7)
  if (width > 4096) {
    warn(`h264_videotoolbox caps at 4096 px wide; ${width} will fail or fall back to software (§5.7)`);
  }
  const output = resolve(opts.output ?? defaultFallbackPath(input, width));
  if (input === output) throw new Error("output would overwrite the input; pass -o");

  const src = await probe(input);
  const v = videoStream(src);
  const duration = Number(src.format.duration ?? 0);
  if (v?.width && v.width <= width) {
    warn(`source is ${v.width} px wide — a ${width} px fallback is not an improvement`);
  }

  table([
    ["source", `${v?.codec_name} ${v?.width}×${v?.height}, ${formatDuration(duration)}`],
    ["target", `h264 ${width}×${height} @ ${opts.bitrate} Mbps (hardware, h264_videotoolbox)`],
    ["note", dim("conditional output — only for viewers who cannot decode HEVC (§4.1)")],
  ]);

  const args = [
    "-hide_banner", "-y",
    "-i", input,
    "-map", "0",
    "-vf", `scale=${width}:${height}:flags=lanczos`,
    "-c:v", "h264_videotoolbox",
    "-b:v", `${opts.bitrate}M`,
    "-profile:v", "high",
    "-pix_fmt", "yuv420p", // 8-bit: H.264 high10 has no hardware decode path
    "-tag:v", "avc1",
    "-c:a", "copy",
    // No +faststart: it moves moov to the front, and a leading moov cannot be
    // grown to re-inject the spherical box without shifting mdat (see mp4.ts).
    // Local playback reads the file directly, so faststart buys nothing here.
    "-map_chapters", "0",
    output,
  ];

  step(`encoding → ${bold(basename(output))}`);
  info(dim(`  ffmpeg ${args.join(" ")}`));

  const bin = await ffmpegPath();
  const started = Date.now();
  try {
    await runOrThrow(bin, args, {
      onStderr: (chunk) => {
        const m = /time=(\d+):(\d\d):(\d\d\.\d+)/.exec(chunk);
        if (!m) return;
        const done = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        const elapsed = (Date.now() - started) / 1000;
        const speed = done / Math.max(elapsed, 0.001);
        const eta = speed > 0 ? (duration - done) / speed : 0;
        progress(
          `  ${formatDuration(done)} / ${formatDuration(duration)}  ${speed.toFixed(2)}×  eta ${formatDuration(eta)}`,
        );
      },
    });
  } catch (e) {
    progressDone();
    await unlink(output).catch(() => {});
    throw e;
  } finally {
    progressDone();
  }

  // The scale filter drops spherical metadata, so write it back (§5.8 correction).
  const injection = await ensureSpherical(output, { source: input, addGoogleForm: true });

  const after = await probe(output);
  const outSize = Number(after.format.size ?? 0);
  const elapsed = (Date.now() - started) / 1000;
  table([
    ["written", `${formatBytes(outSize)} in ${formatDuration(elapsed)} (${(duration / elapsed).toFixed(2)}× realtime)`],
    ["result", `${videoStream(after)?.codec_name} ${videoStream(after)?.width}×${videoStream(after)?.height}`],
  ]);
  if (injection.injected.length) {
    table([["spherical", green(`re-injected (${injection.injected.join(", ")})`)]]);
  } else {
    warn("could not re-inject spherical metadata — VLC will show this as a flat 2:1 image");
  }
  ok(`${basename(output)} is ready`);
}
