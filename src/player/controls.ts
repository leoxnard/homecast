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
}

/** Held to push past the computed FOV clamps (§4.3). */
const isUnlockModifier = (e: { altKey: boolean }) => e.altKey;

const PAN_STEP_DEG = 4;
const ZOOM_STEP_DEG = 4;

export class Controls {
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private pointerId?: number;
  private readonly disposers: Array<() => void> = [];

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
      if (e.button !== 0) return;
      this.dragging = true;
      this.pointerId = e.pointerId;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
      el.classList.add("dragging");
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!this.dragging || e.pointerId !== this.pointerId) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;

      // Degrees per CSS pixel at the current zoom.
      const perPixel = this.viewer.fov / (el.clientHeight || 1);
      this.viewer.look(this.viewer.yaw + dx * perPixel, this.viewer.pitch + dy * perPixel);
      this.changed();
    };

    const endDrag = (e: PointerEvent) => {
      if (e.pointerId !== this.pointerId) return;
      this.dragging = false;
      this.pointerId = undefined;
      el.releasePointerCapture?.(e.pointerId);
      el.classList.remove("dragging");
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Trackpads report small deltas continuously; mice report ~100 per notch.
      const step = Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY) * 0.05, 6);
      this.viewer.setFov(this.viewer.fov + step, isUnlockModifier(e));
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
        case "=": this.viewer.setFov(this.viewer.fov - ZOOM_STEP_DEG, unlocked); break;
        case "PageDown":
        case "-":
        case "_": this.viewer.setFov(this.viewer.fov + ZOOM_STEP_DEG, unlocked); break;

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
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
  }
}
