import {
  probe, videoStream, audioStreams, hasSphericalMetadata, frameRate, isTenBit,
  type ProbeResult,
} from "./ffmpeg.ts";
import { formatBytes, formatDuration } from "./disk.ts";
import { bold, dim, green, yellow, table, warn, info } from "./log.ts";

/** Full HEVC codec string for a real `canPlayType` probe (PLAN §5.3). */
export function codecString(p: ProbeResult): string | undefined {
  const v = videoStream(p);
  if (!v || v.codec_name !== "hevc") return undefined;
  // e.g. Main 10 / level 6.0 -> hvc1.2.4.L180.B0
  const profileIdc = v.profile === "Main 10" ? 2 : 1;
  const level = v.level ?? 180;
  const tag = v.codec_tag_string === "hev1" ? "hev1" : "hvc1";
  return `${tag}.${profileIdc}.4.L${level}.B0`;
}

/** Degrees of equirect covered per horizontal pixel (PLAN §5.1). */
export function pixelsPerDegree(width: number): number {
  return width / 360;
}

export async function inspect(file: string): Promise<ProbeResult> {
  const p = await probe(file);
  const v = videoStream(p);
  const audio = audioStreams(p);
  const durationSec = Number(p.format.duration ?? 0);
  const sizeBytes = Number(p.format.size ?? 0);

  console.log(bold(p.format.filename));
  const rows: Array<[string, string]> = [
    ["size", `${formatBytes(sizeBytes)} (${sizeBytes.toLocaleString()} bytes)`],
    ["duration", `${formatDuration(durationSec)} (${durationSec.toFixed(1)} s)`],
    ["container", p.format.format_name ?? "?"],
  ];

  if (v) {
    const fps = frameRate(v);
    const aspect = v.width && v.height ? v.width / v.height : 0;
    rows.push(
      ["video", `${v.codec_name} ${v.profile ?? ""} level ${v.level ?? "?"} [${v.codec_tag_string}]`.trim()],
      ["resolution", `${v.width}×${v.height}${aspect === 2 ? dim(" (2:1 equirect ✓)") : yellow(` (${aspect.toFixed(2)}:1 — equirect must be 2:1, §5.7)`)}`],
      ["pix_fmt", `${v.pix_fmt}${isTenBit(v) ? yellow(" — 10-bit; the browser texture path is 8-bit (§5.10)") : ""}`],
      ["frame rate", fps ? `${fps.toFixed(3)} fps` : "?"],
    );
    if (v.bit_rate) rows.push(["video bitrate", `${(Number(v.bit_rate) / 1e6).toFixed(1)} Mbps`]);
    if (v.width) {
      const ppd = pixelsPerDegree(v.width);
      rows.push(["angular res", `${ppd.toFixed(1)} px/° → ${Math.round(ppd * 90)} px across a 90° view (§5.1)`]);
    }
  }

  for (const a of audio) {
    rows.push([
      `audio #${a.index}`,
      `${a.codec_name} ${a.channel_layout ?? `${a.channels}ch`} ${a.sample_rate} Hz` +
        (a.bit_rate ? ` ${Math.round(Number(a.bit_rate) / 1000)} kbps` : "") +
        (a.tags?.title ? dim(` "${a.tags.title}"`) : ""),
    ]);
  }

  rows.push(["chapters", p.chapters.length ? String(p.chapters.length) : dim("none")]);
  rows.push([
    "spherical",
    hasSphericalMetadata(p)
      ? green("equirectangular side data present")
      : yellow("MISSING — the player will not know this is 360° (§5.8)"),
  ]);

  const codec = codecString(p);
  if (codec) rows.push(["codec string", `video/mp4; codecs="${codec}"`]);

  table(rows);

  if (p.chapters.length) {
    info("");
    info(dim("  chapters:"));
    for (const ch of p.chapters) {
      const start = Number(ch.start_time);
      console.log(`    ${dim(formatDuration(start).padStart(8))}  ${ch.tags?.title ?? "(untitled)"}`);
    }
  }

  if (audio.length === 1 && (audio[0]?.channels ?? 0) <= 2 && Number(audio[0]?.bit_rate ?? 0) < 200_000) {
    info("");
    warn(`single low-bitrate stereo track — PLAN §7.3 flags this as the weakest link in the chain`);
  }

  // Chrome does not implement HTMLMediaElement.audioTracks, so the web player
  // always gets the FIRST audio track and cannot switch. VLC can. Order matters.
  if (audio.length > 1) {
    const first = audio[0];
    info("");
    warn(
      `${audio.length} audio tracks — the browser plays only the first ` +
        `(${first?.codec_name}${first?.tags?.title ? ` "${first.tags.title}"` : ""}) and cannot switch; ` +
        `VLC can. Put the preferred default first.`,
    );
  }
  return p;
}
