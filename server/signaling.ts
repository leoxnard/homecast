/**
 * WebSocket signalling (PLAN §6, M5).
 *
 * **Handshake only — no media, ever.** This process relays SDP offers, answers
 * and ICE candidates so two browsers can open a direct WebRTC data channel.
 * After that it carries nothing: playhead, view direction and play/pause all
 * travel peer-to-peer (§4.2). The one thing that must never happen here is
 * video, and there is no code path that could carry it.
 *
 * The server does not interpret signalling payloads. It checks who may talk to
 * whom, enforces size limits, and forwards the blob untouched.
 */
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { join, leave, broadcast, getRoom, normaliseCode, isValidCode, stats, type Peer } from "./rooms.ts";

/** SDP blobs are a few KB; anything near this is not signalling. */
const MAX_MESSAGE_BYTES = 64 * 1024;
const HEARTBEAT_MS = 30_000;
/** Messages per peer per 10 s. ICE trickling is bursty, so this is generous. */
const RATE_LIMIT = 300;
const RATE_WINDOW_MS = 10_000;

interface Client extends Peer {
  socket: WebSocket;
  sentInWindow: number;
  windowStartedAt: number;
}

let nextId = 1;

export function attachSignaling(server: import("node:http").Server, path = "/ws"): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const clients = new Set<Client>();

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== path) {
      socket.destroy(); // nothing else on this server speaks WebSocket
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (socket: WebSocket) => {
    const client: Client = {
      id: `p${nextId++}-${Math.random().toString(36).slice(2, 8)}`,
      socket,
      alive: true,
      sentInWindow: 0,
      windowStartedAt: Date.now(),
      send: (payload) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
      },
      close: (code, reason) => socket.close(code, reason),
    };
    clients.add(client);

    socket.on("pong", () => (client.alive = true));
    socket.on("message", (raw: RawData) => handleMessage(client, raw));
    socket.on("close", () => {
      departRoom(client);
      clients.delete(client);
    });
    socket.on("error", () => {
      departRoom(client);
      clients.delete(client);
    });

    client.send({ type: "hello", self: client.id });
  });

  // Drop peers whose browser went away without closing — otherwise a room never
  // empties and its code stays claimed.
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        departRoom(client);
        clients.delete(client);
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      try {
        client.socket.ping();
      } catch {
        /* closing anyway */
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  wss.on("close", () => clearInterval(heartbeat));
}

function departRoom(client: Client): void {
  const room = leave(client);
  if (room) broadcast(room, { type: "peer-leave", peer: client.id });
}

function rateLimited(client: Client): boolean {
  const now = Date.now();
  if (now - client.windowStartedAt > RATE_WINDOW_MS) {
    client.windowStartedAt = now;
    client.sentInWindow = 0;
  }
  return ++client.sentInWindow > RATE_LIMIT;
}

function handleMessage(client: Client, raw: RawData): void {
  if (rateLimited(client)) {
    client.send({ type: "error", message: "rate limit exceeded" });
    client.close(1008, "rate limit");
    return;
  }

  let message: Record<string, unknown>;
  try {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    if (text.length > MAX_MESSAGE_BYTES) throw new Error("too large");
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    message = parsed as Record<string, unknown>;
  } catch {
    client.send({ type: "error", message: "malformed message" });
    return;
  }

  switch (message.type) {
    case "join": {
      const code = normaliseCode(String(message.room ?? ""));
      if (!isValidCode(code)) {
        client.send({ type: "error", message: "that room code is not valid", code: "bad-code" });
        return;
      }
      if (client.roomCode) departRoom(client);

      const result = join(client, code);
      if (!result.ok) {
        client.send({
          type: "error",
          code: result.reason,
          message: result.reason === "full" ? "that room is full" : "could not join that room",
        });
        return;
      }
      // The joiner learns who is already here and makes the offers; existing
      // peers are told to expect one. That keeps offer/answer roles unambiguous.
      client.send({ type: "joined", room: code, self: client.id, peers: result.peers });
      broadcast(result.room, { type: "peer-join", peer: client.id }, client.id);
      return;
    }

    case "signal": {
      const to = String(message.to ?? "");
      const room = client.roomCode ? getRoom(client.roomCode) : undefined;
      const target = room?.peers.get(to);
      // Peers may only be addressed inside your own room, and never yourself.
      if (!room || !target || to === client.id) {
        client.send({ type: "error", message: "no such peer in this room" });
        return;
      }
      target.send({ type: "signal", from: client.id, data: message.data });
      return;
    }

    case "leave": {
      departRoom(client);
      client.send({ type: "left" });
      return;
    }

    case "ping":
      client.send({ type: "pong", t: message.t });
      return;

    default:
      client.send({ type: "error", message: `unknown message type: ${String(message.type)}` });
  }
}

export { stats as signalingStats };
