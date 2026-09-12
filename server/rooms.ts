/**
 * Room registry for watch-together (PLAN §4.3, M5).
 *
 * A room is a handful of peers that have agreed to talk to each other. The
 * server introduces them and then gets out of the way: once the WebRTC data
 * channel is up, sync state flows peer-to-peer and never comes back here.
 *
 * Nothing is persisted. Rooms exist in memory and vanish when the last peer
 * leaves, exactly as §4.3 specifies.
 */

/** No 0/O/1/I/L — these get read aloud and typed by hand. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 5;

export const MAX_PEERS_PER_ROOM = 8;
export const MAX_ROOMS = 500;

export interface Peer {
  id: string;
  send: (payload: unknown) => void;
  close: (code: number, reason: string) => void;
  roomCode?: string;
  alive: boolean;
}

export interface Room {
  code: string;
  peers: Map<string, Peer>;
  createdAt: number;
}

const rooms = new Map<string, Room>();

export function randomCode(): string {
  let code = "";
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  for (const b of bytes) code += ALPHABET[b % ALPHABET.length];
  return code;
}

/**
 * Codes are case-insensitive; spaces and dashes people add when writing them
 * down are ignored. Anything else is left alone so `isValidCode` can reject it
 * loudly — silently deleting a mistyped character would shift the rest of the
 * code and join the wrong room.
 */
export function normaliseCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, "").slice(0, CODE_LENGTH);
}

export function isValidCode(code: string): boolean {
  return code.length === CODE_LENGTH && [...code].every((c) => ALPHABET.includes(c));
}

export function createRoom(): Room | undefined {
  if (rooms.size >= MAX_ROOMS) return undefined;
  let code = randomCode();
  for (let i = 0; rooms.has(code) && i < 10; i++) code = randomCode();
  if (rooms.has(code)) return undefined;
  const room: Room = { code, peers: new Map(), createdAt: Date.now() };
  rooms.set(code, room);
  return room;
}

export const getRoom = (code: string): Room | undefined => rooms.get(code);

export type JoinResult =
  | { ok: true; room: Room; peers: string[] }
  | { ok: false; reason: "not-found" | "full" | "bad-code" };

export function join(peer: Peer, rawCode: string): JoinResult {
  const code = rawCode.toUpperCase();
  if (!isValidCode(code)) return { ok: false, reason: "bad-code" };

  // Joining a code nobody created yet simply creates it — the code in a URL is
  // the invitation, so whoever arrives first opens the room (§4.3: no accounts).
  let room = rooms.get(code);
  if (!room) {
    if (rooms.size >= MAX_ROOMS) return { ok: false, reason: "not-found" };
    room = { code, peers: new Map(), createdAt: Date.now() };
    rooms.set(code, room);
  }
  if (room.peers.size >= MAX_PEERS_PER_ROOM) return { ok: false, reason: "full" };

  const existing = [...room.peers.keys()];
  room.peers.set(peer.id, peer);
  peer.roomCode = room.code;
  return { ok: true, room, peers: existing };
}

export function leave(peer: Peer): Room | undefined {
  if (!peer.roomCode) return undefined;
  const room = rooms.get(peer.roomCode);
  peer.roomCode = undefined;
  if (!room) return undefined;
  room.peers.delete(peer.id);
  if (room.peers.size === 0) rooms.delete(room.code); // expire when empty
  return room;
}

export function broadcast(room: Room, payload: unknown, exceptId?: string): void {
  for (const [id, peer] of room.peers) {
    if (id !== exceptId) peer.send(payload);
  }
}

export const stats = () => ({
  rooms: rooms.size,
  peers: [...rooms.values()].reduce((n, r) => n + r.peers.size, 0),
});
