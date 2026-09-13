/**
 * The 360° renderer: an inverted sphere with the video mapped onto its inside,
 * and a camera at the centre (PLAN §4.3, M2).
 */
import {
  Mesh, PerspectiveCamera, Scene, SphereGeometry, MeshBasicMaterial,
  VideoTexture, WebGLRenderer, SRGBColorSpace, LinearFilter, MathUtils,
} from "three";

export interface ViewState {
  /** degrees, [0, 360) — increases turning LEFT, matching YouTube (§3.5) */
  yaw: number;
  /** degrees, [-90, 90] — increases looking UP */
  pitch: number;
  /** degrees, vertical field of view */
  fov: number;
}

export interface FovLimits {
  /** widest allowed view — the plan's ~110° zoom-out stop */
  max: number;
  /** narrowest allowed view: the FOV at which we upscale the source MAX_UPSCALE× */
  min: number;
  /** FOV at exact 1:1 pixel mapping; the "native" badge lights here */
  native: number;
}

/** Absolute stops the modifier key unlocks past the computed clamps (§4.3). */
const HARD_MIN_FOV = 5;
/**
 * How far past 1:1 the normal zoom goes. The plan started at 2×, which proved
 * too tight for reading detail on stage; 3× is still soft rather than blocky
 * with linear filtering. ⌥ goes further.
 */
export const MAX_UPSCALE = 3;
const HARD_MAX_FOV = 140;

export const DEFAULT_FOV = 100;

export class Viewer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  private readonly mesh: Mesh;
  private texture?: VideoTexture;
  private video?: HTMLVideoElement;

  yaw = 0;
  pitch = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
    // §5.6: never setPixelRatio(1) — that throws away half the Retina sharpness,
    // and §5.1 shows we are already pixel-starved.
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.camera = new PerspectiveCamera(DEFAULT_FOV, 1, 0.1, 1100);

    const geometry = new SphereGeometry(500, 96, 64);
    geometry.scale(-1, 1, 1); // turn it inside out so we see the inner surface
    // Inverting puts the equirect frame's centre column at -X, but yaw 0 must
    // look at it (the frame centre is "front", and §3.5's YouTube convention
    // depends on that). Rotate the sphere a quarter turn so it lands on -Z.
    // Calibrated against `ffmpeg v360=equirect:flat` — see test/orientation.md.
    geometry.rotateY(-Math.PI / 2);
    this.mesh = new Mesh(geometry, new MeshBasicMaterial({ color: 0x000000 }));
    this.scene.add(this.mesh);
    this.resize();
  }

  attachVideo(video: HTMLVideoElement): void {
    this.detachVideo();
    this.video = video;
    const texture = new VideoTexture(video);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter; // no mipmaps: the frame changes every tick
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = false;
    this.texture = texture;
    (this.mesh.material as MeshBasicMaterial).dispose();
    this.mesh.material = new MeshBasicMaterial({ map: texture });
  }

  detachVideo(): void {
    this.texture?.dispose();
    this.texture = undefined;
    this.video = undefined;
  }

  /** Source pixels per degree, vertically. Equirect height covers exactly 180°. */
  sourcePixelsPerDegree(): number | undefined {
    const h = this.video?.videoHeight;
    return h ? h / 180 : undefined;
  }

  /** Rendered device pixels per degree at the current FOV. */
  renderedPixelsPerDegree(fov = this.camera.fov): number {
    const heightDevicePx = this.renderer.domElement.height;
    return heightDevicePx / fov;
  }

  /** >1 means the source is being magnified; <1 means it is being downsampled. */
  magnification(fov = this.camera.fov): number | undefined {
    const src = this.sourcePixelsPerDegree();
    return src ? this.renderedPixelsPerDegree(fov) / src : undefined;
  }

  /**
   * §4.3: limits *computed* from file resolution × window size, not hardcoded.
   * `native` is the FOV where one source pixel lands on one device pixel; `min`
   * is where we are upscaling 2×; `max` is the plan's ~110° stop.
   */
  fovLimits(): FovLimits {
    const src = this.sourcePixelsPerDegree();
    if (!src) return { max: 110, min: 30, native: DEFAULT_FOV };
    const native = this.renderer.domElement.height / src;
    return {
      max: Math.min(110, HARD_MAX_FOV),
      min: Math.max(HARD_MIN_FOV, native / MAX_UPSCALE),
      native,
    };
  }

  /** True when we are within ~1.5% of exact pixel mapping. */
  isNative(): boolean {
    const m = this.magnification();
    return m !== undefined && Math.abs(m - 1) < 0.015;
  }

  setFov(fov: number, unlocked = false): void {
    const limits = this.fovLimits();
    const lo = unlocked ? HARD_MIN_FOV : Math.min(limits.min, limits.max);
    const hi = unlocked ? HARD_MAX_FOV : Math.max(limits.min, limits.max);
    this.camera.fov = MathUtils.clamp(fov, lo, hi);
    this.camera.updateProjectionMatrix();
  }

  get fov(): number {
    return this.camera.fov;
  }

  look(yaw: number, pitch: number): void {
    this.yaw = ((yaw % 360) + 360) % 360;
    this.pitch = MathUtils.clamp(pitch, -89.9, 89.9);
  }

  get state(): ViewState {
    return { yaw: this.yaw, pitch: this.pitch, fov: this.camera.fov };
  }

  set state(s: ViewState) {
    this.look(s.yaw, s.pitch);
    this.setFov(s.fov, true);
  }

  /**
   * No-op unless something actually changed — assigning canvas.width
   * reallocates the drawing buffer, so this must not run blindly per frame.
   */
  resize(): void {
    const canvas = this.renderer.domElement;
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    const dpr = window.devicePixelRatio;
    const wantW = Math.floor(width * dpr);
    const wantH = Math.floor(height * dpr);
    if (canvas.width === wantW && canvas.height === wantH) return;

    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    // yaw increases turning left, so it maps to a positive rotation about +Y.
    const yawRad = MathUtils.degToRad(this.yaw);
    const pitchRad = MathUtils.degToRad(this.pitch);
    const cosPitch = Math.cos(pitchRad);
    this.camera.lookAt(
      -Math.sin(yawRad) * cosPitch * 100,
      Math.sin(pitchRad) * 100,
      -Math.cos(yawRad) * cosPitch * 100,
    );
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.detachVideo();
    this.renderer.dispose();
  }
}
