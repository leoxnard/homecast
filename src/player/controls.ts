/**
 * Pointer, keyboard and wheel input → viewer state (PLAN §4.3, M2).
 *
 * Drag sensitivity scales with FOV so a given hand movement covers the same
 * fraction of the screen whether you are zoomed in or out.
 */
import type { Viewer } from "./viewer.ts";

export interface ControlCallbacks {
  onViewChange?: () => void;
  onTogglePlay?: () => void;
  onSeek?: (deltaSeconds: number) => void;
  onSeekTo?: (fraction: number) => void;
  onChapterStep?: (direction: -1 | 1) => void;
  onToggleFullscreen?: () => void;
  onToggleHelp?: () => void;
  onOpenFile?: () => void;
  onMarkChapter?: () => void;
  onShowLibrary?: () => void;
  onShowChapters?: () => void;
  onShowRoom?: () => void;
  onTogglePlanet?: () => void;
}

/** Held to push past the computed FOV clamps (§4.3). */
const isUnlockModifier = (e: { altKey: boolean }) => e.altKey;

const PAN_STEP_DEG = 4;
/**
 * Zoom is multiplicative: the range now runs from a few degrees to a 300° tiny
 * planet, and a fixed step would crawl at one end and jump at the other.
 */
const ZOOM_KEY_FACTOR = 1.06;

export class Controls {
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private pointerId?: number;
  private readonly disposers: Array<() => void> = [];
  /** Live touch points, for pinch-to-zoom (there is no wheel on a phone). */
  private readonly touches = new Map<number, { x: number; y: number }>();
  private pinchStartDistance = 0;
  private pinchStartFov = 0;

  private readonly viewer: Viewer;
  private readonly element: HTMLElement;
  private readonly cb: ControlCallbacks;

  constructor(viewer: Viewer, element: HTMLElement, cb: ControlCallbacks = {}) {
    this.viewer = viewer;
    this.element = element;
    this.cb = cb;
    this.bind();
  }

  private changed(): void {
    this.cb.onViewChange?.();
  }

  private bind(): void {
    const el = this.element;

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === "touch") this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // A second finger starts a pinch and cancels the drag it would otherwise
      // be interpreted as.
      if (this.touches.size === 2) {
        this.dragging = false;
        this.pinchStartDistance = this.touchDistance();
        this.pinchStartFov = this.viewer.fov;
        return;
      }
      if (e.button !== 0) return;
      this.dragging = true;
      this.pointerId = e.pointerId;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      // Throws if the pointer is already gone; not worth losing the drag over.
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* capture is an optimisation, not a requirement */
      }
      el.classList.add("dragging");
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType === "touch" && this.touches.has(e.pointerId)) {
        this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      if (this.touches.size === 2) {
        const distance = this.touchDistance();
        if (this.pinchStartDistance > 0 && distance > 0) {
          // Spreading fingers narrows the field of view, i.e. zooms in.
          this.viewer.zoomTo(this.pinchStartFov * (this.pinchStartDistance / distance), false);
          this.changed();
        }
        return;
      }
      if (!this.dragging || e.pointerId !== this.pointerId) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;

      // Degrees per CSS pixel at the current zoom.
      // Capped so a tiny planet turns at a sane speed instead of spinning away.
      const perPixel = Math.min(this.viewer.fov, 110) / (el.clientHeight || 1);
      this.viewer.look(this.viewer.yaw + dx * perPixel, this.viewer.pitch + dy * perPixel);
      this.changed();
    };

    const endDrag = (e: PointerEvent) => {
      this.touches.delete(e.pointerId);
      if (this.touches.size < 2) this.pinchStartDistance = 0;
      if (e.pointerId !== this.pointerId) return;
      this.dragging = false;
      this.pointerId = undefined;
      try {
        el.releasePointerCapture?.(e.pointerId);
      } catch {
        /* already released */
      }
      el.classList.remove("dragging");
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Trackpads report small deltas continuously; mice report ~100 per notch.
      const step = Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY) * 0.0016, 0.1);
      this.viewer.zoomTo(this.viewer.fov * Math.exp(step), isUnlockModifier(e));
      this.changed();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      const unlocked = isUnlockModifier(e);
      const pan = e.shiftKey ? PAN_STEP_DEG * 3 : PAN_STEP_DEG;
      let handled = true;

      switch (e.key) {
        case "ArrowLeft":  this.viewer.look(this.viewer.yaw + pan, this.viewer.pitch); break;
        case "ArrowRight": this.viewer.look(this.viewer.yaw - pan, this.viewer.pitch); break;
        case "ArrowUp":    this.viewer.look(this.viewer.yaw, this.viewer.pitch + pan); break;
        case "ArrowDown":  this.viewer.look(this.viewer.yaw, this.viewer.pitch - pan); break;

        case "PageUp":
        case "+":
        case "=": this.viewer.zoomTo(this.viewer.fov / ZOOM_KEY_FACTOR, unlocked); break;
        case "PageDown":
        case "-":
        case "_": this.viewer.zoomTo(this.viewer.fov * ZOOM_KEY_FACTOR, unlocked); break;

        case " ": this.cb.onTogglePlay?.(); break;
        case "j": this.cb.onSeek?.(-10); break;
        case "l": this.cb.onSeek?.(10); break;
        case "k": this.cb.onTogglePlay?.(); break;
        case ",": this.cb.onSeek?.(-1 / 30); break;
        case ".": this.cb.onSeek?.(1 / 30); break;
        case "[": this.cb.onChapterStep?.(-1); break;
        case "]": this.cb.onChapterStep?.(1); break;
        case "m": this.cb.onMarkChapter?.(); break;
        case "b": this.cb.onShowLibrary?.(); break;
        case "c": this.cb.onShowChapters?.(); break;
        case "w": this.cb.onShowRoom?.(); break;
        case "f": this.cb.onToggleFullscreen?.(); break;
        case "o": this.cb.onOpenFile?.(); break;
        case "?": this.cb.onToggleHelp?.(); break;
        case "r": this.viewer.look(0, 0); this.viewer.setFov(100); break;
        case "p": this.cb.onTogglePlanet?.(); break;
        case "Home": this.cb.onSeekTo?.(0); break;
        case "End": this.cb.onSeekTo?.(0.999); break;
        default:
          if (/^[0-9]$/.test(e.key)) this.cb.onSeekTo?.(Number(e.key) / 10);
          else handled = false;
      }

      if (handled) {
        e.preventDefault();
        this.changed();
      }
    };

    const add = <K extends keyof HTMLElementEventMap>(
      t: HTMLElement | Window,
      type: K | string,
      fn: EventListenerOrEventListenerObject,
      opts?: AddEventListenerOptions,
    ) => {
      t.addEventListener(type, fn, opts);
      this.disposers.push(() => t.removeEventListener(type, fn, opts));
    };

    add(el, "pointerdown", onPointerDown as EventListener);
    add(el, "pointermove", onPointerMove as EventListener);
    add(el, "pointerup", endDrag as EventListener);
    add(el, "pointercancel", endDrag as EventListener);
    add(el, "wheel", onWheel as EventListener, { passive: false });
    add(window, "keydown", onKeyDown as EventListener);
    this.bindDoubleTap(el);
  }

  private touchDistance(): number {
    const [a, b] = [...this.touches.values()];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /** Double-tap resets the view, mirroring the R key. */
  private bindDoubleTap(el: HTMLElement): void {
    let lastTap = 0;
    const onTap = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      const now = Date.now();
      if (now - lastTap < 300 && this.touches.size === 0) {
        this.viewer.look(0, 0);
        this.viewer.setFov(100);
        this.changed();
        lastTap = 0;
      } else {
        lastTap = now;
      }
    };
    el.addEventListener("pointerup", onTap as EventListener);
    this.disposers.push(() => el.removeEventListener("pointerup", onTap as EventListener));
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
  }
}
