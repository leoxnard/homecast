# Deploying homecast

The server's only job is to hand out a ~200 KB page and, from M5, to relay
WebSocket signalling. **No video ever passes through it** (PLAN §1, §4.2), which
is what makes an old, busy, Wi-Fi-only host a perfectly adequate place to run it.

## Docker, or not?

Both work. Which one depends on whether you want to re-platform at M5.

| | Static build pack | **Dockerfile** (recommended) |
|---|---|---|
| Files needed | none | `Dockerfile`, `server/` |
| Serves the built page | yes | yes |
| WebSocket signalling (M5) | **no** — needs a second service | yes, same process |
| Room URLs (`/w/7QK2M`) | needs an SPA-fallback setting | built in |
| Image size | ~50 MB (nginx) | ~150 MB (node:22-alpine) |

M5 adds signalling, and running it in the same container means one origin, one
route, one tunnel hostname — no CORS, no second subdomain, and `wss://` rides the
same connection the page came from. That is why the repo ships a Dockerfile.

The runtime installs **no dependencies at all**: Node ≥ 22.18 strips TypeScript
types natively, and `server/index.ts` uses only the standard library.

## Coolify setup

Create an **Application** from the public repository, then:

| Field | Value |
|---|---|
| Build pack | **Dockerfile** |
| Branch | `main` |
| Dockerfile location | `/Dockerfile` |
| Ports exposed | `3000` |
| Domain | `https://<your-subdomain>` |

Nothing else needs setting — no environment variables, no volumes, no database.
`PORT`, `HOST` and `HOMECAST_ROOT` all have working defaults, and there is no
state to persist: the library, resume positions and chapters live in each
viewer's own browser (IndexedDB), never on the server.

### If you are behind a Cloudflare tunnel

TLS terminates at Cloudflare, so the tunnel forwards plain HTTP to the proxy and
the app's Traefik router sits on the **http** entrypoint. Coolify generates those
labels itself once the domain is set — you do not write them by hand. Point the
tunnel's public hostname at the proxy's port 80 as you do for every other app.

A `404` from the hostname means the proxy is reachable but no router claims it
yet: the tunnel is right and the application is not deployed (or its domain field
is empty).

### WebSockets through the tunnel

Signalling lives at **`/ws`** on the same origin as the page. Cloudflare tunnels
and Traefik both pass WebSocket upgrades through without extra configuration, so
there is nothing to add — but if rooms connect on localhost and not in
production, that upgrade is the first thing to check.

The server answers upgrades on `/ws` only and destroys any other upgrade attempt.

### Optional: Pingvin uploads

Off unless **all four** of these are set on the homecast application in Coolify:

| Variable | Value |
|---|---|
| `PINGVIN_URL` | how the homecast container reaches Pingvin — an internal address is best, so uploads do not leave the server and come back through Cloudflare |
| `PINGVIN_USERNAME` | a Pingvin account allowed to create shares |
| `PINGVIN_PASSWORD` | its password — lives only in the server environment, never in the browser |
| `HOMECAST_UPLOAD_KEY` | a long random secret (`openssl rand -hex 24`). The host enters it once when uploading. Without it, anyone who finds homecast could fill the server's disk |
| `PINGVIN_EXPIRATION` | optional, default `1-week` |

Then, in Pingvin:

- **Raise `share.maxSize`.** The default is 50 GB; one HQ concert master is 88 GB
  and is refused up front, with a message saying so.
- **Mind the disk.** The server has a single, non-expandable disk shared with every
  other container (PLAN §2). Each uploaded master costs ~88 GB until its share expires.

For an internal `PINGVIN_URL`, put homecast on the same Docker network as Pingvin
(Coolify: the app's *Network* settings). A public `https://share…` URL also works,
but every upload chunk then makes a round trip through the Cloudflare tunnel.

When configured, the room panel shows **Upload to Pingvin**. Once uploaded, the
"copy link with video" link carries the download, so a friend can start even while
the host is offline. Downloads go through homecast (Pingvin enables no CORS), and
resume after interruptions — Pingvin itself cannot serve byte ranges, so homecast
skips the already-received bytes on the server side.

### Optional: a TURN relay for devices that can't connect directly

Watch-together connects the browsers directly. That fails when a device is on
mobile data or behind a strict router or firewall, and the room shows "Your
networks can't connect directly". A TURN relay fixes this. It is off by default,
because relayed traffic (a video sent "From this browser", too) goes through the
relay.

- **Cloudflare Realtime TURN** (no ports to open, works behind the tunnel):
  create a TURN key under *Realtime → TURN Server* in the Cloudflare dashboard,
  then set `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN`. Check
  Cloudflare's current pricing for relayed data.
- **Your own coturn** (needs UDP 3478 and a relay port range reachable from the
  internet, so it can't sit behind a Cloudflare tunnel): run it with
  `use-auth-secret`, then set `TURN_URLS` (comma-separated) and `TURN_SECRET`.

The server mints credentials that expire after 6 hours, at `/api/ice`. A
transfer that goes through the relay says "via a relay" next to its speed.

### Health

The container exposes `/healthz`, which returns `ok`. Coolify's health check uses
it via the `HEALTHCHECK` in the Dockerfile, so a failed build or a missing `dist/`
surfaces as an unhealthy container rather than a white page.

## Caching

`index.html` is served `no-cache` and hashed assets `immutable` for a year. This
matters on a redeploy: without it, viewers keep a stale shell that references
asset filenames which no longer exist.

If Cloudflare is proxying, its default caching is fine — but purge the cache after
a deploy if you see the old build, since the edge may hold the shell briefly.

## Building on a slow host

The image builds `npm ci` and `vite build` inside Docker, so the host needs only
Docker — no Node, no toolchain.

Measured on a 2014-era quad-core with 27 other containers running: **33 s** for a
cold build, producing a **236 MB** image that idles at **23 MB RSS** and 0% CPU.
That is cheap enough not to think about. The container runs as a non-root user.

If the host is ever too loaded to build, nothing in the build depends on it —
build elsewhere and push the image instead.

## What is NOT deployed

- No video, ever — not the masters, not renditions, not thumbnails
- No user data, accounts or sessions
- No database

Do not add file serving for media to this service. Every reason it was rejected
is in PLAN §2, and they all still hold.
