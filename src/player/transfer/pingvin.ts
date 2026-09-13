/**
 * Browser side of the optional Pingvin relay (server/pingvin.ts).
 *
 * Upload once from the host, then anyone can download without the host being
 * online. Both directions survive interruptions: Pingvin reports which chunk it
 * expects next, and the relay honours Range for downloads.
 */
import type { Sink } from "./sinks.ts";

export interface PingvinStatus {
  enabled: boolean;
  maxSize?: number;
  chunkSize?: number;
}

export async function pingvinStatus(): Promise<PingvinStatus> {
  try {
    const res = await fetch("/api/pingvin/status", { cache: "no-store" });
    return res.ok ? ((await res.json()) as PingvinStatus) : { enabled: false };
  } catch {
    return { enabled: false };
  }
}

const KEY_STORAGE = "homecast-upload-key";

export function storedUploadKey(): string | undefined {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? undefined;
  } catch {
    return undefined;
  }
}

export function storeUploadKey(key: string | undefined): void {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* storage blocked: the key is asked for again next time */
  }
}

export class UploadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface UploadProgress {
  sent: number;
  size: number;
  bytesPerSecond: number;
}

export interface UploadResult {
  shareId: string;
  fileId: string;
  /** same-origin relay path a friend downloads from */
  downloadPath: string;
}

async function call(path: string, key: string, init: RequestInit): Promise<Response> {
  return fetch(path, { ...init, headers: { ...(init.headers as Record<string, string>), "x-homecast-key": key } });
}

/**
 * Upload `file` through the relay. Chunks are retried with backoff; when
 * Pingvin says it expects a different chunk (a retry of one that had in fact
 * arrived), the upload continues from the index it names.
 */
export async function uploadToPingvin(
  file: File,
  key: string,
  onProgress: (p: UploadProgress) => void,
  signal: AbortSignal,
): Promise<UploadResult> {
  const created = await call("/api/pingvin/shares", key, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: file.name, size: file.size }),
    signal,
  });
  const createdBody = (await created.json().catch(() => ({}))) as { shareId?: string; chunkSize?: number; error?: string };
  if (!created.ok || !createdBody.shareId) {
    throw new UploadError(created.status, createdBody.error ?? `could not create the share (${created.status})`);
  }
  const shareId = createdBody.shareId;
  // Stay a little under Pingvin's limit; its body parser counts bytes exactly.
  const chunkSize = Math.max(1_000_000, (createdBody.chunkSize ?? 10_000_000) - 1024);
  const total = Math.ceil(file.size / chunkSize);

  let fileId: string | undefined;
  let index = 0;
  const started = performance.now();

  while (index < total) {
    if (signal.aborted) throw new UploadError(0, "cancelled");
    const start = index * chunkSize;
    const body = file.slice(start, Math.min(start + chunkSize, file.size));
    const q = new URLSearchParams({ index: String(index), total: String(total), name: file.name });
    if (fileId) q.set("fileId", fileId);

    let attempt = 0;
    for (;;) {
      try {
        const res = await call(`/api/pingvin/shares/${shareId}/chunks?${q}`, key, {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body,
          signal,
        });
        const out = (await res.json().catch(() => ({}))) as { fileId?: string; error?: string; expectedChunkIndex?: number };
        if (res.ok) {
          fileId = out.fileId ?? fileId;
          index++;
          break;
        }
        if (res.status === 409 && typeof out.expectedChunkIndex === "number" && out.expectedChunkIndex > index) {
          index = out.expectedChunkIndex; // it had arrived; carry on from where Pingvin is
          break;
        }
        if (res.status === 401 || res.status === 413) throw new UploadError(res.status, out.error ?? "refused");
        throw new UploadError(res.status, out.error ?? `chunk ${index} failed (${res.status})`);
      } catch (err) {
        if (signal.aborted) throw new UploadError(0, "cancelled");
        if (err instanceof UploadError && (err.status === 401 || err.status === 413)) throw err;
        if (++attempt > 5) throw err instanceof Error ? err : new UploadError(0, String(err));
        await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempt)));
      }
    }

    const sent = Math.min(index * chunkSize, file.size);
    const elapsed = (performance.now() - started) / 1000;
    onProgress({ sent, size: file.size, bytesPerSecond: elapsed > 0.5 ? sent / elapsed : 0 });
  }

  if (!fileId) throw new UploadError(0, "Pingvin never returned a file id");
  const done = await call(`/api/pingvin/shares/${shareId}/complete`, key, { method: "POST", signal });
  if (!done.ok) {
    const out = (await done.json().catch(() => ({}))) as { error?: string };
    throw new UploadError(done.status, out.error ?? "could not complete the share");
  }
  return { shareId, fileId, downloadPath: `/api/pingvin/download/${shareId}/${fileId}` };
}

export interface DownloadProgress {
  received: number;
  size: number;
  bytesPerSecond: number;
}

/**
 * Download from the relay into `sink`, continuing from `sink.offset`. Resolves
 * with the finished file; rejects with the byte count kept if interrupted.
 */
export async function downloadFromRelay(
  path: string,
  size: number,
  sink: Sink,
  onProgress: (p: DownloadProgress) => void,
  signal: AbortSignal,
): Promise<{ file: File; handle?: FileSystemFileHandle }> {
  const headers: Record<string, string> = {};
  if (sink.offset > 0) headers.range = `bytes=${sink.offset}-`;
  const res = await fetch(path, { headers, signal, cache: "no-store" });
  if (!(res.ok || res.status === 206) || !res.body) {
    await sink.abort();
    throw new Error(res.status === 404 ? "the shared video is gone or expired" : `download failed (${res.status})`);
  }
  if (sink.offset > 0 && res.status !== 206) {
    await sink.abort();
    throw new Error("the server restarted the file from the beginning; try again");
  }

  let received = sink.offset;
  const samples: Array<{ t: number; b: number }> = [{ t: performance.now(), b: received }];
  let lastEmit = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await sink.write(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      received += value.byteLength;
      const now = performance.now();
      samples.push({ t: now, b: received });
      while (samples.length > 2 && now - (samples[0]?.t ?? now) > 5000) samples.shift();
      if (now - lastEmit > 250) {
        lastEmit = now;
        const first = samples[0];
        const dt = first ? (now - first.t) / 1000 : 0;
        onProgress({ received, size, bytesPerSecond: first && dt > 0.5 ? (received - first.b) / dt : 0 });
      }
    }
  } catch (err) {
    await sink.abort();
    throw Object.assign(new Error((err as Error).name === "AbortError" ? "cancelled" : "connection lost"), { received });
  }
  if (received !== size) {
    await sink.abort();
    throw Object.assign(new Error(`stream ended at ${received} of ${size} bytes`), { received });
  }
  return sink.close();
}
