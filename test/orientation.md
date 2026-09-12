# Orientation calibration

The inverted-sphere renderer has two easy ways to be wrong that both *look*
plausible on stage footage: a horizontal mirror, and a yaw offset. Eyeballing a
concert frame cannot tell them apart — during M2 an apparent "mirror" turned out
to be a 90° offset instead. So the convention is pinned against a reference
renderer rather than judged by eye.

**Reference:** `ffmpeg`'s `v360` filter, projecting the same frame from
equirectangular to rectilinear. It is independent of our code and of three.js.

## Method

Extract a frame and build references (256×192, 4:3 → vertical FOV 90° means
horizontal FOV `2·atan(tan(45°)·4/3)` = 106.26°):

```bash
ffmpeg -ss 5 -i clip.mp4 -frames:v 1 frame.png
ffmpeg -i frame.png -vf "v360=equirect:flat:h_fov=106.26:v_fov=90:yaw=0:pitch=0:w=256:h=192" ref0.png
# ...and for yaw 90 / 180 / -90, pitch ±30, plus an `,hflip` variant to test for mirroring.
# note: v360 takes yaw in [-180,180] — use -90, not 270.
```

Capture the player at matching angles (`?src=` dev hook, then in the console):

```js
const h = window.__homecast;
h.video.currentTime = 5; h.video.pause();
const grab = (yaw, pitch) => {
  h.viewer.look(yaw, pitch); h.viewer.setFov(90, true);
  h.viewer.render();                    // render immediately: no preserveDrawingBuffer
  const c = document.createElement('canvas'); c.width = 256; c.height = 192;
  c.getContext('2d').drawImage(h.viewer.renderer.domElement, 0, 0, 256, 192);
  return c.toDataURL('image/png');
};
```

Compare at 64×48 greyscale by mean absolute pixel difference.

## Result (verified)

| capture | matches | diff | mirrored reference |
|---|---|---|---|
| player yaw 0 | v360 yaw 0 | 1.0 | 40.3 |
| player yaw 90 | v360 yaw −90 | 0.8 | — |
| player yaw 180 | v360 yaw 180 | 0.9 | — |
| player yaw 270 | v360 yaw 90 | 1.0 | 40.3 |
| player pitch +30 | v360 pitch +30 | 1.0 | — |
| player pitch −30 | v360 pitch −30 | 0.9 | — |

A diff of ~1.0 is resampling noise; the mirrored hypothesis sits at 40+, so it is
firmly excluded.

**Convention confirmed**, and it is the one §3.5 specifies for YouTube — which is
what lets the same sync message drive both players in M6:

- yaw 0 looks at the **centre column** of the equirect frame
- yaw **increases turning left** (opposite to `v360`'s yaw)
- pitch **increases looking up** (same sense as `v360`)

`SphereGeometry` puts the frame's centre at −X once inverted, so `viewer.ts`
rotates the geometry −90° about Y to bring it to −Z, which is where yaw 0 looks.

## Re-running after renderer changes

Any change to the sphere, the camera, or the yaw/pitch maths should re-run this.
A regression shows up as a best match against the wrong reference, not as a
larger diff against the right one.
