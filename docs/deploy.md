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

The image builds `npm ci` and `vite build` inside Docker. On a 2014-era quad-core
this takes a few minutes, most of it `npm ci`. It is disk-cheap (a few hundred MB
of layers) and happens only on deploy. If the host is under load, build elsewhere
and push the image instead — nothing in the build depends on the host.

## What is NOT deployed

- No video, ever — not the masters, not renditions, not thumbnails
- No user data, accounts or sessions
- No database

Do not add file serving for media to this service. Every reason it was rejected
is in PLAN §2, and they all still hold.
