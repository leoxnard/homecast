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
  if (!("createWritable" in handle)) return workerSink(name, handle, resume);
  const existing = resume ? (await handle.getFile()).size : 0;
  return streamSink("browser-storage", handle, existing);
}

interface StorageWorker {
  offset: number;
  write(data: ArrayBuffer, at?: number): Promise<void>;
  close(): Promise<void>;
}

/** A worker holding a sync access handle on `dir/name` (see opfs-worker.ts). */
async function storageWorker(dir: string, name: string, resume: boolean): Promise<StorageWorker> {
  const worker = new Worker(new URL("./opfs-worker.ts", import.meta.url), { type: "module" });
  // One request at a time; callers already chain their writes.
  let queue: Promise<unknown> = Promise.resolve();
  const call = <T>(message: unknown, transfer: Transferable[] = []): Promise<T> => {
    const next = queue.then(
      () =>
        new Promise<T>((resolve, reject) => {
          worker.onmessage = (e: MessageEvent<{ ok: boolean; error?: string } & T>) =>
            e.data.ok ? resolve(e.data) : reject(new Error(e.data.error));
          worker.onerror = (e) => reject(new Error(e.message || "storage worker failed"));
          worker.postMessage(message, transfer);
        }),
    );
    queue = next.catch(() => {});
    return next;
  };
  let offset: number;
  try {
    ({ offset } = await call<{ offset: number }>({ op: "open", dir, name, resume }));
  } catch (err) {
    worker.terminate();
    throw err;
  }
  let closed = false;
  return {
    offset,
    write: (data, at) => call({ op: "write", data, at }, [data]),
    async close() {
      if (closed) return;
      closed = true;
      await call({ op: "close" }).catch(() => {});
      worker.terminate();
    },
  };
}

/** Safari before 26 has no `createWritable`; write through a worker's sync handle. */
async function workerSink(name: string, handle: FileSystemFileHandle, resume: boolean): Promise<Sink> {
  const w = await storageWorker(OPFS_DIR, safeFileName(name), resume);
  let finished = false;
  return {
    kind: "browser-storage",
    offset: w.offset,
    write: (chunk) => w.write(chunk),
    async close() {
      finished = true;
      await w.close();
      return { file: await handle.getFile(), handle };
    },
    async abort() {
      if (finished) return;
      finished = true;
      await w.close();
    },
  };
}

// --- scratch files: temporary output that is written out of order -------------

const SCRATCH_DIR = "homecast-scratch";

export interface ScratchFile {
  /** write at an absolute byte position (an MP4 writer patches its header last) */
  writeAt(data: Uint8Array, position: number): Promise<void>;
  close(): Promise<File>;
  abort(): Promise<void>;
}

export async function openScratchFile(name: string): Promise<ScratchFile> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(SCRATCH_DIR, { create: true });
  const fileName = safeFileName(name);
  const handle = await dir.getFileHandle(fileName, { create: true });
  const hasWritable = typeof (handle as { createWritable?: unknown }).createWritable === "function";
  if (hasWritable) {
    const writable = await (handle as unknown as {
      createWritable: () => Promise<FileSystemWritableFileStream>;
    }).createWritable();
    return {
      writeAt: (data, position) => writable.write({ type: "write", position, data: data as Uint8Array<ArrayBuffer> }),
      async close() {
        await writable.close();
        return handle.getFile();
      },
      async abort() {
        await writable.abort().catch(() => {});
        await dir.removeEntry(fileName).catch(() => {});
      },
    };
  }
  const w = await storageWorker(SCRATCH_DIR, fileName, false);
  return {
    // Copy: the buffer is transferred to the worker, and the caller may still hold it.
    writeAt: (data, position) => w.write(data.slice().buffer, position),
    async close() {
      await w.close();
      return handle.getFile();
    },
    async abort() {
      await w.close();
      await dir.removeEntry(fileName).catch(() => {});
    },
  };
}

export async function deleteScratchFile(name: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(SCRATCH_DIR);
    await dir.removeEntry(safeFileName(name));
  } catch {
    /* already gone */
  }
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
