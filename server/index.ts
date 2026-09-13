/**
 * homecast server.
 *
 * It serves the built page and, from M5, will carry WebSocket signalling.
 * That is the whole job. **No video ever passes through here** — PLAN §1, §4.2.
 * The peers exchange a few hundred bytes of state over a direct WebRTC data
 * channel; this process only helps them find each other.
 *
 * Deliberately dependency-free: it runs on the standard library alone, so the
 * production image installs nothing and the 2014 host stays unbothered.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { attachSignaling, signalingStats } from "./signaling.ts";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const ROOT = process.env.HOMECAST_ROOT ?? fileURLToPath(new URL("../dist", import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  // Present so local test fixtures play correctly. This does NOT make homecast
  // a video host: the deployed image contains only the built page (see
  // .dockerignore), and PLAN §2 explains at length why serving media from this
  // box was rejected.
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/** Resolve a URL path inside ROOT, or undefined if it escapes or is missing. */
function resolveFile(urlPath: string): string | undefined {
  const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  const relative = normalize(decoded).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
  const candidate = join(ROOT, relative);
  if (!candidate.startsWith(ROOT)) return undefined; // path traversal
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return undefined;
}

function send(res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function serve(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? "/";

  if (url === "/healthz") return send(res, 200, "ok");
  if (url === "/stats") {
    // Room and peer counts only — no codes, no addresses, nothing identifying.
    return send(res, 200, JSON.stringify(signalingStats()), "application/json; charset=utf-8");
  }

  const file = resolveFile(url);

  // Unknown *pages* fall back to the app shell, so room URLs like /w/7QK2M
  // (PLAN §4.3) load the player instead of 404ing. Unknown *files* must not:
  // answering a stale `/assets/index-OLD.js` with the HTML shell and a 200
  // makes the browser refuse the "script" and render a blank page — which is
  // what a tab still holding the previous deploy's HTML hit after a redeploy.
  const pathname = (url.split("?")[0] ?? "/");
  if (!file && extname(pathname) !== "") return send(res, 404, "not found");
  const target = file ?? join(ROOT, "index.html");
  if (!existsSync(target)) return send(res, 500, "build missing: run `npm run build`");

  const ext = extname(target);
  const headers: Record<string, string> = {
    "content-type": MIME[ext] ?? "application/octet-stream",
    // Hashed assets are immutable; the shell must never be cached, or a
    // deploy leaves viewers on a stale build.
    "cache-control": file && /-[A-Za-z0-9_-]{8,}\./.test(target)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };

  res.writeHead(200, headers);
  createReadStream(target).pipe(res);
}

const server = createServer((req, res) => {
  try {
    serve(req, res);
  } catch (err) {
    send(res, 500, `error: ${(err as Error).message}`);
  }
});

// Signalling lives on the same origin as the page, so it needs no extra domain,
// no CORS, and one tunnel route: the page came from here, so `wss://` to /ws
// rides the same hostname.
attachSignaling(server, "/ws");

server.listen(PORT, HOST, () => {
  console.log(`homecast serving ${ROOT} on http://${HOST}:${PORT} (signalling at /ws)`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
