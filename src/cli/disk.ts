import { statfs, stat } from "node:fs/promises";
import { dirname } from "node:path";

export interface SpaceCheck {
  inputBytes: number;
  freeBytes: number;
  requiredBytes: number;
  ok: boolean;
}

/**
 * PLAN §3.6: `-c copy` writes a *new* file, so a remux needs the input's size
 * again. Refuse below 2× input — the plan's guard, and the reason the 87 GB
 * master cannot currently be remuxed in place.
 */
export async function checkFreeSpace(input: string, outputDir: string, factor = 2): Promise<SpaceCheck> {
  const { size } = await stat(input);
  const fs = await statfs(dirname(outputDir) === outputDir ? outputDir : outputDir);
  const freeBytes = fs.bavail * fs.bsize;
  const requiredBytes = Math.ceil(size * factor);
  return { inputBytes: size, freeBytes, requiredBytes, ok: freeBytes >= requiredBytes };
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v >= 100 || u === 0 ? 0 : 1)} ${units[u]}`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
