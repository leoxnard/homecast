/**
 * Minimal MP4 box surgery — just enough to put spherical-video metadata back
 * into a file after ffmpeg has dropped it.
 *
 * Why this exists: PLAN §5.8 assumed `-c copy` preserves the equirectangular
 * side data and told us to verify. It does NOT. ffmpeg's mov *de*muxer reads
 * the box, and ffprobe reports `Spherical Mapping`, but the mov *muxer* has no
 * code to write it back, so every remux silently loses it. See docs/findings.md.
 */
import { open, stat } from "node:fs/promises";

export interface Box {
  type: string;
  /** offset of the box header, relative to the buffer it was parsed from */
  start: number;
  /** total size including the header */
  size: number;
  headerSize: number;
}

/** Boxes whose payload is a plain list of child boxes. */
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "udta", "mvex"]);
/** Visual sample entries carry 78 bytes of fixed fields before their children. */
const VISUAL_SAMPLE_ENTRIES = new Set(["hvc1", "hev1", "avc1", "avc3", "av01", "vp09", "mp4v"]);

export function parseBoxes(buf: Buffer, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let o = start;
  while (o + 8 <= end) {
    let size = buf.readUInt32BE(o);
    let headerSize = 8;
    if (size === 1) {
      if (o + 16 > end) break;
      size = Number(buf.readBigUInt64BE(o + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - o; // extends to the end of the enclosing box
    }
    if (size < headerSize || o + size > end) break;
    boxes.push({ type: buf.toString("latin1", o + 4, o + 8), start: o, size, headerSize });
    o += size;
  }
  return boxes;
}

/** Where a box's children begin, or -1 if it has none. */
function childrenStart(box: Box): number {
  if (CONTAINERS.has(box.type)) return box.start + box.headerSize;
  if (box.type === "stsd") return box.start + box.headerSize + 8; // version/flags + entry_count
  if (VISUAL_SAMPLE_ENTRIES.has(box.type)) return box.start + box.headerSize + 78;
  return -1;
}

export function childrenOf(buf: Buffer, box: Box): Box[] {
  const start = childrenStart(box);
  if (start < 0) return [];
  return parseBoxes(buf, start, box.start + box.size);
}

const find = (boxes: Box[], type: string): Box | undefined => boxes.find((b) => b.type === type);

/**
 * Ancestor chain down to the video track's sample entry:
 * [moov, trak, mdia, minf, stbl, stsd, hvc1].
 * `moovBuf` must be the complete moov box, header included, starting at offset 0.
 */
export function videoSampleEntryChain(moovBuf: Buffer): Box[] | undefined {
  const [moov] = parseBoxes(moovBuf, 0, moovBuf.length);
  if (!moov || moov.type !== "moov") return undefined;

  for (const trak of childrenOf(moovBuf, moov).filter((b) => b.type === "trak")) {
    const mdia = find(childrenOf(moovBuf, trak), "mdia");
    if (!mdia) continue;
    const mdiaKids = childrenOf(moovBuf, mdia);

    // hdlr: version/flags(4) + pre_defined(4) + handler_type(4)
    const hdlr = find(mdiaKids, "hdlr");
    if (!hdlr) continue;
    const handler = moovBuf.toString("latin1", hdlr.start + hdlr.headerSize + 8, hdlr.start + hdlr.headerSize + 12);
    if (handler !== "vide") continue;

    const minf = find(mdiaKids, "minf");
    if (!minf) continue;
    const stbl = find(childrenOf(moovBuf, minf), "stbl");
    if (!stbl) continue;
    const stsd = find(childrenOf(moovBuf, stbl), "stsd");
    if (!stsd) continue;
    const entry = childrenOf(moovBuf, stsd).find((b) => VISUAL_SAMPLE_ENTRIES.has(b.type));
    if (!entry) continue;

    return [moov, trak, mdia, minf, stbl, stsd, entry];
  }
  return undefined;
}

/** Direct children of the video sample entry (hvcC, colr, pasp, vexu, sv3d, …). */
export function sampleEntryChildren(moovBuf: Buffer): Box[] {
  const chain = videoSampleEntryChain(moovBuf);
  const entry = chain?.at(-1);
  return entry ? childrenOf(moovBuf, entry) : [];
}

/**
 * Insert `payload` as the last child of the video sample entry, growing every
 * ancestor's size field. Returns a new buffer; the original is untouched.
 */
export function injectIntoSampleEntry(moovBuf: Buffer, payload: Buffer): Buffer {
  const chain = videoSampleEntryChain(moovBuf);
  if (!chain) throw new Error("no video sample entry found in moov");
  const entry = chain[chain.length - 1]!;
  const insertAt = entry.start + entry.size;

  const out = Buffer.concat([moovBuf.subarray(0, insertAt), payload, moovBuf.subarray(insertAt)]);

  // Every box in the chain starts before the insertion point, so their header
  // offsets are unchanged and only the size fields need growing.
  for (const box of chain) {
    if (box.headerSize === 16) {
      out.writeBigUInt64BE(BigInt(box.size + payload.length), box.start + 8);
    } else {
      const grown = box.size + payload.length;
      if (grown > 0xffffffff) throw new Error(`box ${box.type} would exceed the 32-bit size field`);
      out.writeUInt32BE(grown, box.start);
    }
  }
  return out;
}

export interface TopLevelBox extends Box {}

/** Top-level boxes, read with seeks rather than by loading the file. */
export async function readTopLevelBoxes(path: string): Promise<TopLevelBox[]> {
  const { size } = await stat(path);
  const fh = await open(path, "r");
  try {
    const boxes: TopLevelBox[] = [];
    let o = 0;
    const header = Buffer.alloc(16);
    while (o + 8 <= size) {
      const { bytesRead } = await fh.read(header, 0, 16, o);
      if (bytesRead < 8) break;
      let boxSize = header.readUInt32BE(0);
      let headerSize = 8;
      if (boxSize === 1) {
        if (bytesRead < 16) break;
        boxSize = Number(header.readBigUInt64BE(8));
        headerSize = 16;
      } else if (boxSize === 0) {
        boxSize = size - o;
      }
      if (boxSize < headerSize) break;
      boxes.push({ type: header.toString("latin1", 4, 8), start: o, size: boxSize, headerSize });
      o += boxSize;
    }
    return boxes;
  } finally {
    await fh.close();
  }
}

export async function readBox(path: string, box: Box): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(box.size);
    await fh.read(buf, 0, box.size, box.start);
    return buf;
  } finally {
    await fh.close();
  }
}

/**
 * Replace the file's moov with `newMoov`.
 *
 * Only valid when moov is the LAST top-level box — which is what ffmpeg writes
 * unless `+faststart` is used. Then growing moov cannot move `mdat`, so every
 * chunk offset in stco/co64 stays correct and the rewrite touches only the tail.
 */
export async function replaceTrailingMoov(path: string, moov: Box, newMoov: Buffer): Promise<void> {
  const boxes = await readTopLevelBoxes(path);
  const last = boxes[boxes.length - 1];
  if (!last || last.type !== "moov" || last.start !== moov.start) {
    throw new Error(
      "moov is not the last box in this file — growing it would shift mdat and invalidate every " +
        "chunk offset. Re-mux without -movflags +faststart and try again.",
    );
  }
  const fh = await open(path, "r+");
  try {
    await fh.write(newMoov, 0, newMoov.length, moov.start);
    await fh.truncate(moov.start + newMoov.length);
  } finally {
    await fh.close();
  }
}
