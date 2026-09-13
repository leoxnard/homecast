/**
 * Writes a browser-storage download from a worker, for browsers without
 * `createWritable` on the main thread (Safari before 26). A sync access handle
 * only exists in workers; it writes in place, so no swap file is copied on close.
 */
type StorageRequest =
  | { op: "open"; dir: string; name: string; resume: boolean }
  | { op: "write"; data: ArrayBuffer }
  | { op: "close" };

interface SyncHandle {
  write(data: ArrayBuffer | ArrayBufferView, options?: { at?: number }): number;
  getSize(): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

let handle: SyncHandle | undefined;
let position = 0;

self.onmessage = async (event: MessageEvent<StorageRequest>) => {
  const message = event.data;
  try {
    if (message.op === "open") {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(message.dir, { create: true });
      const file = await dir.getFileHandle(message.name, { create: true });
      handle = await (file as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle();
      if (!message.resume) handle.truncate(0);
      position = handle.getSize();
      self.postMessage({ ok: true, offset: position });
    } else if (message.op === "write") {
      if (!handle) throw new Error("not open");
      const bytes = new Uint8Array(message.data);
      let done = 0;
      while (done < bytes.byteLength) {
        const n = handle.write(bytes.subarray(done), { at: position + done });
        if (n <= 0) throw new Error("storage full");
        done += n;
      }
      position += done;
      self.postMessage({ ok: true });
    } else if (message.op === "close") {
      handle?.flush();
      handle?.close();
      handle = undefined;
      self.postMessage({ ok: true });
    }
  } catch (err) {
    self.postMessage({ ok: false, error: (err as Error).message || String(err) });
  }
};
export {};
