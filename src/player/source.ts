/**
 * Opening a local video file. Nothing is ever uploaded — the file stays on the
 * viewer's own machine (PLAN §1, §4.2).
 *
 * M3 will persist the FileSystemFileHandle in IndexedDB; for M2 we only need
 * to get a playable URL and remember enough to report it.
 */

export interface OpenedVideo {
  name: string;
  size: number;
  url: string;
  file: File;
  /** present when the File System Access API was used — M3 will persist this */
  handle?: FileSystemFileHandle;
  /** library id to keep, when this is a stored copy of a file first opened elsewhere */
  entryId?: string;
}

const VIDEO_TYPES: FilePickerAcceptType[] = [
  { description: "360° video", accept: { "video/mp4": [".mp4", ".m4v", ".mov"] } },
];

export async function pickVideo(): Promise<OpenedVideo | undefined> {
  if ("showOpenFilePicker" in window) {
    try {
      const [handle] = await window.showOpenFilePicker({ types: VIDEO_TYPES, multiple: false });
      if (!handle) return undefined;
      const file = await handle.getFile();
      return { name: file.name, size: file.size, url: URL.createObjectURL(file), file, handle };
    } catch (e) {
      if ((e as DOMException).name === "AbortError") return undefined;
      throw e;
    }
  }
  return pickWithInput();
}

function pickWithInput(): Promise<OpenedVideo | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "video/mp4,video/quicktime,video/*";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      resolve(file ? { name: file.name, size: file.size, url: URL.createObjectURL(file), file } : undefined);
    });
    input.addEventListener("cancel", () => resolve(undefined));
    input.click();
  });
}

/** Accept a file dropped onto the page. */
const isVideo = (f: File) => f.type.startsWith("video/") || /\.(mp4|m4v|mov)$/i.test(f.name);

/**
 * A dropped video. Chrome and Edge can turn a drop into a file handle, which
 * lets the library reopen it later like a picked file. The handle request must
 * start synchronously inside the drop event, before the data transfer expires.
 */
export async function fromDataTransfer(dt: DataTransfer): Promise<OpenedVideo | undefined> {
  const items = Array.from(dt.items).filter((i) => i.kind === "file");
  const pending = items.map((item) => ({
    file: item.getAsFile(),
    handle: (item as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> })
      .getAsFileSystemHandle?.()
      .catch(() => null),
  }));
  for (const { file, handle } of pending) {
    if (!file || !isVideo(file)) continue;
    const h = await handle;
    const fileHandle = h && h.kind === "file" ? (h as FileSystemFileHandle) : undefined;
    return { name: file.name, size: file.size, url: URL.createObjectURL(file), file, handle: fileHandle };
  }
  const file = Array.from(dt.files).find(isVideo);
  return file ? { name: file.name, size: file.size, url: URL.createObjectURL(file), file } : undefined;
}

export function revoke(video: OpenedVideo | undefined): void {
  if (video) URL.revokeObjectURL(video.url);
}
