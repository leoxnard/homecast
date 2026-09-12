import { basename, resolve } from "node:path";
import { ensureSpherical, readSphericalState } from "./spherical.ts";
import { probe, hasSphericalMetadata } from "./ffmpeg.ts";
import { bold, dim, green, yellow, ok, warn, table } from "./log.ts";

export interface SphericalOptions {
  file: string;
  source?: string;
  check: boolean;
  googleForm: boolean;
}

export async function spherical(opts: SphericalOptions): Promise<void> {
  const file = resolve(opts.file);
  const before = await readSphericalState(file);
  if (!before) throw new Error(`${basename(file)} has no moov box — is it an MP4?`);

  const describe = (present: string[]) =>
    present.length ? green(present.join(", ")) : yellow("none");

  const rows: Array<[string, string]> = [["boxes in target", describe(before.present)]];
  if (opts.source) {
    const src = await readSphericalState(resolve(opts.source));
    rows.push(["boxes in source", src ? describe(src.present) : yellow("unreadable")]);
  }
  rows.push(["ffprobe sees", hasSphericalMetadata(await probe(file)) ? green("equirectangular") : yellow("nothing")]);
  console.log(bold(basename(file)));
  table(rows);

  if (opts.check) return;
  if (before.present.length && !opts.googleForm) {
    ok("already carries spherical metadata; nothing to do");
    return;
  }

  const result = await ensureSpherical(file, { source: opts.source, addGoogleForm: opts.googleForm });
  if (!result.injected.length) {
    ok("already carries spherical metadata; nothing to do");
    return;
  }

  const after = await probe(file);
  table([
    ["injected", `${result.injected.join(", ")} (+${result.bytesAdded} bytes)`],
    ["ffprobe now sees", hasSphericalMetadata(after) ? green("equirectangular ✓") : yellow("still nothing")],
  ]);
  if (!hasSphericalMetadata(after)) {
    warn("the box was written but ffprobe does not recognise it — inspect the file before trusting it");
    return;
  }
  ok(`${basename(file)} is tagged 360°${dim(" (VLC/QuickTime will now sphere-project it)")}`);
}
