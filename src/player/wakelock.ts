/** Keep the display awake during playback (PLAN §3.4 confirmed Wake Lock is available). */
export class WakeLock {
  private sentinel?: WakeLockSentinel;

  async acquire(): Promise<void> {
    if (!("wakeLock" in navigator) || this.sentinel) return;
    try {
      this.sentinel = await navigator.wakeLock.request("screen");
      this.sentinel.addEventListener("release", () => (this.sentinel = undefined));
    } catch {
      // Denied or unavailable (not focused, battery saver). Not worth surfacing.
    }
  }

  async release(): Promise<void> {
    await this.sentinel?.release().catch(() => {});
    this.sentinel = undefined;
  }

  /** Re-acquire after the tab comes back — the lock is dropped when hidden. */
  bindVisibility(shouldHold: () => boolean): void {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && shouldHold()) void this.acquire();
    });
  }
}
