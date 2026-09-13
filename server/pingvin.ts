/**
 * Optional Pingvin Share relay.
 *
 * Lets the host upload the video to the owner's Pingvin instance once, so a
 * friend can download it without the host staying online. This is the one place
 * homecast carries video bytes, and only when the owner configures it: PLAN §2
 * rejected server-side video for disk, uplink and Cloudflare-terms reasons that
 * still apply, so it is off unless every variable below is set.
 *
 *   PINGVIN_URL           where the homecast server reaches Pingvin (internal URL preferred)
 *   PINGVIN_USERNAME      a Pingvin account allowed to create shares
 *   PINGVIN_PASSWORD
 *   HOMECAST_UPLOAD_KEY   shared secret; without it anyone could fill the disk through homecast
 *   PINGVIN_EXPIRATION    optional, default "1-week" (Pingvin relative format, e.g. "7-day")
 *
 * Why a relay rather than the browser talking to Pingvin directly: Pingvin 1.13
 * enables no CORS and authenticates with an httpOnly cookie, so a page on
 * another origin can neither call it nor hold the session. Credentials therefore
 * live only in the server's environment.
 *
 * Pingvin behaviour this relies on, measured against a real 1.13.0:
 * - uploads are raw octet-stream chunks of at most `share.chunkSize`; the first
 *   response carries the file id, later chunks must pass it
 * - an out-of-order chunk is rejected with `expectedChunkIndex`, so a retry or a
 *   resumed upload knows exactly where to continue
 * - downloads ignore Range and always start at byte 0, so a resumed download is
 *   served by skipping bytes here — a local disk read — instead of over the network
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";

const BASE = process.env.PINGVIN_URL?.replace(/\/+$/, "");
const USERNAME = process.env.PINGVIN_USERNAME;
const PASSWORD = process.env.PINGVIN_PASSWORD;
const UPLOAD_KEY = process.env.HOMECAST_UPLOAD_KEY;
const EXPIRATION = process.env.PINGVIN_EXPIRATION ?? "1-week";

export const pingvinEnabled = (): boolean => !!(BASE && USERNAME && PASSWORD && UPLOAD_KEY);

const ID_PATTERN = /^[a-zA-Z0-9_-]{3,50}$/;
const FILE_ID_PATTERN = /^[0-9a-f-]{36}$/;

// --- session ------------------------------------------------------------------

let session: { cookie: string; at: number } | undefined;
/** Pingvin access tokens are short-lived; sign in again well before expiry. */
const SESSION_MS = 10 * 60 * 1000;

function cookiesFrom(res: Response): string[] {
  const all = res.headers.getSetCookie?.() ?? [];
  return all.map((c) => c.split(";")[0] ?? "").filter(Boolean);
}

async function signIn(): Promise<string> {
  const field = USERNAME?.includes("@") ? "email" : "username";
  const res = await fetch(`${BASE}/api/auth/signIn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ [field]: USERNAME, password: PASSWORD }),
  });
  if (!res.ok) throw new RelayError(502, `Pingvin sign-in failed (${res.status})`);
  const cookie = cookiesFrom(res).join("; ");
  if (!cookie.includes("access_token")) throw new RelayError(502, "Pingvin sign-in returned no session");
  session = { cookie, at: Date.now() };
  return cookie;
}

async function authed(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const cookie = session && Date.now() - session.at < SESSION_MS ? session.cookie : await signIn();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), cookie },
    // Required by Node's fetch whenever the body is a stream.
    ...(init.body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
  if (res.status === 401 && retry) {
    session = undefined;
    return authed(path, init, false);
  }
  return res;
}

class RelayError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// --- helpers ------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

function keyOk(req: IncomingMessage): boolean {
  const given = Buffer.from(String(req.headers["x-homecast-key"] ?? ""));
  const want = Buffer.from(UPLOAD_KEY ?? "");
  return want.length > 0 && given.length === want.length && timingSafeEqual(given, want);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new RelayError(413, "chunk too large");
    parts.push(chunk as Buffer);
  }
  return Buffer.concat(parts);
}

let limits: { maxSize: number; chunkSize: number } | undefined;
async function pingvinLimits(): Promise<{ maxSize: number; chunkSize: number }> {
  if (limits) return limits;
  const res = await fetch(`${BASE}/api/configs`);
  if (!res.ok) throw new RelayError(502, `could not read Pingvin config (${res.status})`);
  const configs = (await res.json()) as Array<{ key: string; value: string }>;
  const get = (k: string) => Number(configs.find((c) => c.key === k)?.value ?? NaN);
  limits = { maxSize: get("share.maxSize"), chunkSize: get("share.chunkSize") };
  return limits;
}

// --- routes -------------------------------------------------------------------

/** Returns true when the request was a Pingvin route (handled or rejected). */
export async function handlePingvin(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/pingvin/")) return false;
  const parts = url.pathname.slice("/api/pingvin/".length).split("/").filter(Boolean);

  try {
    // GET status — safe to expose: says whether uploads exist, never how.
    if (req.method === "GET" && parts[0] === "status") {
      if (!pingvinEnabled()) return json(res, 200, { enabled: false }), true;
      const { maxSize, chunkSize } = await pingvinLimits();
      return json(res, 200, { enabled: true, maxSize, chunkSize }), true;
    }

    if (!pingvinEnabled()) return json(res, 404, { error: "Pingvin uploads are not configured" }), true;

    // GET download/:shareId/:fileId — anyone holding the (unguessable) link.
    if (req.method === "GET" && parts[0] === "download" && parts.length === 3) {
      await download(req, res, parts[1] ?? "", parts[2] ?? "");
      return true;
    }

    // Everything else creates data on the owner's server: key required.
    if (!keyOk(req)) return json(res, 401, { error: "upload key missing or wrong" }), true;

    // POST shares {name, size} → {shareId, chunkSize}
    if (req.method === "POST" && parts[0] === "shares" && parts.length === 1) {
      const body = JSON.parse((await readBody(req, 4096)).toString("utf8")) as { name?: unknown; size?: unknown };
      const size = Number(body.size);
      const name = String(body.name ?? "video").slice(0, 200);
      const { maxSize, chunkSize } = await pingvinLimits();
      if (!Number.isFinite(size) || size <= 0) return json(res, 400, { error: "size required" }), true;
      if (Number.isFinite(maxSize) && size > maxSize) {
        return json(res, 413, {
          error: `This video is ${gb(size)} but Pingvin accepts at most ${gb(maxSize)} per share. Raise "share.maxSize" in Pingvin's admin settings.`,
          maxSize,
        }), true;
      }
      const shareId = `hc${randomBytes(6).toString("hex")}`;
      const title = name.replace(/\.[^.]+$/, "").padEnd(3, "_").slice(0, 30);
      const created = await authed("/api/shares", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: shareId,
          name: title,
          expiration: EXPIRATION,
          recipients: [],
          security: {},
          description: "Shared from homecast",
        }),
      });
      if (!created.ok) return json(res, 502, { error: `Pingvin refused the share: ${await created.text()}` }), true;
      return json(res, 200, { shareId, chunkSize }), true;
    }

    // PUT shares/:id/chunks?index&total&name&fileId — raw body, forwarded as is.
    if (req.method === "PUT" && parts[0] === "shares" && parts[2] === "chunks" && ID_PATTERN.test(parts[1] ?? "")) {
      const { chunkSize } = await pingvinLimits();
      const body = await readBody(req, chunkSize);
      const q = new URLSearchParams({
        name: url.searchParams.get("name") ?? "video.mp4",
        chunkIndex: url.searchParams.get("index") ?? "0",
        totalChunks: url.searchParams.get("total") ?? "1",
      });
      const fileId = url.searchParams.get("fileId");
      if (fileId) {
        if (!FILE_ID_PATTERN.test(fileId)) return json(res, 400, { error: "bad file id" }), true;
        q.set("id", fileId);
      }
      const up = await authed(`/api/shares/${parts[1]}/files?${q}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body,
      });
      const text = await up.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        /* non-JSON error page */
      }
      if (!up.ok) {
        // Pass the expected index through: the browser uses it to resume.
        return json(res, up.status === 400 ? 409 : 502, {
          error: String(parsed.message ?? text).slice(0, 300),
          expectedChunkIndex: parsed.expectedChunkIndex,
        }), true;
      }
      return json(res, 200, { fileId: parsed.id }), true;
    }

    // POST shares/:id/complete
    if (req.method === "POST" && parts[0] === "shares" && parts[2] === "complete" && ID_PATTERN.test(parts[1] ?? "")) {
      const done = await authed(`/api/shares/${parts[1]}/complete`, { method: "POST" });
      if (!done.ok) return json(res, 502, { error: `Pingvin could not complete the share: ${await done.text()}` }), true;
      return json(res, 200, { ok: true }), true;
    }

    return json(res, 404, { error: "unknown Pingvin route" }), true;
  } catch (err) {
    const status = err instanceof RelayError ? err.status : 502;
    if (!res.headersSent) json(res, status, { error: (err as Error).message });
    else res.destroy();
    return true;
  }
}

async function download(req: IncomingMessage, res: ServerResponse, shareId: string, fileId: string): Promise<void> {
  if (!ID_PATTERN.test(shareId) || !FILE_ID_PATTERN.test(fileId)) return json(res, 400, { error: "bad link" });

  // Public shares still need a per-share token cookie before files can be read.
  const token = await fetch(`${BASE}/api/shares/${shareId}/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!token.ok) return json(res, token.status === 404 ? 404 : 502, { error: "share not found or expired" });
  const cookie = cookiesFrom(token).join("; ");

  const upstream = await fetch(`${BASE}/api/shares/${shareId}/files/${fileId}?download=true`, { headers: { cookie } });
  if (!upstream.ok || !upstream.body) return json(res, upstream.status === 404 ? 404 : 502, { error: "file unavailable" });

  const size = Number(upstream.headers.get("content-length") ?? NaN);
  const range = /^bytes=(\d+)-$/.exec(String(req.headers.range ?? ""));
  const start = range ? Number(range[1]) : 0;
  if (!Number.isFinite(size) || start > size) {
    await upstream.body.cancel();
    return json(res, 416, { error: "range not satisfiable" });
  }

  const headers: Record<string, string> = {
    "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
    "content-length": String(size - start),
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  if (start > 0) headers["content-range"] = `bytes ${start}-${size - 1}/${size}`;
  res.writeHead(start > 0 ? 206 : 200, headers);

  // Skip the bytes the client already has — Pingvin cannot start mid-file.
  let toSkip = start;
  const source = Readable.fromWeb(upstream.body as never);
  req.on("close", () => source.destroy());
  for await (const piece of source) {
    let buf = piece as Buffer;
    if (toSkip > 0) {
      if (buf.length <= toSkip) {
        toSkip -= buf.length;
        continue;
      }
      buf = buf.subarray(toSkip);
      toSkip = 0;
    }
    if (!res.write(buf)) await new Promise((r) => res.once("drain", r));
  }
  res.end();
}

const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`;
