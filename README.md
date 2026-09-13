# homecast

A local-first 360° video player. Your video files never leave your machine —
see [PLAN.md](PLAN.md) for the full design, and [docs/findings.md](docs/findings.md)
for measured corrections to it.

**Status: M1–M5 complete.** M6 (the YouTube adapter) is not built yet.

## Requirements

- Node ≥ 22.18 — the CLI runs TypeScript directly via native type stripping, so
  there is no build step for it
- ffmpeg (looked for at `/opt/homebrew/bin/ffmpeg`, else on `PATH`;
  override with `HOMECAST_FFMPEG` / `HOMECAST_FFPROBE`)

```bash
npm install
```

## The toolchain (M1)

```bash
node bin/homecast.mjs inspect  <file>              # what the player cares about
node bin/homecast.mjs prepare  <input> [-c ch.json] # lossless remux + chapters
node bin/homecast.mjs fallback <input>              # conditional 4K H.264
node bin/homecast.mjs spherical <file> [-s <orig>]  # repair 360° metadata
node bin/homecast.mjs chapters extract <video>      # embedded chapters → sidecar
```

`prepare` never re-encodes. It remuxes with `-c copy`, optionally injecting
chapters, then verifies with ffprobe that resolution, codec, pixel format,
duration and audio track count all came through unchanged — and refuses to run
at all if free disk is under 2× the input, because `-c copy` writes a whole new
file (PLAN §3.6).

It also **re-injects the spherical metadata that ffmpeg drops**. This is the one
place the plan was wrong: §5.8 assumed `-c copy` preserves it. It does not, and
the loss is silent. See [docs/findings.md](docs/findings.md#f1).

Chapters need two outputs, because browsers cannot read MP4 chapter atoms
(§5.4) and VLC cannot load an external chapter file (§5.5):

```bash
node bin/homecast.mjs prepare master.mp4 -c chapters.homecast.json
#   → embedded chapters for VLC / QuickTime
#   → the sidecar stays alongside for the web player, and carries the
#     per-chapter view directions that MP4 has nowhere to put
```

## The player (M2–M4)

```bash
npm run dev      # http://localhost:5173
npm run build    # static files in dist/
```

Open a file with the button, `O`, or by dropping it on the window. Drop a
`.homecast.json` sidecar to load chapters.

### Library (M3)

Files you open are remembered — the file itself stays where it is on disk and is
never copied, only referenced through a `FileSystemFileHandle` kept in IndexedDB.
One click reopens an 88 GB master without re-picking it. The grid shows a locally
generated thumbnail, duration, chapter count and resume position. If the browser
has dropped the handle's permission, the card says so and one click re-grants it.

Press `B` for the library, or the Library button.

### Chapters (M4)

Press `M` while watching to drop a marker at the current frame. It asks for a
name and **captures where you were looking** — yaw, pitch and FOV — so jumping to
that chapter later restores the view as well as the time. Press `C` for the list.

Export writes both required outputs (§5.4, §5.5):

- **`.homecast.json`** — the sidecar the player reads, and the only place the
  per-chapter view directions can live, since MP4 has nowhere to put them
- **`.ffmeta.txt`** — feeds `homecast prepare -c`, which embeds the chapters so
  VLC, QuickTime and Infuse see them too

Import works by button or by dropping a sidecar someone sent you onto the window.

**YouTube timestamps.** "Paste timestamps…" takes a chapter list straight from a
YouTube description — `0:07:47 LOVE (TUMJB)`, `7:47 - LOVE`, `LOVE (7:47)`, with
blank lines and the rest of the description ignored. It warns if timestamps run
past the end of the open video. Re-pasting a corrected list keeps the view
direction of any chapter that lands on the same second. "Copy as timestamps" goes
the other way. From the CLI:

```bash
node bin/homecast.mjs chapters from-text setlist.txt -o concert.homecast.json --video master.mp4
node bin/homecast.mjs prepare master.mp4 -c setlist.txt   # also accepted directly
```

The page reports what your machine can do *before* you open anything, and names
the file you should open if the master will not work here — a GPU whose
`MAX_TEXTURE_SIZE` is under 8192 cannot bind an 8K equirect frame at all
(§5.2), and that should not surface as a mysterious black screen mid-concert.

### Zoom

Limits are computed from the file's resolution and your window size, not
hardcoded: out to 110°, in to 3× upscale. The **1:1 NATIVE** badge lights when
one source pixel lands on exactly one screen pixel. Hold **⌥** to override the
clamps.

The readout also shows how many pixels the visible arc actually gets, which is
the honest number: an 8K equirect frame spreads 7680–8192 px over a full 360°,
so a 90° view is only ~1900–2000 px wide (§5.1).

### Tiny planet

Keep zooming out. Past about 110° the picture bends from an ordinary view into a
stereographic one and tilts toward the ground, until the venue becomes a little
world with the sky wrapped around it. Zooming back in returns to where you were
looking. **P** glides there and back; on a phone, keep pinching out.

### Keyboard

| | |
|---|---|
| drag, arrows | pan (shift for bigger steps) |
| scroll, `+`/`−` | zoom (⌥ to pass the clamps) |
| space, `K` | play / pause |
| `J` / `L` | ∓10 s · `,` / `.` step a frame |
| `[` / `]` | previous / next chapter |
| `0`–`9` | jump to 0–90% |
| `P` | tiny planet and back |
| `R` · `F` · `O` · `?` | reset view · fullscreen · open · help |

## Verified on the real footage

Against the 8192×4096 HEVC Main 10 master (PLAN §3.0):

- 15 s of playback while continuously panning: **0 dropped frames**, 60 fps render loop
- Orientation calibrated against `ffmpeg v360` rather than by eye —
  see [test/orientation.md](test/orientation.md)
- Chapter round-trip through embed → ffprobe → sidecar, escaping intact
- Spherical metadata re-injection: +130 bytes, chapters intact, decodes clean
- Full authoring loop: author in the player → export → `prepare -c` → read back
- `prepare` is idempotent — four consecutive runs leave one chapter track, not four
- Resume, thumbnails and chapter persistence survive a reload
- Two real browsers in one room: forced 3 s drift recovered immediately, settled
  **0.08 s apart** with `playbackRate` back at exactly 1
- View lock, unlink, last-mover-leads and the presence marker verified by
  projecting the marker and checking it lands where the geometry says it should

### Audio

The current master carries two tracks, FLAC then AAC. FLAC-in-MP4 **does** decode
in Chrome, so the web player gets the lossless one. But Chrome does not implement
`audioTracks`, so it always plays **track #1 and cannot switch** — VLC can.
Whatever should be the default has to be first in the file. `inspect` warns about
this whenever a file has more than one audio track.

### On a phone

Phones are not the target — an 8K master can outrun a mobile decoder, and §5.1's
maths means you want the pixels on a big screen anyway. But the page is fully
responsive: the toolbar fits, the chrome respects the notch and home indicator,
**pinch zooms**, **double-tap resets the view**, and the capability panel tells
you plainly that a 4K rendition is the better fit rather than letting an 8K file
stutter unexplained.

iOS Safari has no File System Access API, so the library cannot remember files
there — you pick the video each time. That is a browser limitation, not a bug.

### Watch together (M5)

Press `W`. Start a room, send the link (`/w/7QK2M`), and you both open **your own
copy** of the same file. The server introduces the two browsers and then goes
quiet — playhead, play/pause and view direction travel directly between you over
a WebRTC data channel. The video itself never moves.

- **View is locked by default**, with an unlink toggle. Whoever moved most
  recently leads, so two locked viewers never fight over the camera.
- **A marker shows where the other viewer is looking**, with an arrow pointing
  toward them while they are outside your frame.
- **Drift is corrected continuously** — small gaps by easing `playbackRate` at
  most 2% with pitch preserved, large ones by seeking. Measured 0.08 s apart.
- **Resync to me** forces everyone onto your playhead, for when someone's
  decoder falls behind.
- If your files differ in length, it says so rather than letting you wonder why
  nothing lines up.
- **Share a download link** for your file (Pingvin, Google Drive, …) in the room
  panel. Anyone who joins without the file sees where to get it. Only the link is
  sent; the video never goes through homecast. The link is saved with the video
  and included in exported chapter sidecars.

  If you host the file on the home server, mind PLAN §2: one master is ~88 GB on
  a single, non-expandable disk that the other containers share.

Connections are direct, so a strict NAT or corporate firewall can prevent one
forming. There is no TURN relay, because relaying would mean routing your traffic
through a server.

## Deploying

The page is static; the server exists only to hand it out and, from M5, to relay
WebSocket signalling. A `Dockerfile` and a dependency-free `server/index.ts` are
included — see [docs/deploy.md](docs/deploy.md) for Coolify settings and why
Docker is preferred over a static build pack.

```bash
npm run build && npm run serve   # http://localhost:3000
```

## What this is not

Not a video host. Nothing is uploaded, and the server (when M5 arrives) will
carry only the page and a few hundred bytes of sync state. See PLAN §2 for the
designs that were evaluated and deliberately rejected.
