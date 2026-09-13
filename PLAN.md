# homecast — Implementation Plan

> Status: **design complete, zero code written.** This document is the output of a
> requirements-grilling session. Every number marked ✅ was measured on the actual
> hardware, not assumed. Every ⚠️ is unverified and must be checked before relying on it.
>
> Read §2 (Non-goals) before proposing anything. Several "obvious" designs were
> explicitly evaluated and rejected for concrete, measured reasons.

---

## 1. What this is

A **local-first 360° video player** that runs as a static web page, with
**synchronised watch-together** sessions.

It is **not** a video hosting platform. Video files live on each viewer's own machine
and are never transmitted by this system. Only a few hundred bytes of state
(playhead, play/pause, view orientation) cross the network.

**Core motivation:** YouTube serves 360° video at starved bitrates. At 4K equirect you
are looking at a ~960 px wide image (see §5.1). The user shoots 8K 360° on an Insta360
and wants to actually see it at full resolution, with VLC-style pan/zoom, chapter
markers for band/music footage, and the ability to watch in sync with a friend.

### Primary user
- macOS 26.6 on a MacBookPro18,2 (**M1 Max**, 10-core, 32 GB)
- ffmpeg 8.1.2 at `/opt/homebrew/bin/ffmpeg`
- Insta360 Studio + VLC 3.0.23 installed
- Physically in Denmark; the home server is in Germany

### Other viewers
Apple Silicon Macs, and Windows PCs with modern GPUs. Phones and tablets are not
the target (see §5.2) but are no longer *broken*: the layout adapts, touch
gestures work, and the capability probe recommends a 4K rendition.

---

## 2. Non-goals — do NOT build these

These were each evaluated in depth and rejected. Do not reintroduce them.

| Rejected | Why |
|---|---|
| Server-side video hosting / streaming | Server is a 2015 MacBook Pro: 163 GB free disk, Wi-Fi only, ports 80/443 closed, behind a Cloudflare Free tunnel with a 100 MB request-body limit and ToS §2.8 restrictions on video. |
| HLS / DASH / adaptive bitrate ladder | Only needed for streaming. Streaming is gone. **No HLS. No segments. No manifests.** |
| Server-side transcoding | Server CPU is an i7-4770HQ (Haswell, 2014). Iris Pro 5200 QSV is H.264-only and caps at 4096 px — it cannot even *decode* HEVC. Software x265 at 8K ≈ 1 fps → 15–50 hrs per rendition, thermally throttled in a closed laptop lid. |
| PeerTube (stock, plugin, or fork) | 360° is unimplemented ([#119](https://github.com/Chocobozzz/PeerTube/issues/119), closed 2020 as "do it via plugin"). 8K needs a **fork** ([#5964](https://github.com/Chocobozzz/PeerTube/issues/5964), still open) touching the resolution enum, DB migrations and federation payloads. The one person who did it abandoned it. |
| MediaCMS / Owncast / Jellyfin / Plex | None support 360° playback. |
| Vimeo / YouTube unlisted | Considered as "don't build it" options; user chose to build. |
| Cloudflare R2 / MinIO object storage | Only needed for streaming delivery. |
| An 8 TB HDD for the server | Was specced for storing streaming renditions. That reason no longer exists. |
| AV1 | M1 Max has **no AV1 hardware encoder** (M3+) and no hardware decoder. Software-only at 8K is unusable. |
| User accounts, auth, view statistics, public sharing | Dropped with the hosting platform. Umami already runs on the server if analytics are ever wanted. |
| Serving video files via Pingvin-share *(since added as an **opt-in** upload path at the owner's request — off unless configured; see docs/deploy.md. The disk warning below still applies)* | Inherits the same disk (same `/dev/sda2`, 163 GB free), ToS and uplink problems. A 100 GB share sits on disk until expiry and would fill the root volume, taking down all 27 containers. |

---

## 3. Verified facts

### 3.0 ✅ THE REAL SOURCE FILE — measured, not estimated

> **Superseded:** this file was replaced mid-build by `26 06 TUMJBxUBB HQ.mp4`
> (88.2 GiB), which is identical in video but carries **FLAC + AAC** audio instead
> of the 125 kbps AAC below. See docs/findings.md F6 and §7.3.

`~/Desktop/26 06 TUMJBxUBB.mp4` — a full-length concert recording.

| Property | Value |
|---|---|
| Size | **86.7 GiB** (93,088,461,253 bytes) |
| Duration | **2 h 17 m 42 s** (8261.6 s) |
| Resolution | **8192 × 4096** ← *not* 7680×3840. Still 2:1 equirect. |
| Codec | HEVC **Main 10**, level **180 (6.0)**, `pix_fmt=yuv420p10le` → **10-bit** |
| fourcc | `hvc1` |
| Video bitrate | **90.0 Mbps** (total 90.1) |
| Frames | 247,849 @ 30 fps |
| Audio | AAC LC, **stereo, 44.1 kHz, 125 kbps** ← the weakest link, see §7.3 |
| Chapters | **none** |
| Spherical metadata | **ALREADY PRESENT** — side data `Spherical Mapping`, `projection=equirectangular`, yaw/pitch/roll = 0 |
| Container | `mp42`, uses `co64` (64-bit offsets, required >4 GB) |

**Consequences that change earlier assumptions:**

1. **Storage is ~40 GB per hour**, not the 100 GB/hr previously estimated. A 2 TB drive
   holds roughly **50 hours** of masters. My earlier sizing was ~2.6× too pessimistic.
2. **exiftool is NOT needed.** The file already carries correct equirectangular
   metadata. §5.8 is resolved — drop that step from M1.
3. **The source is 10-bit**, which the browser texture path cannot preserve — see §5.10.
4. **Remuxing is feasible**: 87 GB in, 161 GB free → leaves ~74 GB. Tight but works.
   Still add the 2× free-space guard.
5. Target files are **~8192 px wide**, so hardcode nothing to 7680.

### 3.05 ✅ Lossless extraction is instantaneous

Input-seeking a 20 s clip out of the 87 GB master with `-c copy`:

```
ffmpeg -ss 300 -i master.mp4 -t 20 -c copy -map 0 clip.mp4   →  0.2–0.4 s
```

Use this freely for test fixtures, thumbnails, and preview generation. It is effectively
free and bit-identical.

### 3.1 ✅ 8K 360° playback in a browser works comfortably

Measured on the M1 Max, using a synchronous benchmark (so `requestAnimationFrame`
throttling in a backgrounded tab could not distort it):

| Metric | Result |
|---|---|
| Frame size | **7680 × 3840** (true 8K equirect) |
| Raw frame | 112.5 MB |
| GL texture upload, median | **0.70 ms** |
| GL texture upload, p95 | 1.0 ms |
| Budget for 30 fps | 33.3 ms |
| **Headroom** | **51×** |
| `MAX_TEXTURE_SIZE` | 16384 (WebGL2, ANGLE Metal, M1 Max) |

112 MB in 0.65 ms exceeds plausible copy bandwidth, which proves ANGLE is
**zero-copy binding the hardware-decoded frame as a Metal texture via IOSurface**.
The decoded frame never moves. This is why it is cheap.

Decode was separately confirmed: `videoWidth=7680`, `videoHeight=3840`,
`readyState=4`, 202 frames decoded.

**Re-verified against the REAL file** (8192×4096, HEVC Main 10, **10-bit**, `hvc1`):
played successfully, **0 frames dropped**, texture upload **0.8 ms median / 2.8 ms max**
for a 128 MB frame — still ~33× headroom against the 33.3 ms budget. The higher
resolution and bit depth cost essentially nothing.

### 3.2 ✅ M1 Max encodes 8K HEVC at ~realtime

```
12 seconds of 7680x3840 HEVC via hevc_videotoolbox  →  12.6 s wall clock
```
(and the bottleneck was the software `scale` filter, not the encoder)

### 3.3 ✅ Chapter embedding is lossless and nearly free

Verified round-trip: 3 chapters with titles + `title`/`artist` tags injected with
`-c copy`, read back correctly by ffprobe. **Overhead: 830 bytes.**

### 3.4 ✅ Codec support probe (Chromium on macOS)

| Codec string | Result |
|---|---|
| `video/mp4; codecs="hev1.1.6.L93.B0"` | **probably** |
| `video/mp4; codecs="hvc1"` | **no** ← see §5.3 |
| `video/mp4; codecs="avc1.42E01E"` | probably |
| `video/mp4; codecs="av01.0.08M.08"` | probably (software only on M1 Max) |

Also available: WebRTC + data channels ✅, `showOpenFilePicker` ✅, Wake Lock ✅.

### 3.5 ✅ YouTube IFrame API supports 360° viewport control

```js
player.getSphericalProperties()          // → { yaw, pitch, roll, fov }
player.setSphericalProperties({ yaw, pitch, roll, fov })
//   yaw   [0, 360)    increases turning left
//   pitch [-90, 90]   increases looking up
//   roll  [-180, 180] clockwise positive
//   fov   [30, 120]   default 100
```
This means **the same sync protocol works for YouTube 360° videos** — see §4.4.

### 3.6 ✅ Local disk is the real constraint

```
MacBook:  926 GB total  ·  161 GB free  ·  83% full
Ports:    Thunderbolt 4 / USB-C only  ·  ZERO USB-A ports
```
`-c copy` writes a **new** file, so remuxing a 100 GB master needs ~200 GB free.
**A 100 GB file cannot currently be remuxed on this Mac.**

---

## 4. Architecture

### 4.1 Content pipeline

```
Insta360 camera (.insv, dual-fisheye)
        │
        ▼  Insta360 Studio — stitch + export      ◀── THE ONLY LOSSY STEP
        │                                              (set bitrate high here)
        ▼
equirectangular MP4, 7680×3840 HEVC              ◀── equirect is ALWAYS 2:1 aspect
        │
        ▼  ffmpeg -c copy   (bit-identical, no re-encode)
        │     • retag fourcc hvc1 → hev1
        │     • inject chapters
        │     • exiftool: inject spherical metadata
        ▼
homecast master  +  chapters.json sidecar
        │
        ├──▶ played locally in the browser player
        ├──▶ played in VLC / QuickTime (reads embedded chapters + spherical)
        └──▶ optional: 4K H.264 fallback, encoded on demand only
```

**There is no transcoding in the normal path.** The two required ffmpeg operations are
container rewrites. The 4K H.264 file is the only real encode and it is **conditional** —
produce it only when a specific viewer's machine cannot decode HEVC.

### 4.2 Runtime topology

```
  Your Mac                                    Friend's machine
  ┌──────────────────────┐                   ┌──────────────────────┐
  │ static player page   │                   │ static player page   │
  │ local video file ────┼── never sent ──X  │ their own local copy │
  └───────┬──────────────┘                   └──────────────┬───────┘
          │         WebRTC data channel (peer-to-peer)      │
          │  { t, playing, yaw, pitch, fov, chapterIdx }    │
          └────────────────────┬───────────────────────────-┘
                               │ handshake only (a few KB)
                     ┌─────────▼──────────┐
                     │ leosrv             │
                     │ • static page      │  (a subdomain of the
                     │ • WS signaling     │   owner's own domain, via
                     │                    │   the PaaS + CF tunnel)
                     └────────────────────┘
```

The server carries a ~200 KB page and some SDP blobs. Nothing else. Every
infrastructure constraint in §2 is *eliminated*, not worked around.

### 4.3 Decided behaviour

| Area | Decision |
|---|---|
| **Renderer** | three.js, inverted sphere, `VideoTexture`. Pan by drag + arrow keys. Fullscreen. |
| **Zoom** | FOV-based. Limits **computed** from file resolution × window size: ~3× upscale max in (raised from 2× after use); out past 110° the projection morphs to stereographic, ending in a tiny planet at 250–300°. A **"1:1 native" badge** lights at exact pixel mapping. A modifier key **overrides past the clamps**. |
| **Chapters** | Authored **in-player**: a keypress drops a marker at the current frame, prompts for a name, and **captures the current view direction (yaw/pitch/fov)**. Export writes both the JSON sidecar and an ffmpeg metadata file. |
| **Library** | Grid of videos with locally-generated thumbnails, duration, chapter count, resume position. `FileSystemFileHandle`s persisted in **IndexedDB** so one click reopens a file without re-picking. Local only. |
| **View sync** | **Locked by default**, with an **unlink toggle**. A presence marker shows where the other viewer is looking. |
| **Sessions** | Short room code in the URL, e.g. `/w/7QK2M`. No accounts, no passwords. Rooms expire when empty. |
| **File handoff** | **Out of band — Google Drive** (5 TB per-file limit) or a physical drive. **NOT iCloud** (50 GB per-file cap blocks 100 GB masters). Never through `leosrv`. |
| **Capability probe** | On load, test `canPlayType` + `MAX_TEXTURE_SIZE` and **tell the viewer which file to open**, rather than failing mysteriously. |

### 4.4 YouTube mode

Same rooms, same sync messages, second player adapter behind one interface:

| | Local file adapter | YouTube adapter |
|---|---|---|
| time / state | `<video>.currentTime`, `.play()`, `.pause()` | `seekTo`, `playVideo`, `pauseVideo`, `getCurrentTime`, `getPlayerState` |
| view | three.js camera yaw/pitch/fov | `get/setSphericalProperties` |

Known limitations to handle explicitly:
- **Ads desync viewers** (different people get different ads) → needs a **resync button**
- Some videos **block embedding**; age-restricted/login-gated videos will not play
- YouTube's own docs: 360° on mobile is *"distorted and there is no supported way to change the viewing perspective"*
- YouTube's `fov` range is `[30,120]`, slightly narrower than the local player's

---

## 5. Gotchas that will bite you

Read this section. Each item cost real investigation time.

### 5.1 360° angular resolution — "8K" is not 8K in your view

An 8K equirect frame is 7680 px covering the **entire 360°**:

```
7680 px ÷ 360° = 21.3 pixels per degree
```

You only ever look at ~90° of it, so your visible image is **~1920 px wide**.

| 360° source | px/degree | visible in a 90° view | feels like |
|---|---|---|---|
| 4K (3840) | 10.7 | 960 px | worse than 720p |
| 5.7K (5760) | 16.0 | 1440 px | ~720p |
| **8K (7680)** | **21.3** | **1920 px** | **~1080p** |
| flat 4K video | 64 | 3840 px | 4K |
| human eye limit | ~60 | — | needs 21,600 px wide |

This is true in VLC and YouTube too — it is geometry, not a software flaw. It is also
exactly why the 8K requirement is well-founded: it doubles linear detail vs YouTube's 4K.

Consequence for the zoom UI: on a Retina display at fullscreen (3456 device px) you are
*magnifying* ~1.8× at normal FOV. That is enlargement, not compression.

### 5.2 `MAX_TEXTURE_SIZE` is 4096 on many mobile GPUs

> **Update:** the *page* is now responsive and touch-capable — safe-area insets,
> a toolbar that fits, pinch-to-zoom, double-tap to reset, and a capability
> verdict that says plainly that a phone wants the 4K rendition. The texture
> limit below is unchanged and still decides what a given device can display;
> what changed is that a phone now gets a usable page and an honest answer
> instead of a broken layout. 8K on a phone remains a non-goal.

A 7680 px equirect frame **cannot be bound as a texture** on those devices. Not slow —
impossible. This is why YouTube uses tiled/EAC projections. The M1 Max reports 16384 so
desktop is fine, but **the capability probe must catch this** and route mobile viewers
to a ≤4K file or refuse gracefully.

### 5.3 ⚠️ CORRECTED: `hvc1` DOES work — my earlier finding was a bad test

**An earlier version of this plan claimed Chromium refuses `hvc1`. That was wrong.**

The `"no"` result came from probing the bare string `'video/mp4; codecs="hvc1"'`, which
Chromium rejects as *malformed* (no profile/level). With a complete string it reports
`probably`, and — decisively — **the real 8192×4096 10-bit file played untouched as
`hvc1`, with 0 dropped frames.** Both taggings were tested side by side:

| | `hvc1` (as-is) | `hev1` (retagged) |
|---|---|---|
| played | ✅ | ✅ |
| frames dropped | 0 | 0 |
| texture upload median | 0.8 ms | 1.0 ms |

**Implication: the remux is OPTIONAL, not required.** Keep `-tag:v hev1` as cheap,
harmless insurance for other Chrome builds and for Windows, but do not present it as a
prerequisite. Note also that `canPlayType` is only advisory — always confirm with a real
file. And always pass a **full** codec string when probing:
`hev1.2.4.L180.B0` / `hvc1.2.4.L180.B0` for this Main 10 / level 6.0 content.

### 5.4 Browsers cannot read MP4 chapter atoms

`<video>` exposes no chapter API. Embedded `chpl` atoms are invisible to JS.
**Therefore both outputs are required:**
- embedded chapters → for VLC / QuickTime / Infuse
- JSON sidecar → for the web player

(Alternative: parse the atom client-side with `mp4box.js`. The sidecar is simpler and
also carries the per-chapter view directions, which MP4 has no place for.)

### 5.5 VLC cannot load an *external* chapter file

mpv has `--chapters-file`; VLC does not. So a sidecar-only approach would not work in
VLC. Embedding is the only route to player-agnostic chapters. Hence §5.4's dual output.

### 5.6 `setPixelRatio(devicePixelRatio)` — do not use `1`

The benchmark harness used `setPixelRatio(1)`, which renders at CSS resolution and
throws away half the Retina sharpness. Production must use `devicePixelRatio`.
Given §5.1 you are already pixel-starved; do not discard resolution here.

### 5.7 Equirectangular is always 2:1

8K = **7680×3840**, 4K = **3840×1920** (not 3840×2160). Getting this wrong distorts
the sphere. Note `h264_videotoolbox` caps at 4096 px wide, so 3840 is fine.

### 5.8 ❌ WRONG — see docs/findings.md F1: `-c copy` DROPS the spherical metadata

The master already carries `Spherical Mapping / projection=equirectangular` side data
(§3.0). **No exiftool, no spatial-media injector, no MP4Box.** Drop this from M1.

**Measured: it does not.** ffmpeg's mov *demuxer* reads the box and ffprobe reports it,
but the mov *muxer* never writes one — so every remux, and every lossless extract made
with §3.05's trick, silently produces a file that VLC and QuickTime treat as flat.

The master carries Apple's `vexu`/`proj`/`prji` box (32 bytes inside the `hvc1` sample
entry), **not** the Google spatial-media form, so exiftool and the spatial-media injector
would not have helped. `homecast prepare` re-injects it directly; details in
docs/findings.md F1.

### 5.10 10-bit source → 8-bit texture: the browser loses bit depth

The source is `yuv420p10le` (**10-bit**). `texImage2D` from a `<video>` element yields
`RGBA/UNSIGNED_BYTE` — **8 bits per channel**. There is no standard path to get 10-bit
video data into a float texture from an `HTMLVideoElement`, even though `RGBA16F` and
`EXT_color_buffer_half_float` are both supported on this GPU.

**Practical effect:** possible banding in smooth gradients — skies, stage lighting,
haze — which VLC (rendering 10-bit natively) would not show. This is a genuine, honest
advantage of VLC over the web player for this footage, and a reason to keep the embedded
chapters working in VLC (§5.5) rather than treating the web player as a full replacement.

Do not claim the web player is bit-for-bit equivalent to VLC. It is resolution-equivalent
but not bit-depth-equivalent. Dithering on upload could mask banding if it proves visible.

### 5.9 `requestAnimationFrame` halts in hidden tabs

Cost real debugging time: the first benchmark reported 1.8 fps because the browser pane
reported `visibilityState: hidden`. Any performance measurement must either front the
tab or avoid rAF entirely (the §3.1 numbers used a synchronous loop with `readPixels`
to force a GPU flush).

---

## 6. Implementation milestones

Ordered so each step ships standalone value. **Milestone 1 is useful even if nothing
else is ever built.**

### M1 — ffmpeg toolchain (no UI)
The proven, highest-value-per-effort piece.

- [x] `homecast prepare <input.mp4>` — remux: `-c copy -tag:v hev1`, verify with ffprobe
- [x] Chapter injection from an ffmetadata file (format verified below)
- [x] Spherical metadata injection — **§5.8 was wrong**: `-c copy` does NOT preserve it.
      Not exiftool: the master uses Apple's `vexu` box, which exiftool would not write.
      Implemented as direct MP4 box surgery (`src/cli/mp4.ts`). See docs/findings.md F1.
- [x] `homecast fallback <input>` — on-demand 4K H.264, `3840×1920` (measured 0.48× realtime, F4)
- [x] Guard: refuse to run if free disk < 2× input size (§3.6) — correctly refuses the 87 GB master
- [x] *Added:* `homecast inspect` and `homecast spherical` (repair files already stripped)

**Verified working command** (this exact form round-tripped successfully):
```bash
ffmpeg -i input.mp4 -i chapters.txt \
       -map_metadata 1 -map_chapters 1 \
       -c copy -tag:v hev1 output.mp4
# add -map 0 defensively if stream selection ever misbehaves
```

**Verified ffmetadata chapter format:**
```
;FFMETADATA1
title=Radolfzell Live Set
artist=The Band
[CHAPTER]
TIMEBASE=1/1000
START=0
END=6000
title=Intro
[CHAPTER]
TIMEBASE=1/1000
START=6000
END=13000
title=Song 1 - Opening Riff
```

### M2 — local 360° player (single file, no sync)
- [x] three.js inverted sphere + `VideoTexture`, `setPixelRatio(devicePixelRatio)`
- [x] Drag + arrow-key pan; scroll/PageUp-PageDown zoom
- [x] Computed FOV clamps + **1:1 native badge** + modifier-key override (§4.3)
- [x] Fullscreen, Wake Lock, keyboard shortcuts
- [x] Capability probe with a human-readable verdict (§4.3, §5.2, §5.3)
- [x] *Added:* orientation calibrated against `ffmpeg v360` — yaw 0 = equirect centre,
      yaw increases turning left, pitch increases up, matching §3.5 so M6 can share
      the convention. See test/orientation.md.

Verified against the real 8192×4096 master: 0 dropped frames over 15 s of playback
while continuously panning, 60 fps render loop.

### M3 — library ✅
- [x] `showOpenFilePicker`, persist `FileSystemFileHandle` in IndexedDB
- [x] Re-permission flow (`queryPermission` / `requestPermission` on return visits)
- [x] Thumbnail generation by seek + canvas capture (equirect frame, 480 px JPEG)
- [x] Resume positions, duration, chapter count

The "finished" window is `min(15 s, 5% of duration)`, not a flat 15 s — see
docs/findings.md F8. Resume is decided from the store at `loadedmetadata`, so it
behaves the same whether the file arrived by picker, drop, or library click.

### M4 — chapter edit mode ✅
- [x] Keypress drops a marker at `currentTime`, prompts for a title (`M`)
- [x] **Captures current yaw/pitch/fov with the marker** (and can re-capture per row)
- [x] Chapter bar on the scrubber; click to jump (and restore that view)
- [x] Export → JSON sidecar **and** ffmetadata file for M1
- [x] Import a sidecar someone sent you — button, or drop it on the window

Full loop verified on the real footage: author in the player → export sidecar →
`homecast prepare -c` → embedded chapters read back by ffprobe with `;`, `=` and
`#` escaping intact, both audio tracks and the spherical metadata preserved.

### M5 — watch-together ✅
- [x] WebSocket signalling service (handshake only — **no media, ever**)
- [x] Static page deployed via the PaaS layer to the target subdomain
- [x] WebRTC data channel; room codes `/w/XXXXX`
- [x] Sync `{ t, playing, yaw, pitch, fov }`; locked-by-default + unlink toggle
- [x] Presence marker for the other viewer's gaze, plus an off-screen arrow
- [x] Drift correction / resync

Signalling and the page share one origin, so `wss://` needs no second domain and
no CORS. Two data channels per peer: `control` ordered and reliable, `view`
unordered with no retransmits — a late gaze update is worthless, a lost pause is not.

Three problems had to be solved rather than assumed (docs/findings.md F9–F11):
clocks differ between machines, media events fire asynchronously and echo, and
symmetric drift correction oscillates. Measured after the fixes: **0.08 s apart**,
`playbackRate` back to exactly 1, a forced 3 s drift recovered immediately.

### M6 — YouTube adapter
- [ ] Abstract the player interface behind M2's renderer
- [ ] IFrame API adapter using `get/setSphericalProperties` (§3.5)
- [ ] Resync button for ad drift; graceful handling of embed-blocked videos

---

## 7. Open questions — ASK, do not assume

1. ✅ **ANSWERED — see §3.0.** The master is `~/Desktop/26 06 TUMJBxUBB.mp4`:
   **86.7 GiB, 2 h 17 m, 8192×4096, HEVC Main 10 10-bit, 90 Mbps, stereo AAC 125 kbps,
   no chapters, spherical metadata already present.** Storage runs **~40 GB/hour**, so
   a 2 TB drive holds ~50 hours. The enclosure purchase is justified (only 161 GB free
   on a 926 GB disk, and one master is 87 GB of it) but not urgent.

2. **Windows HEVC support is untested.** Chrome on Windows needs an OS-registered HEVC
   decoder; modern GPU drivers usually provide one but a paid Microsoft Store extension
   is sometimes required. Probe the actual machine before promising 8K there.

3. ✅ **PARTLY ANSWERED — the master was re-exported with two audio tracks.**
   `26 06 TUMJBxUBB HQ.mp4` (88.2 GiB) carries **FLAC stereo 1408 kbps** as track #1
   and **AAC stereo 304 kbps** as track #2. The 125 kbps weak link is gone.

   Measured consequences (docs/findings.md F6):
   - FLAC-in-MP4 **decodes in Chrome**, so the web player gets the lossless track
   - but `audioTracks` is **unsupported in Chrome** — the browser always plays track #1
     and cannot switch, so **track order is the only control**. VLC can switch.
   - both tracks carry **identical content**, so this is "lossless + fallback", not the
     *soundboard mix + camera mic* pairing originally proposed

   Still open: the **soundboard/camera-mic pairing** (needs a second source recording,
   not a re-export) and **ambisonic spatial audio**.

4. **Storage hardware.** User owns a **2 TB M.2 2230 NVMe SSD** but no enclosure.
   If purchased it must be: **USB-C** (the M1 Max has no USB-A), **NVMe/PCIe** (not SATA
   — 2230 drives are always NVMe), **2230-compatible**, and **metal** (thermal
   throttling during long operations). ~€25 for a 10 Gbps RTL9210B/JMS583 unit; a TB4
   enclosure costs 3–4× for no benefit here. Q1 is now answered: at ~40 GB/hour and
   87 GB already committed to one gig, **the purchase is justified** — the Mac has only
   161 GB free. Not blocking, though: M1–M4 can be built against short lossless extracts
   (§3.05).

5. ✅ **ANSWERED — build tooling chosen.** TypeScript + Vite + three.js, no framework.
   The M1 CLI is a Node + TypeScript CLI in the same repo, sharing the chapter sidecar
   schema with the player (`src/shared/chapters.ts`). Node ≥ 22.18 strips types natively,
   so the CLI has no build step.

---

## 8. Environment reference

### Local machine
```
MacBookPro18,2 · Apple M1 Max · 10 cores · 32 GB · macOS 26.6.2 (25G83)
ffmpeg 8.1.2 @ /opt/homebrew/bin/ffmpeg   (hevc_videotoolbox, h264_videotoolbox,
                                           prores_videotoolbox, libx264, libx265, libsvtav1)
ffplay present · mpv NOT installed · exiftool NOT installed
Disk: 926 GB, 161 GB free (83% full)
Ports: Thunderbolt 4 / USB-C only, 40 Gb/s, no USB-A
Installed: VLC 3.0.23, Insta360 Studio
Project dir: /Users/leoxnard/code/homecast   (empty, not a git repo)
```

### Home server — `leosrv`

> Network addresses, service versions and the domain inventory are deliberately
> omitted from this public copy. Everything below is what actually constrains the
> design; none of it is actionable against the machine.

```
2015 laptop, lid closed, on AC (its battery is a free UPS), running Debian 13
Haswell-era quad-core i7 (2014) · integrated GPU · 16 GB RAM soldered
Disk: ~217 GB total, ~163 GB free — ONE bay, already full, not expandable
Network: Wi-Fi only. An Ethernet dongle is plugged in but has no cable attached,
         so it reads NO-CARRIER. Free fix, but needs hands on site in Germany.
Measured: ↑201 Mbps single / 267 Mbps 8-parallel · ↓277 Mbps
          Both converge ~270 Mbps = classic 3x3 802.11ac ceiling, so Ethernet likely helps
Ingress: ports 80/443 are CLOSED. A Cloudflare Tunnel is the only way in.
Already running: ~27 containers — a PaaS layer, a reverse proxy, the tunnel
  daemon, a Postgres stack, object storage, analytics, a file-share app, and
  several small apps. The host is busy and its root volume must not be filled.
Target domain: a subdomain of the owner's existing domain (does not resolve yet)
```

**Why these numbers matter:** the Haswell CPU cannot decode HEVC (§2), the single
full disk rules out storing renditions (§2), the ~270 Mbps Wi-Fi uplink rules out
serving 8K video, and the closed ports force everything through the tunnel — which
is why the architecture ships a ~200 KB page and nothing else (§4.2).

### Cloudflare constraints (Free plan)
- **100 MB request body limit** — irrelevant now, but never route media uploads through it
- **512 MB max cacheable object**
- **ToS §2.8** restricts serving disproportionate non-HTML content; video named explicitly
- All of the above are avoided by never sending video through the server

### Scratch artefacts

The measurements in §3 were taken with short lossless extracts (§3.05), a WebGL
benchmark page, and a chapter round-trip fixture, all in a temporary directory
that no longer exists. `test/orientation.md` documents how to regenerate the
renderer calibration; §3.05 makes new fixtures effectively free.
