/**
 * Re-encode a video in the browser before sharing it: smaller for phones, or
 * H.264 for players that cannot decode HEVC.
 *
 * Mediabunny demuxes and muxes; the browser's own hardware encoders (WebCodecs)
 * do the work. The input is read from the File in pieces and the output is
 * streamed into browser storage, so an 8K master never has to fit in memory.
 * Tracks that need no change are copied rather than re-encoded.
 *
 * Not carried over: the spherical-video metadata box. homecast plays the result
 * as 360° regardless; a generic player (VLC) may show it flat.
 */
import type { VideoCodec } from "mediabunny";
import { openScratchFile, type ScratchFile } from "../transfer/sinks.ts";

export type Codec = "original" | "avc" | "hevc";

export interface Preset {
  codec: Codec;
  /** output width; height follows the source aspect. undefined = source size */
  width?: number;
  quality: "standard" | "high";
}

export interface SourceInfo {
  width: number;
  height: number;
  duration: number;
  frameRate: number;
  codec: string | null;
}

export interface ResolutionChoice {
  width: number;
  height: number;
  label: string;
}

const mediabunny = () => import("mediabunny");

export async function probe(file: File): Promise<SourceInfo | undefined> {
  const { Input, BlobSource, ALL_FORMATS } = await mediabunny();
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return undefined;
    const stats = await track.computePacketStats(120).catch(() => undefined);
    return {
      width: track.displayWidth,
      height: track.displayHeight,
      duration: await input.computeDuration(),
      frameRate: stats?.averagePacketRate || 30,
      codec: track.codec,
    };
  } finally {
    input.dispose?.();
  }
}

/** Standard 2:1 sizes up to the source's own width, largest first. */
export function resolutionChoices(source: SourceInfo): ResolutionChoice[] {
  const aspect = source.height / source.width;
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return [
    { width: 7680, label: "8K" },
    { width: 5760, label: "5.7K" },
    { width: 3840, label: "4K" },
    { width: 2880, label: "3K" },
    { width: 1920, label: "HD" },
  ]
    .filter((c) => c.width < source.width)
    .map((c) => ({ ...c, width: c.width, height: even(c.width * aspect) }));
}

/** Bits per pixel per frame; 360° video spreads detail thin, so these are generous. */
const BPP: Record<Exclude<Codec, "original">, Record<Preset["quality"], number>> = {
  avc: { standard: 0.07, high: 0.12 },
  hevc: { standard: 0.04, high: 0.07 },
};

export function outputSize(preset: Preset, source: SourceInfo): { width: number; height: number } {
  const width = preset.width ?? source.width;
  return { width, height: Math.max(2, Math.round((width * source.height) / source.width / 2) * 2) };
}

export function videoBitrate(preset: Preset, source: SourceInfo): number | undefined {
  if (preset.codec === "original") return undefined;
  const { width, height } = outputSize(preset, source);
  return Math.round(width * height * Math.min(source.frameRate, 60) * BPP[preset.codec][preset.quality]);
}

/** Rough size of the result, for the panel. Audio assumed ~256 kbit/s. */
export function estimateBytes(preset: Preset, source: SourceInfo, originalBytes: number): number {
  const bitrate = videoBitrate(preset, source);
  if (bitrate === undefined) return originalBytes;
  return ((bitrate + 256_000) * source.duration) / 8;
}

export async function canEncode(codec: Exclude<Codec, "original">, width: number, height: number): Promise<boolean> {
  if (typeof VideoEncoder === "undefined") return false;
  const { canEncodeVideo } = await mediabunny();
  return canEncodeVideo(codec as VideoCodec, { width, height }).catch(() => false);
}

export interface TranscodeHandle {
  done: Promise<File>;
  cancel(): void;
}

/**
 * Convert `file` into a scratch file in browser storage. Progress is 0..1.
 * The caller deletes the scratch file when finished with it.
 */
export function transcode(
  file: File,
  preset: Preset,
  source: SourceInfo,
  outputName: string,
  onProgress: (progress: number) => void,
): TranscodeHandle {
  let cancelled = false;
  let conversion: { cancel(): Promise<void> } | undefined;
  let scratch: ScratchFile | undefined;

  const done = (async () => {
    const { Input, Output, Conversion, BlobSource, StreamTarget, Mp4OutputFormat, ALL_FORMATS } = await mediabunny();
    scratch = await openScratchFile(outputName);
    const sink = scratch;
    const writable = new WritableStream<{ type: "write"; data: Uint8Array; position: number }>({
      write: (chunk) => sink.writeAt(chunk.data, chunk.position),
    });
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: false }),
      target: new StreamTarget(writable, { chunked: true, chunkSize: 16 * 1024 * 1024 }),
    });
    const { width, height } = outputSize(preset, source);
    const c = await Conversion.init({
      input,
      output,
      tracks: "primary",
      video:
        preset.codec === "original"
          ? {}
          : { codec: preset.codec, width, height, fit: "fill", bitrate: videoBitrate(preset, source) },
      // Subtitle/data tracks (chapter text, GoPro metadata) are left out.
    });
    conversion = c;
    if (cancelled) await c.cancel();
    if (!c.isValid) {
      const reason = c.discardedTracks.map((t) => `${t.track.type}: ${t.reason}`).join(", ");
      throw new Error(`this browser cannot convert the video (${reason || "unsupported"})`);
    }
    c.onProgress = (p) => onProgress(p);
    await c.execute();
    input.dispose?.();
    return sink.close();
  })().catch(async (err: unknown) => {
    await scratch?.abort();
    throw cancelled ? new Error("cancelled") : err;
  });

  return {
    done,
    cancel() {
      cancelled = true;
      void conversion?.cancel();
    },
  };
}
