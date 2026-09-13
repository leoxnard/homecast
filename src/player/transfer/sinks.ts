/**
 * Where a received video is written.
 *
 * The file must go to disk as it arrives — an 88 GB master cannot be held in
 * memory — and the page must be able to open it afterwards without the user
 * finding it in a Downloads folder.
 *
 *  - Disk (Chrome, Edge): a real file the user picks. No quota, and VLC can
 *    open it later. Needs a click to show the save dialog.
 *  - Browser storage (Safari, and Chrome as a fallback): the origin-private
 *    file system. No dialog, but bounded by the origin quota — Safari measured
 *    82.5 GB on a Mac with ~116 GB free, which is *less* than the HQ master.
 */

export interface Sink {
  readonly kind: "disk" | "browser-storage";
  /** bytes already present — non-zero when resuming */
  readonly offset: number;
  write(chunk: ArrayBuffer): Promise<void>;
  /** finish and hand back a playable File, plus a handle when it can be reopened */
  close(): Promise<{ file: File; handle?: FileSystemFileHandle }>;
  abort(): Promise<void>;
}

export const canSaveToDisk = (): boolean => "showSaveFilePicker" in window;
export const canUseBrowserStorage = (): boolean =>
  typeof navigator.storage?.getDirectory === "function";

export interface StorageCheck {
  ok: boolean;
  availableBytes: number;
}

/** Will a file of `size` bytes fit in this origin's browser storage? */
export async function checkBrowserStorage(size: number, alreadyStored = 0): Promise<StorageCheck> {
  try {
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    const availableBytes = Math.max(0, quota - usage);
    const needed = size - alreadyStored;
    // Headroom: writing right up to the quota fails at the very end.
    return { ok: availableBytes > needed + Math.max(size * 0.02, 500e6), availableBytes };
  } catch {
    return { ok: false, availableBytes: 0 };
  }
}

/** Remove anything that could escape or break a file name; keep it recognisable. */
export function safeFileName(name: string): string {
  let out = "";
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 32 || '\\/:*?"<>|'.includes(ch) ? "_" : ch;
  }
  out = out.replace(/^\.+/, "").slice(0, 180);
  return out || "homecast-video.mp4";
}

// --- Chrome / Edge: a real file ---------------------------------------------

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}

/** Must be called from a click — the save dialog needs a user gesture. */
export async function openDiskSink(name: string): Promise<Sink> {
  const picker = (window as unknown as {
    showSaveFilePicker: (o: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
  }).showSaveFilePicker;
  const handle = await picker({
    suggestedName: safeFileName(name),
    types: [{ description: "Video", accept: { "video/mp4": [".mp4", ".m4v", ".mov"] } }],
  });
  return streamSink("disk", handle, 0);
}

// --- Safari (and fallback): browser-private storage --------------------------

const OPFS_DIR = "homecast-received";

async function opfsHandle(name: string, create: boolean): Promise<FileSystemFileHandle> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
  return dir.getFileHandle(safeFileName(name), { create });
}

/**
 * Open a file in browser storage. When `resume` is set and a partial copy from
 * an interrupted transfer exists, writing continues from its end.
 */
export async function openBrowserStorageSink(name: string, resume: boolean): Promise<Sink> {
  // Ask the browser not to evict a very large file under storage pressure.
  void navigator.storage.persist?.().catch(() => false);
  const handle = await opfsHandle(name, true);
  const existing = resume ? (await handle.getFile()).size : 0;
  return streamSink("browser-storage", handle, existing);
}

/** A fully received copy already in browser storage, if any. */
export async function findInBrowserStorage(name: string, size: number): Promise<File | undefined> {
  if (!canUseBrowserStorage()) return undefined;
  try {
    const file = await (await opfsHandle(name, false)).getFile();
    return file.size === size ? file : undefined;
  } catch {
    return undefined;
  }
}

/** Bytes of a partial copy in browser storage, for resuming. */
export async function partialInBrowserStorage(name: string): Promise<number> {
  if (!canUseBrowserStorage()) return 0;
  try {
    return (await (await opfsHandle(name, false)).getFile()).size;
  } catch {
    return 0;
  }
}

export async function deleteFromBrowserStorage(name: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OPFS_DIR);
    await dir.removeEntry(safeFileName(name));
  } catch {
    /* nothing to remove */
  }
}

// --- shared writable-stream implementation -----------------------------------

async function streamSink(
  kind: Sink["kind"],
  handle: FileSystemFileHandle,
  offset: number,
): Promise<Sink> {
  const writable = await (handle as unknown as {
    createWritable: (o?: { keepExistingData?: boolean }) => Promise<FileSystemWritableFileStream>;
  }).createWritable({ keepExistingData: offset > 0 });
  if (offset > 0) await writable.seek(offset);

  let finished = false;
  return {
    kind,
    offset,
    write: (chunk) => writable.write(chunk),
    async close() {
      finished = true;
      await writable.close();
      return { file: await handle.getFile(), handle };
    },
    async abort() {
      if (finished) return;
      finished = true;
      // Close rather than abort so a partial browser-storage copy survives for resuming.
      await writable.close().catch(() => writable.abort().catch(() => {}));
    },
  };
}
