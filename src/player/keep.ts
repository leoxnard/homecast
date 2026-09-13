/**
 * Keeping videos available on later visits.
 *
 * Chrome and Edge hand out file handles, which the library stores: the video
 * stays where it is on disk and one click reopens it. Safari has no handles —
 * a file picked there is gone as soon as the tab closes — so the only way the
 * video is still there next month is a copy in the browser's own storage.
 * That copy is made in the background after opening, when it fits.
 *
 * Browsers may still clear site storage: Chrome under disk pressure, Safari
 * after weeks without a visit. `navigator.storage.persist()` asks them not to;
 * Safari only honours it reliably for sites added to the Dock / Home Screen.
 */
import {
  checkBrowserStorage, deleteFromBrowserStorage, findInBrowserStorage, openBrowserStorageSink,
  partialInBrowserStorage,
} from "./transfer/sinks.ts";

/** Handles can't be stored by this browser, so keeping a video means copying it. */
export const needsCopyToKeep = (): boolean => !("showOpenFilePicker" in window);

export async function requestPersistence(): Promise<boolean> {
  try {
    if (await navigator.storage.persisted?.()) return true;
    return (await navigator.storage.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export async function isPersisted(): Promise<boolean> {
  try {
    return (await navigator.storage.persisted?.()) ?? false;
  } catch {
    return false;
  }
}

export const keptCopy = (name: string, size: number): Promise<File | undefined> => findInBrowserStorage(name, size);

export const forgetCopy = (name: string): Promise<void> => deleteFromBrowserStorage(name);

export type KeepResult = "kept" | "already" | "too-big" | "cancelled" | "failed";

const SLICE = 8 * 1024 * 1024;

/**
 * Copy `file` into browser storage, continuing a copy an earlier visit left
 * unfinished. Progress is 0..1.
 */
export async function keepOnDevice(
  file: File,
  onProgress: (progress: number) => void,
  signal: AbortSignal,
): Promise<KeepResult> {
  if (await keptCopy(file.name, file.size)) return "already";
  let partial = await partialInBrowserStorage(file.name);
  if (partial > file.size) {
    await forgetCopy(file.name);
    partial = 0;
  }
  if (!(await checkBrowserStorage(file.size, partial)).ok) return "too-big";
  void requestPersistence();

  const sink = await openBrowserStorageSink(file.name, partial > 0); 
  let position = sink.offset;
  try {
    while (position < file.size) {
      if (signal.aborted) {
        await sink.abort(); // keeps what was copied, for next time
        return "cancelled";
      }
      const chunk = await file.slice(position, Math.min(position + SLICE, file.size)).arrayBuffer();
      const length = chunk.byteLength; // the worker sink takes the buffer over, leaving it empty
      if (length === 0) throw new Error("read nothing"); // never loop without progress
      await sink.write(chunk);
      position += length;
      onProgress(position / file.size);
    }
    const { file: copy } = await sink.close();
    if (copy.size !== file.size) {
      await forgetCopy(file.name);
      return "failed";
    }
    return "kept";
  } catch {
    await sink.abort().catch(() => {});
    return "failed";
  }
}
