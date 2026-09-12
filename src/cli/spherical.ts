/**
 * Spherical-video metadata: preserve it across an ffmpeg remux.
 *
 * CORRECTION to PLAN §5.8 — the plan says the metadata is already in the file and
 * that the only remaining job is to *verify* `-c copy` preserves it. Measured:
 * it does not. ffmpeg reads the box and ffprobe reports `Spherical Mapping`, but
 * the mov muxer never writes one, so every remuxed output loses 360° in VLC and
 * QuickTime. This module puts it back.
 *
 * Two box families exist, and players disagree about which they read:
 *  - `vexu` / `proj` / `prji`  — Apple (QuickTime, iOS 18+). What the Insta360
 *    master actually carries.
 *  - `st3d` + `sv3d`           — Google spatial-media. What VLC 3 and most
 *    other players read.
 * We copy whatever the source had, and can add the Google form as insurance.
 */
import {
  readTopLevelBoxes, readBox, sampleEntryChildren, injectIntoSampleEntry, replaceTrailingMoov,
  type Box,
} from "./mp4.ts";

/** Box types that mean "this is a 360° video". */
const SPHERICAL_BOXES = new Set(["vexu", "sv3d", "st3d"]);

function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, payload]);
}

/** Apple: vexu > proj > prji('equi'). Byte-identical to what the master carries. */
export function appleEquirectBox(): Buffer {
  const prji = box("prji", Buffer.concat([Buffer.alloc(4), Buffer.from("equi", "latin1")]));
  return box("vexu", box("proj", prji));
}

/** Google spatial-media: st3d (monoscopic) + sv3d > svhd/proj > prhd + equi. */
export function googleEquirectBoxes(): Buffer {
  const st3d = box("st3d", Buffer.concat([Buffer.alloc(4), Buffer.from([0])])); // 0 = monoscopic
  const svhd = box("svhd", Buffer.from("homecast\0", "latin1"));
  const prhd = box("prhd", Buffer.alloc(4 + 12)); // version/flags + yaw/pitch/roll = 0
  const equi = box("equi", Buffer.alloc(4 + 16)); // version/flags + bounds = 0 (full sphere)
  const sv3d = box("sv3d", Buffer.concat([svhd, box("proj", Buffer.concat([prhd, equi]))]));
  return Buffer.concat([st3d, sv3d]);
}

export interface SphericalState {
  moov: Box;
  moovBuf: Buffer;
  /** spherical box types already present in the video sample entry */
  present: string[];
  /** those boxes' raw bytes, ready to copy into another file */
  bytes: Buffer;
}

export async function readSphericalState(path: string): Promise<SphericalState | undefined> {
  const top = await readTopLevelBoxes(path);
  const moov = top.find((b) => b.type === "moov");
  if (!moov) return undefined;
  const moovBuf = await readBox(path, moov);
  const kids = sampleEntryChildren(moovBuf);
  const spherical = kids.filter((b) => SPHERICAL_BOXES.has(b.type));
  return {
    moov,
    moovBuf,
    present: spherical.map((b) => b.type),
    bytes: Buffer.concat(spherical.map((b) => moovBuf.subarray(b.start, b.start + b.size))),
  };
}

export interface InjectResult {
  injected: string[];
  alreadyPresent: string[];
  bytesAdded: number;
}

/**
 * Ensure `target` carries spherical metadata, copying `source`'s boxes when it
 * has them and synthesising equirectangular ones when it does not.
 */
export async function ensureSpherical(
  target: string,
  opts: { source?: string; addGoogleForm?: boolean } = {},
): Promise<InjectResult> {
  const state = await readSphericalState(target);
  if (!state) throw new Error(`${target} has no moov box`);

  const wanted: Buffer[] = [];
  const injected: string[] = [];

  const sourceState = opts.source ? await readSphericalState(opts.source) : undefined;
  const copyable = sourceState?.bytes.length ? sourceState : undefined;

  if (copyable) {
    for (const type of copyable.present) {
      if (state.present.includes(type)) continue;
      const kids = sampleEntryChildren(copyable.moovBuf).filter((b) => b.type === type);
      for (const k of kids) {
        wanted.push(copyable.moovBuf.subarray(k.start, k.start + k.size));
        injected.push(type);
      }
    }
  } else if (!state.present.length) {
    wanted.push(appleEquirectBox());
    injected.push("vexu");
  }

  if (opts.addGoogleForm && !state.present.includes("sv3d") && !injected.includes("sv3d")) {
    wanted.push(googleEquirectBoxes());
    injected.push("st3d", "sv3d");
  }

  if (!wanted.length) {
    return { injected: [], alreadyPresent: state.present, bytesAdded: 0 };
  }

  const payload = Buffer.concat(wanted);
  const newMoov = injectIntoSampleEntry(state.moovBuf, payload);
  await replaceTrailingMoov(target, state.moov, newMoov);
  return { injected, alreadyPresent: state.present, bytesAdded: payload.length };
}
