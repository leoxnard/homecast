/**
 * Host → friend video transfer over the room's WebRTC connection.
 *
 * The host offers the file it is playing. A friend who wants it asks for it
 * from a byte offset (zero, or wherever an interrupted copy stopped), the host
 * streams it on the dedicated `file` channel with back-pressure, and the friend
 * writes it straight to disk. No server is involved — the signalling server
 * only ever saw the handshake (PLAN §4.2).
 *
 * Integrity: the channel is ordered and reliable (SCTP), so bytes arrive
 * complete and in order or the channel closes. Completion is decided by the
 * byte count, never by the "file-end" message alone — that travels on the
 * control channel and can arrive before the final data does.
 */
import type { FileIdentity, FileMessage, FileOffer } from "../../shared/protocol.ts";
import type { Room } from "../room.ts";
import type { Sink } from "./sinks.ts";

const sameFile = (a: FileIdentity, b: FileIdentity): boolean =>
  a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

const identity = (f: FileIdentity): FileIdentity => ({
  name: f.name,
  size: f.size,
  lastModified: f.lastModified,
});

/** Read the file in large slices, send in channel-sized chunks. */
const READ_SLICE = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Host side
// ---------------------------------------------------------------------------

export interface SendProgress {
  peer: string;
  sent: number;
  size: number;
}

export class FileSender {
  private readonly room: Room;
  private file?: File;
  private duration?: number;
  /** peer id → token of the transfer currently running for them */
  private readonly active = new Map<string, number>();
  private nextToken = 1;
  onProgress?: (p: SendProgress) => void;
  onFinished?: (peer: string) => void;

  constructor(room: Room) {
    this.room = room;
  }

  get offering(): File | undefined {
    return this.file;
  }

  /** Start (or stop, with undefined) offering a file to everyone in the room. */
  offer(file: File | undefined, duration?: number): void {
    if (this.file && (!file || !sameFile(this.file, file))) {
      for (const peer of [...this.active.keys()]) this.cancel(peer, true);
    }
    this.file = file;
    this.duration = duration;
    if (file) this.room.broadcastControl(this.offerMessage(file));
  }

  /** Tell one newly arrived peer what is on offer. */
  offerTo(peer: string): void {
    if (this.file) this.room.sendTo(peer, this.offerMessage(this.file));
  }

  private offerMessage(file: File): FileOffer {
    return { type: "file-offer", ...identity(file), duration: this.duration };
  }

  handle(from: string, message: FileMessage): void {
    if (message.type === "file-request") void this.serve(from, message.offset, message);
    else if (message.type === "file-cancel") this.cancel(from, false);
  }

  private async serve(peer: string, offset: number, wanted: FileIdentity): Promise<void> {
    const file = this.file;
    // Only ever the file on offer — a peer cannot ask for anything else.
    if (!file || !sameFile(file, wanted)) {
      this.room.sendTo(peer, { type: "file-cancel", ...identity(wanted) });
      return;
    }
    const start = Math.max(0, Math.min(Math.floor(offset), file.size));
    const token = this.nextToken++;
    this.active.set(peer, token);
    const chunkSize = this.room.fileChunkSize(peer);

    let position = start;
    try {
      while (position < file.size) {
        if (this.active.get(peer) !== token) return; // cancelled or superseded
        const slice = await file.slice(position, Math.min(position + READ_SLICE, file.size)).arrayBuffer();
        for (let i = 0; i < slice.byteLength; i += chunkSize) {
          if (this.active.get(peer) !== token) return;
          const ok = await this.room.sendFileChunk(peer, slice.slice(i, i + chunkSize));
          if (!ok) return; // channel closed; the friend can resume later
          position += Math.min(chunkSize, slice.byteLength - i);
        }
        this.onProgress?.({ peer, sent: position, size: file.size });
      }
      if (!(await this.room.drainFileChannel(peer))) return;
      this.room.sendTo(peer, { type: "file-end", ...identity(file) });
      this.onFinished?.(peer);
    } finally {
      if (this.active.get(peer) === token) this.active.delete(peer);
    }
  }

  cancel(peer: string, notify: boolean): void {
    this.active.delete(peer);
    if (notify && this.file) this.room.sendTo(peer, { type: "file-cancel", ...identity(this.file) });
  }

  peerLeft(peer: string): void {
    this.active.delete(peer);
  }

  get sendingTo(): string[] {
    return [...this.active.keys()];
  }
}

// ---------------------------------------------------------------------------
// Friend side
// ---------------------------------------------------------------------------

export type ReceiveState =
  | { phase: "receiving"; received: number; size: number; bytesPerSecond: number }
  | { phase: "done"; file: File; handle?: FileSystemFileHandle }
  | { phase: "interrupted"; received: number; size: number; reason: string }
  | { phase: "failed"; reason: string };

export class FileReceiver {
  private readonly room: Room;
  private sink?: Sink;
  private offer?: FileOffer;
  private from?: string;
  private received = 0;
  /** writes are chained so chunks hit the disk strictly in order */
  private writing: Promise<void> = Promise.resolve();
  private failed = false;
  private finishing = false;
  private stallTimer?: number;
  private speedSamples: Array<{ t: number; bytes: number }> = [];
  onState?: (state: ReceiveState) => void;

  constructor(room: Room) {
    this.room = room;
  }

  get busy(): boolean {
    return !!this.sink;
  }

  get current(): { offer: FileOffer; from: string; received: number } | undefined {
    return this.offer && this.from ? { offer: this.offer, from: this.from, received: this.received } : undefined;
  }

  /** Begin (or resume, if the sink already holds bytes) receiving `offer` from `from`. */
  start(from: string, offer: FileOffer, sink: Sink): void {
    this.sink = sink;
    this.offer = offer;
    this.from = from;
    this.received = sink.offset;
    this.failed = false;
    this.finishing = false;
    this.armStallTimer();
    this.writing = Promise.resolve();
    this.speedSamples = [{ t: performance.now(), bytes: this.received }];
    this.room.sendTo(from, { type: "file-request", ...identity(offer), offset: this.received });
    this.emitProgress();
  }

  data(from: string, chunk: ArrayBuffer): void {
    const sink = this.sink;
    const offer = this.offer;
    if (!sink || !offer || from !== this.from || this.failed) return;
    // Never write past the advertised size, whatever the peer sends.
    const room = offer.size - this.received;
    if (room <= 0) return;
    const bytes = chunk.byteLength > room ? chunk.slice(0, room) : chunk;
    this.received += bytes.byteLength;
    this.writing = this.writing.then(() => sink.write(bytes)).catch((err: unknown) => {
      this.fail(`could not write to disk: ${(err as Error).message}`);
    });
    this.armStallTimer();
    this.sampleSpeed();
    if (this.received === offer.size) void this.finish();
  }

  /**
   * No bytes for a while means the host went away without a clean leave
   * (closed laptop, lost network). Keep what arrived so it can resume.
   */
  private armStallTimer(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = window.setTimeout(() => {
      if (this.sink && !this.finishing) void this.interrupt("no data from the host for 30 seconds");
    }, 30_000);
  }

  handle(from: string, message: FileMessage): void {
    if (!this.offer || from !== this.from || !sameFile(this.offer, message)) return;
    if (message.type === "file-end") {
      // The end message can overtake the last bytes (different SCTP stream), so
      // completion is driven by the byte count in data(); this only covers the
      // case where every byte had already arrived.
      if (this.received === this.offer.size) void this.finish();
    }
    else if (message.type === "file-cancel") void this.interrupt("the host stopped sharing it");
  }

  /** The sender left or the channel dropped: keep what we have for a resume. */
  async interrupt(reason: string): Promise<void> {
    const sink = this.sink;
    const offer = this.offer;
    if (!sink || !offer || this.finishing) return;
    if (this.stallTimer) clearTimeout(this.stallTimer);
    await this.writing;
    await sink.abort();
    this.sink = undefined;
    this.onState?.({ phase: "interrupted", received: this.received, size: offer.size, reason });
  }

  cancel(): void {
    if (this.offer && this.from) this.room.sendTo(this.from, { type: "file-cancel", ...identity(this.offer) });
    void this.interrupt("cancelled");
  }

  private async finish(): Promise<void> {
    const sink = this.sink;
    const offer = this.offer;
    if (!sink || !offer || this.finishing || this.received !== offer.size) return;
    this.finishing = true;
    if (this.stallTimer) clearTimeout(this.stallTimer);
    await this.writing;
    if (this.failed) return;
    try {
      const { file, handle } = await sink.close();
      this.sink = undefined;
      if (file.size !== offer.size) {
        this.onState?.({ phase: "failed", reason: `saved file is ${file.size} bytes, expected ${offer.size}` });
        return;
      }
      this.onState?.({ phase: "done", file, handle });
    } catch (err) {
      this.fail(`could not finish the file: ${(err as Error).message}`);
    }
  }

  private fail(reason: string): void {
    if (this.failed) return;
    this.failed = true;
    if (this.stallTimer) clearTimeout(this.stallTimer);
    if (this.offer && this.from) this.room.sendTo(this.from, { type: "file-cancel", ...identity(this.offer) });
    void this.sink?.abort();
    this.sink = undefined;
    this.onState?.({ phase: "failed", reason });
  }

  private lastEmit = 0;
  private sampleSpeed(): void {
    const now = performance.now();
    this.speedSamples.push({ t: now, bytes: this.received });
    // Speed over the last ~5 s, so it reacts without jittering.
    while (this.speedSamples.length > 2 && now - (this.speedSamples[0]?.t ?? now) > 5000) this.speedSamples.shift();
    if (now - this.lastEmit > 250) {
      this.lastEmit = now;
      this.emitProgress();
    }
  }

  private emitProgress(): void {
    if (!this.offer) return;
    const first = this.speedSamples[0];
    const last = this.speedSamples[this.speedSamples.length - 1];
    const dt = first && last ? (last.t - first.t) / 1000 : 0;
    const bytesPerSecond = dt > 0.5 && first && last ? (last.bytes - first.bytes) / dt : 0;
    this.onState?.({ phase: "receiving", received: this.received, size: this.offer.size, bytesPerSecond });
  }
}
