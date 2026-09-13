/**
 * ICE servers for the browsers: STUN always, TURN when configured.
 *
 * A direct WebRTC path fails when either side sits behind a symmetric NAT
 * (most mobile data, some routers) or a firewall that blocks UDP. TURN relays
 * the connection instead; it is off unless the owner configures one, because a
 * relay means peer traffic — possibly a whole video — goes through it.
 *
 *   CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN
 *       Cloudflare Realtime TURN; short-lived credentials are minted per request.
 *   TURN_URLS + TURN_SECRET
 *       your own coturn with `use-auth-secret`; TURN_URLS is comma-separated,
 *       e.g. "turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349"
 *
 * Credentials expire after TTL_SECONDS, so a copied set stops working soon.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac } from "node:crypto";

const CF_KEY_ID = process.env.CLOUDFLARE_TURN_KEY_ID;
const CF_TOKEN = process.env.CLOUDFLARE_TURN_API_TOKEN;
const TURN_URLS = process.env.TURN_URLS?.split(",").map((u) => u.trim()).filter(Boolean);
const TURN_SECRET = process.env.TURN_SECRET;

const TTL_SECONDS = 6 * 60 * 60;
const STUN: RTCIceServerLike = { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] };

interface RTCIceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** A modest per-address limit: every credential set is relay capacity someone pays for. */
const recent = new Map<string, number[]>();
function allowed(req: IncomingMessage): boolean {
  const ip = String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "");
  const now = Date.now();
  const hits = (recent.get(ip) ?? []).filter((t) => now - t < 60_000);
  hits.push(now);
  recent.set(ip, hits);
  if (recent.size > 5000) recent.clear();
  return hits.length <= 30;
}

async function cloudflare(): Promise<RTCIceServerLike[]> {
  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(CF_KEY_ID ?? "")}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${CF_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl: TTL_SECONDS }),
    },
  );
  if (!res.ok) throw new Error(`Cloudflare TURN answered ${res.status}`);
  const body = (await res.json()) as { iceServers?: RTCIceServerLike | RTCIceServerLike[] };
  const servers = Array.isArray(body.iceServers) ? body.iceServers : body.iceServers ? [body.iceServers] : [];
  // Browsers time out on port 53 (Cloudflare's docs say to drop those URLs).
  return servers.map((s) => ({
    ...s,
    urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u)),
  }));
}

function coturn(): RTCIceServerLike[] {
  const username = `${Math.floor(Date.now() / 1000) + TTL_SECONDS}:homecast`;
  const credential = createHmac("sha1", TURN_SECRET ?? "").update(username).digest("base64");
  return [{ urls: TURN_URLS ?? [], username, credential }];
}

export const turnConfigured = (): boolean => !!((CF_KEY_ID && CF_TOKEN) || (TURN_URLS?.length && TURN_SECRET));

export async function handleIce(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if (!turnConfigured()) return reply(200, { iceServers: [STUN], turn: false });
  if (!allowed(req)) return reply(429, { iceServers: [STUN], turn: false });
  try {
    const turn = CF_KEY_ID && CF_TOKEN ? await cloudflare() : coturn();
    reply(200, { iceServers: [STUN, ...turn], turn: true });
  } catch (err) {
    // Degrade to direct-only rather than breaking rooms.
    console.warn(`TURN credentials unavailable: ${(err as Error).message}`);
    reply(200, { iceServers: [STUN], turn: false });
  }
}
