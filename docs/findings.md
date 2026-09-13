# Findings — corrections and additions to PLAN.md

Measured during implementation. Each entry says what the plan assumed, what is
actually true, and what the code does about it.

---

## F1. `-c copy` does NOT preserve spherical metadata — §5.8 is wrong

**Plan §5.8** ("RESOLVED: spherical metadata is already in the file") concluded that
no injection step is needed, and asked only that we *verify* `-c copy` carries the
side data through. It does not.

```
master                    → side_data_list: [{ Spherical Mapping, equirectangular }]
ffmpeg -i master -t 5 -c copy out.mp4  → side_data_list: NONE
ffmpeg -ss 60 -i master -t 5 -c copy   → side_data_list: NONE
```

ffmpeg's mov **de**muxer reads the box and ffprobe reports it, but the mov **muxer**
has no code to write one. So *every* remux — and every lossless extract made with
§3.05's trick — silently produces a file that VLC and QuickTime treat as a flat 2:1
image. The metadata loss is invisible unless you probe for it.

**Which box the master actually uses.** Not the Google spatial-media form the plan's
"spatial-media injector" fallback would write. The Insta360 master carries Apple's
`vexu`, 32 bytes inside the `hvc1` sample entry:

```
moov > trak > mdia > minf > stbl > stsd > hvc1 > vexu > proj > prji('equi')
00 00 00 20 76 65 78 75  00 00 00 18 70 72 6f 6a
00 00 00 10 70 72 6a 69  00 00 00 00 65 71 75 69
```

**What the code does.** `src/cli/mp4.ts` + `src/cli/spherical.ts` re-inject the box
after ffmpeg runs, and `prepare` / `fallback` do it automatically. exiftool is still
not needed — it would not write `vexu` anyway.

The insertion is cheap because ffmpeg writes `moov` **last**: growing it cannot move
`mdat`, so no chunk offset in `stco`/`co64` has to be patched and only the file's
tail is rewritten. This is also why `fallback` no longer passes `-movflags +faststart`
— a leading `moov` could not be grown this way. Local playback does not need it.

We write both box families, since players disagree:
- `vexu` — Apple: QuickTime, iOS 18+. Copied byte-for-byte from the source when
  available, so the output is at least at parity with the input.
- `st3d` + `sv3d` — Google spatial-media: what VLC 3 reads. Added as insurance
  (`--no-sv3d` to skip).

Verified: +130 bytes, chapters intact, decodes clean, `ffprobe` reports
`Spherical Mapping / equirectangular` again.

---

## F2. `hvc1` plays as-is — §5.3's correction confirmed

Re-confirmed on the real master. The retag to `hev1` is kept as cheap insurance and
is on by default (`--no-retag` to skip), but it is not a prerequisite.

`inspect` emits the **full** codec string for a real `canPlayType` probe, as §5.3
insists — for this Main 10 / level 6.0 content: `hvc1.2.4.L180.B0`.

---

## F3. Free disk is now 90 GB, not the 161 GB in §8

The master is 86.7 GiB, so the 2× guard (§3.6) refuses to remux it in place — as
designed. Measured:

```
✗ not enough free disk: 90.7 GiB available, 173 GiB required (2× the 86.7 GiB input).
```

The enclosure in §7.4 is the fix. Until then, work against lossless extracts (§3.05),
which are effectively free — 30 s of the master extracts in 0.6 s.

---

## F4. The 4K fallback encode runs at ~0.5× realtime, not realtime

§3.2 measured `hevc_videotoolbox` at ~realtime, and noted the software `scale` filter
was the bottleneck. The fallback path pays that cost in full: downscaling 8192×4096
10-bit to 3840×1920 measured **0.48× realtime**.

For the 2 h 17 m master that is roughly **4.8 hours**. Still a one-off, still
conditional (§4.1), but do not promise it as a quick operation.

---

## F5. Chapter escaping needed handling ffmpeg does not document loudly

`=`, `;`, `#` and `\` must be backslash-escaped in ffmetadata or the file parses
wrong. `toFfmetadata()` escapes them; verified by round-tripping the title
`Crowd; test = escape; #hash` through embed → ffprobe → sidecar unchanged.

---

## F6. The master changed mid-build — it now carries two audio tracks

`~/Desktop/26 06 TUMJBxUBB.mp4` (86.7 GiB, AAC 125 kbps) was replaced during
implementation by `26 06 TUMJBxUBB HQ.mp4` — **88.2 GiB**, same 8192×4096 HEVC
Main 10 at 90 Mbps, but the audio is now:

| track | codec | bitrate |
|---|---|---|
| #1 | **FLAC** stereo 44.1 kHz | 1408 kbps |
| #2 | AAC stereo 44.1 kHz | 304 kbps |

This answers **PLAN §7.3** — the "multiple audio tracks" option was taken, and
the 125 kbps weak link is gone. A 3 m 46 s `HQ test.mp4` sits alongside it.

Three things measured about this, because they change what the player can promise:

**FLAC-in-MP4 decodes in Chrome.** Probed and confirmed by playing a FLAC-only
extract: `audio/mp4; codecs="flac"` reports `probably`, and a single-track FLAC
file plays with audio at full level (peak 0.73). So the web player gets the
lossless track, not a downgrade.

**But the browser cannot switch tracks.** `HTMLMediaElement.audioTracks` is
**unsupported in Chrome** — it is not merely empty, the property does not exist.
The browser plays whichever track is first and offers no way to choose. VLC can
switch freely. **Track order therefore matters**: whatever should be the default
must be track #1. It currently is (FLAC). `homecast inspect` warns when a file
has more than one audio track, for exactly this reason.

**Both tracks carry the same content.** Measured identical levels
(mean −18.2 dB, max −1.6 dB over the same window). So this is "lossless plus a
compatible fallback", *not* the soundboard-mix-plus-camera-mic pairing §7.3
described as the biggest perceptual win. That option is still open and still
nearly free in ffmpeg — it needs a second source recording, not a re-export.

## F7. ffmpeg's chapter text track accumulates on every `prepare` run

Embedding chapters makes ffmpeg write a QuickTime **chapter text track** next to
the chapter metadata — that track is how VLC and QuickTime actually surface
chapters, so it is wanted. The problem is re-running:

```
prepare once   → video, flac, aac, data(text)
prepare twice  → video, flac, aac, data(gpmd), data(text)   ← one per run
```

`-map 0` copies the existing text track through, and the muxer then adds a fresh
one. Worse, **the copied track is re-tagged**: `text` becomes `gpmd`, so a
filter matching on the tag drops only the newest one and leaves the pile.

The handler name survives the copy, so `prepare` now drops any data stream
tagged `text` **or** handled by `SubtitleHandler` before remuxing, and lets the
muxer regenerate exactly one. Verified stable across four consecutive runs:
4 streams, 1 data track, 3 chapters. A genuine telemetry stream carries its own
handler name and is preserved.

`prepare` also now fails verification if more than one chapter text track ends up
in the output, so a future regression surfaces rather than quietly accumulating.

## F8. Resume windows must scale with duration

Marking a video "finished" when the playhead is within a flat 15 s of the end is
right for a 2 h 17 m concert and wrong for a 40 s clip, where it means anything
past 25 s never resumes. The window is now `min(15 s, 5% of duration)`.

---

## F9. Media events are asynchronous, so they echo — and the echo compounds

`video.play()` and `.pause()` emit their events **after** the call returns. A
synchronous "I am applying a remote action, do not rebroadcast" flag is therefore
already cleared by the time the event fires, so applying a peer's play echoed it
straight back to them.

That alone would be harmless ping-pong. It was not harmless, because every hop
re-applies latency compensation: `currentTime = theirTime + age`. Each round trip
added another `age`. Measured before the fix: **two viewers 4.8 s apart within
seconds of pressing play**, then stable at that offset — which looks like a
tuning problem and is actually a feedback loop.

Fixed with a short suppression *window* (`ECHO_WINDOW_MS`) rather than a flag.
A deliberate action inside that window is lost, but the 1 Hz state broadcast
picks it up immediately.

## F10. Symmetric drift correction oscillates — somebody has to own the timeline

If every peer corrects toward every other peer, they chase each other. There is
no stable point, and adding damping only slows the wobble.

One peer must own the timeline. Rather than negotiate it, **the lowest peer id
wins**: every peer computes the same answer from the room roster, it needs no
messages, and it survives someone leaving. Control actions (play, pause, seek)
stay symmetric — anyone can act — but only the owner's `state` heartbeat is used
to correct drift, and the owner ignores everyone else's.

## F11. A 4% rate nudge is audible on music, and hysteresis is required

Easing a playhead into alignment by nudging `playbackRate` is the right idea, but
the first implementation had two faults:

1. **No hysteresis.** Correction started and stopped at the same threshold, so a
   correction landing near it oscillated in and out and the rate never came back
   to 1 — measured stuck at 1.04 indefinitely. Now easing starts at 0.15 s and
   does not stop until inside 0.05 s.
2. **Too much authority.** 4% is fine for speech and clearly audible on sustained
   music, which is exactly what this player is for. Capped at 2%, with
   `preservesPitch` set explicitly.

Large gaps still hard-seek — being a second apart is worse than one visible jump.
Verified: a forced 3 s drift snapped back at once and settled 0.08 s apart with
the rate at exactly 1.

---

## F12. Absolutely-positioned HUD rows collide on a phone

The HUD was three absolutely-positioned boxes — top bar, view readout at
`top: 58px`, transport at the bottom. That is fine at 1440 px and wrong at 375 px:
the toolbar ran off the right edge (Fullscreen entirely off-screen), the title
wrapped to three lines, and the readout sat on top of the buttons.

The fix was structural rather than a pile of breakpoints: the HUD is now a flex
**column**, so rows cannot overlap at any width. Breakpoints then only handle
what genuinely differs on a small screen — shorter button labels, a single-column
spec list, tighter type.

Three mobile-specific things the desktop build had simply never needed:

- **Safe areas.** Without `viewport-fit=cover` plus `env(safe-area-inset-*)`, the
  transport sits under the home indicator and the toolbar under the notch.
- **Pinch-to-zoom.** Zoom was wheel- and key-only, so on a phone there was no way
  to zoom *at all* — the single most important control in a 360° player, missing.
  Two-pointer tracking now drives FOV, and double-tap resets the view.
- **`pointer: coarse`.** Tap targets were sized for a mouse; they now have a
  40 px minimum, and the library's hover-only remove button is always visible
  since there is no hover.

**Second pass.** Fixing the overlap was not enough — the first thing a visitor
saw was still a floating card of diagnostics whose edge cut through the toolbar
behind it. On a phone the welcome screen is now a full-height sheet with the
player chrome hidden behind it (there is nothing to transport-control before a
file is open), one primary action, the verdict as a single line with a coloured
dot, and every technical row folded into a `<details>` disclosure. The lesson is
that "make it responsive" and "make it presentable" are different jobs; the
first is measurable, the second needs someone to look at it.
