/**
 * "A presence marker shows where the other viewer is looking" (PLAN §4.3).
 *
 * The marker is placed on the sphere at the peer's yaw/pitch, so it simply
 * appears in the right part of the scene and leaves the frame when they look
 * elsewhere — no screen-space projection maths, and it stays correct while you
 * pan and zoom.
 *
 * A second, screen-space arrow points toward them while they are out of frame,
 * because a marker you cannot see tells you nothing about where to turn.
 */
import { Group, Sprite, SpriteMaterial, CanvasTexture, Vector3, MathUtils, type Camera } from "three";
import type { PeerGaze } from "./sync.ts";

const MARKER_COLORS = ["#4da3ff", "#6ee7a8", "#ffcc66", "#ff9de2", "#9d8bff"];
/** Same radius family as the video sphere (500), just inside it. */
const MARKER_RADIUS = 440;

function markerTexture(color: string, label: string): CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.translate(size / 2, size / 2);

    ctx.beginPath();
    ctx.arc(0, 0, 30, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 6;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, 8, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    if (label) {
      ctx.font = "bold 26px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = color;
      ctx.fillText(label, 0, 48);
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

/** Same yaw/pitch convention as the camera (test/orientation.md). */
function directionFor(yaw: number, pitch: number): Vector3 {
  const y = MathUtils.degToRad(yaw);
  const p = MathUtils.degToRad(pitch);
  const cosP = Math.cos(p);
  return new Vector3(-Math.sin(y) * cosP, Math.sin(p), -Math.cos(y) * cosP);
}

interface Marker {
  sprite: Sprite;
  texture: CanvasTexture;
}

export class Presence {
  readonly group = new Group();
  private readonly markers = new Map<string, Marker>();
  private readonly arrow: HTMLElement;
  private colorIndex = 0;
  private readonly colorFor = new Map<string, string>();

  constructor(overlayParent: HTMLElement) {
    this.arrow = document.createElement("div");
    this.arrow.className = "gaze-arrow";
    this.arrow.hidden = true;
    overlayParent.append(this.arrow);
  }

  private color(id: string): string {
    let c = this.colorFor.get(id);
    if (!c) {
      c = MARKER_COLORS[this.colorIndex++ % MARKER_COLORS.length] ?? "#4da3ff";
      this.colorFor.set(id, c);
    }
    return c;
  }

  update(gazes: PeerGaze[]): void {
    const seen = new Set<string>();

    for (const gaze of gazes) {
      seen.add(gaze.id);
      let marker = this.markers.get(gaze.id);
      if (!marker) {
        const texture = markerTexture(this.color(gaze.id), "");
        const sprite = new Sprite(new SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
        sprite.scale.setScalar(70);
        sprite.renderOrder = 10;
        this.group.add(sprite);
        marker = { sprite, texture };
        this.markers.set(gaze.id, marker);
      }
      marker.sprite.position.copy(directionFor(gaze.yaw, gaze.pitch).multiplyScalar(MARKER_RADIUS));
    }

    for (const [id, marker] of this.markers) {
      if (seen.has(id)) continue;
      this.group.remove(marker.sprite);
      marker.sprite.material.dispose();
      marker.texture.dispose();
      this.markers.delete(id);
    }

    if (!gazes.length) this.arrow.hidden = true;
  }

  /**
   * Point at the first off-screen peer. Called each frame, after the camera has
   * been oriented, so the arrow tracks as you turn.
   */
  updateArrow(camera: Camera, canvas: HTMLCanvasElement): void {
    const first = [...this.markers.values()][0];
    if (!first) {
      this.arrow.hidden = true;
      return;
    }

    const projected = first.sprite.position.clone().project(camera);
    const inFront = projected.z < 1;
    const onScreen = inFront && Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1;
    if (onScreen) {
      this.arrow.hidden = true;
      return;
    }

    // Behind the camera, the projection mirrors; flip it so the arrow points
    // the short way round instead of confidently the wrong way.
    const x = inFront ? projected.x : -projected.x;
    const y = inFront ? projected.y : -projected.y;

    const angle = Math.atan2(y, x);
    const rect = canvas.getBoundingClientRect();
    const radius = Math.min(rect.width, rect.height) * 0.36;
    this.arrow.hidden = false;
    this.arrow.style.transform =
      `translate(-50%, -50%) translate(${rect.width / 2 + Math.cos(angle) * radius}px, ` +
      `${rect.height / 2 - Math.sin(angle) * radius}px) rotate(${-angle}rad)`;
  }

  hideArrow(): void {
    this.arrow.hidden = true;
  }

  clear(): void {
    this.update([]);
    this.arrow.hidden = true;
  }
}
