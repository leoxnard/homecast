import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";

const FFMPEG = process.env.HOMECAST_FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const FFPROBE = process.env.HOMECAST_FFPROBE ?? "/opt/homebrew/bin/ffprobe";

export class ToolError extends Error {}

async function resolveTool(preferred: string, fallback: string): Promise<string> {
  try {
    await access(preferred, constants.X_OK);
    return preferred;
  } catch {
    return fallback; // let PATH resolve it
  }
}

export const ffmpegPath = () => resolveTool(FFMPEG, "ffmpeg");
export const ffprobePath = () => resolveTool(FFPROBE, "ffprobe");

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a tool to completion. `onStderr` receives ffmpeg's progress chatter live. */
export function run(
  bin: string,
  args: string[],
  opts: { onStderr?: (chunk: string) => void } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      opts.onStderr?.(s);
    });
    child.on("error", (err) =>
      reject(new ToolError(`could not run ${bin}: ${(err as Error).message}`)),
    );
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Run and throw on a non-zero exit, surfacing the tail of stderr. */
export async function runOrThrow(
  bin: string,
  args: string[],
  opts: { onStderr?: (chunk: string) => void } = {},
): Promise<RunResult> {
  const result = await run(bin, args, opts);
  if (result.code !== 0) {
    const tail = result.stderr.trim().split("\n").slice(-12).join("\n");
    throw new ToolError(`${bin} exited ${result.code}\n${tail}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// ffprobe
// ---------------------------------------------------------------------------

export interface ProbeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  codec_tag_string?: string;
  profile?: string;
  level?: number;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  bit_rate?: string;
  channels?: number;
  channel_layout?: string;
  sample_rate?: string;
  nb_frames?: string;
  tags?: Record<string, string>;
  side_data_list?: Array<Record<string, unknown>>;
}

export interface ProbeChapter {
  id: number;
  time_base: string;
  start_time: string;
  end_time: string;
  tags?: Record<string, string>;
}

export interface ProbeResult {
  streams: ProbeStream[];
  chapters: ProbeChapter[];
  format: {
    filename: string;
    format_name?: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
    tags?: Record<string, string>;
  };
}

export async function probe(file: string): Promise<ProbeResult> {
  const bin = await ffprobePath();
  const { stdout } = await runOrThrow(bin, [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    "-show_chapters",
    "-of", "json",
    file,
  ]);
  return JSON.parse(stdout) as ProbeResult;
}

export const videoStream = (p: ProbeResult): ProbeStream | undefined =>
  p.streams.find((s) => s.codec_type === "video");

export const audioStreams = (p: ProbeResult): ProbeStream[] =>
  p.streams.filter((s) => s.codec_type === "audio");

/**
 * Does the video stream carry equirectangular spherical metadata? (PLAN §5.8 —
 * the master already has it; §5.8 also says to *verify* it survives `-c copy`.)
 */
export function hasSphericalMetadata(p: ProbeResult): boolean {
  const v = videoStream(p);
  if (!v?.side_data_list) return false;
  return v.side_data_list.some((sd) => {
    const type = String(sd.side_data_type ?? "").toLowerCase();
    const projection = String(sd.projection ?? "").toLowerCase();
    return type.includes("spherical") || projection.includes("equirect");
  });
}

/** Frames per second from `r_frame_rate` ("30000/1001"), or undefined. */
export function frameRate(s: ProbeStream | undefined): number | undefined {
  const raw = s?.r_frame_rate ?? s?.avg_frame_rate;
  if (!raw) return undefined;
  const [num, den] = raw.split("/").map(Number);
  if (!num || !den) return undefined;
  return num / den;
}

/** 10-bit source? Costs bit depth in the browser texture path (PLAN §5.10). */
export const isTenBit = (s: ProbeStream | undefined): boolean =>
  /10le|10be|p010/.test(s?.pix_fmt ?? "");
