/**
 * The library store (PLAN §4.3, M3).
 *
 * `FileSystemFileHandle`s are structured-cloneable, so IndexedDB can hold a
 * durable reference to a file on disk. One click then reopens an 87 GB master
 * without re-picking it — and without the file ever being copied or uploaded.
 */
import type { Chapter } from "../shared/chapters.ts";
import type { SharedLink } from "./share/share-panel.ts";

const DB_NAME = "homecast";
const DB_VERSION = 1;
const STORE = "videos";

export interface LibraryEntry {
  /** stable across sessions: name + size + mtime, so re-picking the same file matches */
  id: string;
  name: string;
  size: number;
  lastModified: number;
  /** absent when the file came from a plain <input> or a drop — those cannot be reopened */
  handle?: FileSystemFileHandle;
  duration?: number;
  width?: number;
  height?: number;
  thumbnail?: Blob;
  /** 2 = read through WebGL; older ones may be black on Safari and are redone */
  thumbnailVersion?: number;
  /** seconds — where to pick up again */
  resumeAt?: number;
  chapters: Chapter[];
  title?: string;
  artist?: string;
  /** download link for this file (Pingvin, Drive, …) shown to people in a room */
  shareUrl?: string;
  /** relay download path once uploaded to Pingvin through homecast */
  relayPath?: string;
  /** links made from "Share video", newest first */
  shares?: SharedLink[];
  addedAt: number;
  lastOpenedAt: number;
}

export function entryId(file: { name: string; size: number; lastModified: number }): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

let dbPromise: Promise<IDBDatabase> | undefined;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" }).createIndex("lastOpenedAt", "lastOpenedAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("could not open IndexedDB"));
  });
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return request(fn(db.transaction(STORE, mode).objectStore(STORE)));
}

export async function listEntries(): Promise<LibraryEntry[]> {
  const all = await tx<LibraryEntry[]>("readonly", (s) => s.getAll() as IDBRequest<LibraryEntry[]>);
  return all.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

export const getEntry = (id: string): Promise<LibraryEntry | undefined> =>
  tx("readonly", (s) => s.get(id) as IDBRequest<LibraryEntry | undefined>);

export const putEntry = (entry: LibraryEntry): Promise<IDBValidKey> =>
  tx("readwrite", (s) => s.put(entry));

export const deleteEntry = (id: string): Promise<undefined> =>
  tx("readwrite", (s) => s.delete(id) as IDBRequest<undefined>);

/** Merge fields into an existing entry; a no-op if it is not in the library. */
export async function patchEntry(id: string, patch: Partial<LibraryEntry>): Promise<void> {
  const existing = await getEntry(id);
  if (!existing) return;
  await putEntry({ ...existing, ...patch });
}

// ---------------------------------------------------------------------------
// Permissions (M3: the re-permission flow on return visits)
// ---------------------------------------------------------------------------

export type HandleAccess = "granted" | "prompt" | "denied" | "unsupported";

export async function queryAccess(handle: FileSystemFileHandle): Promise<HandleAccess> {
  if (!handle.queryPermission) return "unsupported";
  try {
    return (await handle.queryPermission({ mode: "read" })) as HandleAccess;
  } catch {
    return "denied";
  }
}

/** Must be called from a user gesture, or the browser rejects it outright. */
export async function requestAccess(handle: FileSystemFileHandle): Promise<boolean> {
  if (!handle.requestPermission) return true;
  try {
    return (await handle.requestPermission({ mode: "read" })) === "granted";
  } catch {
    return false;
  }
}
