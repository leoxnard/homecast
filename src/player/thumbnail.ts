/**
 * Thumbnails, generated locally by seek + canvas capture (PLAN M3).
 *
 * Nothing is sent anywhere; the frame is drawn from the already-decoded video
 * element straight into a 2D canvas and stored as a JPEG blob in IndexedDB.
 */

const THUMB_WIDTH = 480;

export interface Thumbnail {
  blob: Blob;
  /** the timestamp the frame was taken from */
  at: number;
}

/**
 * Capture one frame. Seeks to `at` (default: 8% in, which skips the black
 * lead-in most exports start with) and restores the playhead afterwards.
 *
 * The draw downsamples an 8192×4096 frame in one go. It is not free, but it
 * happens once per file rather than per render.
 */
export async function captureThumbnail(
  video: HTMLVideoElement,
  grab: (width: number) => Promise<Blob | undefined>,
  at?: number,
): Promise<Thumbnail | undefined> {
  if (!video.videoWidth || !Number.isFinite(video.duration)) return undefined;

  const wasPaused = video.paused;
  const previousTime = video.currentTime;
  const target = at ?? Math.min(video.duration * 0.08, 30);

  try {
    if (!wasPaused) video.pause();
    await seekTo(video, target);

    // One decoded frame must reach the element after the seek before it can be read.
    await nextFrame(video);
    const blob = await grab(THUMB_WIDTH);
    return blob ? { blob, at: target } : undefined;
  } catch {
    return undefined;
  } finally {
    await seekTo(video, previousTime).catch(() => {});
    if (!wasPaused) await video.play().catch(() => {});
  }
}

function nextFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    if ("requestVideoFrameCallback" in video) {
      const timer = setTimeout(resolve, 1000); // a paused element may not present another frame
      video.requestVideoFrameCallback(() => {
        clearTimeout(timer);
        resolve();
      });
    } else {
      setTimeout(resolve, 150);
    }
  });
}

function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (Math.abs(video.currentTime - time) < 0.05) return resolve();
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("seek timed out"));
    }, 8000);
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
    };
    video.addEventListener("seeked", onSeeked, { once: true });
    video.currentTime = time;
  });
}
