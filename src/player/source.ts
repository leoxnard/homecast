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
export function fromDataTransfer(dt: DataTransfer): OpenedVideo | undefined {
  const file = Array.from(dt.files).find((f) => f.type.startsWith("video/") || /\.(mp4|m4v|mov)$/i.test(f.name));
  return file ? { name: file.name, size: file.size, url: URL.createObjectURL(file), file } : undefined;
}

export function revoke(video: OpenedVideo | undefined): void {
  if (video) URL.revokeObjectURL(video.url);
}
