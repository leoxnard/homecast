/**
 * The 360° renderer (PLAN §4.3, M2).
 *
 * Every screen pixel is turned into a direction and looked up in the
 * equirectangular frame by a fragment shader. That replaces the original
 * inverted sphere mesh, because a sphere seen through a perspective camera can
 * only do one projection — rectilinear — which smears past ~150° and cannot
 * exceed 180° at all. The shader blends continuously from rectilinear into
 * stereographic as the view widens, so zooming out ends in a "tiny planet".
 */
import {
  Mesh, PerspectiveCamera, OrthographicCamera, Scene, PlaneGeometry, ShaderMaterial,
  VideoTexture, WebGLRenderer, NoColorSpace, LinearFilter, RepeatWrapping,
  ClampToEdgeWrapping, MathUtils, WebGLRenderTarget, RGBAFormat, UnsignedByteType,
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
/** Straight down, a well-sized tiny planet — where the tilt completes and P lands. */
export const PLANET_FOV = 250;
/** Normal zoom-out stop: keep going past the planet for an even tinier world. */
export const MAX_ZOOM_OUT_FOV = 300;
const HARD_MAX_FOV = 320;
/** Rectilinear up to here — the ordinary view, where pixel maths applies. */
export const RECTILINEAR_MAX_FOV = 110;
/** Fully stereographic from here on. */
const STEREOGRAPHIC_FOV = 170;

export const DEFAULT_FOV = 100;

const VERTEX = /* glsl */ `
  varying vec2 vNdc;
  void main() {
    vNdc = position.xy;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/**
 * Generalised perspective projection from a point `d` behind the sphere centre:
 * d = 0 is rectilinear (an ordinary camera), d = 1 is stereographic (tiny
 * planet when looking straight down). For image-plane point (u, v) the unit
 * direction satisfies x = u(z + d), y = v(z + d), x² + y² + z² = 1.
 */
const FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  uniform float yaw;
  uniform float pitch;
  uniform float halfHeight;
  uniform float d;
  uniform float aspect;
  uniform bool hasVideo;
  varying vec2 vNdc;
  const float PI = 3.141592653589793;

  void main() {
    if (!hasVideo) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    float u = vNdc.x * aspect * halfHeight;
    float v = vNdc.y * halfHeight;
    float r2 = u * u + v * v;
    float z = (-r2 * d + sqrt(r2 * (1.0 - d * d) + 1.0)) / (r2 + 1.0);
    // camera space: right +X, up +Y, forward -Z
    vec3 c = vec3(u * (z + d), v * (z + d), -z);

    // pitch about X (positive looks up), then yaw about Y (positive turns left)
    float cp = cos(pitch), sp = sin(pitch);
    c = vec3(c.x, c.y * cp - c.z * sp, c.y * sp + c.z * cp);
    float cy = cos(yaw), sy = sin(yaw);
    c = vec3(c.x * cy + c.z * sy, c.y, -c.x * sy + c.z * cy);
    vec3 dir = normalize(c);

    // yaw 0 (-Z) is the frame's centre column; -X (yaw 90) is u = 0.25.
    float lon = atan(-dir.x, -dir.z);
    float lat = asin(clamp(dir.y, -1.0, 1.0));
    gl_FragColor = texture2D(map, vec2(0.5 - lon / (2.0 * PI), 0.5 + lat / PI));
  }
`;

export class Viewer {
  readonly renderer: WebGLRenderer;
  /** Overlays that live in the world (presence markers), drawn on top. */
  readonly scene = new Scene();
  /** Kept for overlays and screen projection; valid while the view is rectilinear. */
  readonly camera: PerspectiveCamera;
  private readonly backdrop = new Scene();
  private readonly backdropCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: ShaderMaterial;
  private texture?: VideoTexture;
  private video?: HTMLVideoElement;
  /**
   * Render on demand. A full-screen shader pass at Retina size on every display
   * refresh (120 Hz on ProMotion) kept the GPU at ~75% even while paused; the
   * picture only changes when a video frame arrives, the view moves, the canvas
   * resizes, or an overlay changes.
   */
  private frameVersion = 0;
  private overlayVersion = 0;
  private lastKey = "";
  private frameCallback?: number;

  yaw = 0;
  pitch = 0;
  private fovDeg = DEFAULT_FOV;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
    // §5.6: never setPixelRatio(1) — that throws away half the Retina sharpness,
    // and §5.1 shows we are already pixel-starved.
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.autoClear = false;
    this.camera = new PerspectiveCamera(DEFAULT_FOV, 1, 0.1, 1100);

    this.material = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        map: { value: null },
        yaw: { value: 0 },
        pitch: { value: 0 },
        halfHeight: { value: 1 },
        d: { value: 0 },
        aspect: { value: 1 },
        hasVideo: { value: false },
      },
      depthTest: false,
      depthWrite: false,
    });
    const quad = new Mesh(new PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.backdrop.add(quad);
    this.resize();
  }

  attachVideo(video: HTMLVideoElement): void {
    this.detachVideo();
    this.video = video;
    const texture = new VideoTexture(video);
    // Raw bytes in, raw bytes out — the shader does no colour management, so
    // the frame is shown exactly as decoded.
    texture.colorSpace = NoColorSpace;
    texture.minFilter = LinearFilter; // no mipmaps: the frame changes every tick
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = false;
    // Longitude wraps; latitude does not.
    texture.wrapS = RepeatWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    this.texture = texture;
    this.material.uniforms.map!.value = texture;
    this.material.uniforms.hasVideo!.value = true;
    this.frameVersion++;
    if ("requestVideoFrameCallback" in video) {
      const onFrame = () => {
        this.frameVersion++;
        this.frameCallback = video.requestVideoFrameCallback(onFrame);
      };
      this.frameCallback = video.requestVideoFrameCallback(onFrame);
    }
    for (const type of ["loadeddata", "seeked", "emptied"]) video.addEventListener(type, this.bumpFrame);
  }

  private readonly bumpFrame = () => void this.frameVersion++;

  /**
   * The current video frame, downscaled, as a JPEG. Read back through WebGL
   * rather than drawn into a 2D canvas: Safari paints hardware-decoded video
   * into a 2D canvas as solid black, but uploads it to WebGL correctly (it is
   * what the player shows). Returns undefined for an all-black frame so the
   * caller can try again later.
   */
  async snapshot(width: number): Promise<Blob | undefined> {
    const video = this.video;
    const texture = this.texture;
    if (!video || !texture || !video.videoWidth) return undefined;
    const height = Math.round((width * video.videoHeight) / video.videoWidth);

    const target = new WebGLRenderTarget(width, height, { format: RGBAFormat, type: UnsignedByteType, depthBuffer: false });
    const material = new ShaderMaterial({
      uniforms: { map: { value: texture } },
      vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: "uniform sampler2D map; varying vec2 vUv; void main() { gl_FragColor = texture2D(map, vUv); }",
      depthTest: false,
      depthWrite: false,
    });
    const quad = new Mesh(new PlaneGeometry(2, 2), material);
    quad.frustumCulled = false;
    const scene = new Scene().add(quad);
    const pixels = new Uint8Array(width * height * 4);
    try {
      texture.needsUpdate = true; // upload the frame on screen now, not at the next video frame
      this.renderer.setRenderTarget(target);
      this.renderer.render(scene, this.backdropCamera);
      this.renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    } finally {
      this.renderer.setRenderTarget(null);
      target.dispose();
      material.dispose();
      quad.geometry.dispose();
      this.lastKey = ""; // the default framebuffer must be redrawn
    }

    let sum = 0;
    for (let i = 0; i < pixels.length; i += 97) sum += pixels[i]!;
    if (sum / (pixels.length / 97) < 3) return undefined;

    // WebGL rows run bottom-up.
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    const image = ctx.createImageData(width, height);
    const row = width * 4;
    for (let y = 0; y < height; y++) {
      image.data.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    }
    ctx.putImageData(image, 0, 0);
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? undefined), "image/jpeg", 0.72));
  }

  /** Something drawn outside the viewer's own state changed (e.g. presence markers). */
  invalidate(): void {
    this.overlayVersion++;
  }

  detachVideo(): void {
    if (this.video && this.frameCallback !== undefined) this.video.cancelVideoFrameCallback(this.frameCallback);
    this.frameCallback = undefined;
    for (const type of ["loadeddata", "seeked", "emptied"]) this.video?.removeEventListener(type, this.bumpFrame);
    this.frameVersion++;
    this.texture?.dispose();
    this.texture = undefined;
    this.video = undefined;
    this.material.uniforms.map!.value = null;
    this.material.uniforms.hasVideo!.value = false;
  }

  /** Source pixels per degree, vertically. Equirect height covers exactly 180°. */
  sourcePixelsPerDegree(): number | undefined {
    const h = this.video?.videoHeight;
    return h ? h / 180 : undefined;
  }

  /** Rendered device pixels per degree at the current FOV. */
  renderedPixelsPerDegree(fov = this.fovDeg): number {
    const heightDevicePx = this.renderer.domElement.height;
    return heightDevicePx / fov;
  }

  /**
   * >1 means the source is being magnified; <1 means it is being downsampled.
   * Undefined once the projection bends — "pixels per degree" stops being one
   * number across the screen.
   */
  magnification(fov = this.fovDeg): number | undefined {
    if (fov > RECTILINEAR_MAX_FOV) return undefined;
    const src = this.sourcePixelsPerDegree();
    return src ? this.renderedPixelsPerDegree(fov) / src : undefined;
  }

  /**
   * §4.3: limits *computed* from file resolution × window size, not hardcoded.
   * `native` is the FOV where one source pixel lands on one device pixel; `min`
   * is where we upscale MAX_UPSCALE×; `max` is a full tiny planet.
   */
  fovLimits(): FovLimits {
    const src = this.sourcePixelsPerDegree();
    if (!src) return { max: MAX_ZOOM_OUT_FOV, min: 30, native: DEFAULT_FOV };
    const native = this.renderer.domElement.height / src;
    return {
      max: MAX_ZOOM_OUT_FOV,
      min: Math.max(HARD_MIN_FOV, native / MAX_UPSCALE),
      native,
    };
  }

  /** True when we are within ~1.5% of exact pixel mapping. */
  isNative(): boolean {
    const m = this.magnification();
    return m !== undefined && Math.abs(m - 1) < 0.015;
  }

  /** Set the field of view exactly. Used for restoring state (sync, chapters). */
  setFov(fov: number, unlocked = false): void {
    const limits = this.fovLimits();
    const lo = unlocked ? HARD_MIN_FOV : Math.min(limits.min, limits.max);
    const hi = unlocked ? HARD_MAX_FOV : Math.max(limits.min, limits.max);
    this.fovDeg = MathUtils.clamp(fov, lo, hi);
  }

  /**
   * A user zoom. Identical to setFov inside the ordinary range; past the point
   * where the projection turns stereographic it also tilts the view toward the
   * ground, so zooming out lands on a tiny planet and zooming back in returns
   * to where you were looking. Dragging in between is respected: the pitch you
   * would return to is recomputed from wherever you now are.
   */
  zoomTo(fov: number, unlocked = false): void {
    const before = this.planetAmount(this.fovDeg);
    this.setFov(fov, unlocked);
    const after = this.planetAmount(this.fovDeg);
    if (before === after) return;

    const origin = before < 1 ? (this.pitch + 89.9 * before) / (1 - before) : this.planetOrigin;
    this.planetOrigin = MathUtils.clamp(origin, -89.9, 89.9);
    this.pitch = MathUtils.clamp(MathUtils.lerp(this.planetOrigin, -89.9, after), -89.9, 89.9);
  }

  /** Pitch to return to when leaving the tiny planet. */
  private planetOrigin = 0;

  /** 0 at the stereographic threshold, 1 at a full tiny planet. */
  private planetAmount(fov: number): number {
    return MathUtils.clamp((fov - STEREOGRAPHIC_FOV) / (PLANET_FOV - STEREOGRAPHIC_FOV), 0, 1);
  }

  get fov(): number {
    return this.fovDeg;
  }

  /** True once the view is bent enough that world-space overlays would be misplaced. */
  get isRectilinear(): boolean {
    return this.fovDeg <= RECTILINEAR_MAX_FOV;
  }

  look(yaw: number, pitch: number): void {
    this.yaw = ((yaw % 360) + 360) % 360;
    this.pitch = MathUtils.clamp(pitch, -89.9, 89.9);
  }

  get state(): ViewState {
    return { yaw: this.yaw, pitch: this.pitch, fov: this.fovDeg };
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

  /** Draw if anything visible changed since the last draw. Returns whether it drew. */
  render(): boolean {
    const canvas = this.renderer.domElement;
    // Without requestVideoFrameCallback there is no signal for new frames: draw while playing.
    const blind = !!this.video && !this.video.paused && !("requestVideoFrameCallback" in this.video);
    const key = `${this.yaw},${this.pitch},${this.fovDeg},${canvas.width}x${canvas.height},${this.frameVersion},${this.overlayVersion},${!!this.video}`;
    if (key === this.lastKey && !blind) return false;
    this.lastKey = key;

    const fov = this.fovDeg;
    // Blend rectilinear → stereographic between the two thresholds.
    const t = MathUtils.clamp((fov - RECTILINEAR_MAX_FOV) / (STEREOGRAPHIC_FOV - RECTILINEAR_MAX_FOV), 0, 1);
    const d = t * t * (3 - 2 * t);
    const half = MathUtils.degToRad(fov / 2);

    const u = this.material.uniforms;
    u.yaw!.value = MathUtils.degToRad(this.yaw);
    u.pitch!.value = MathUtils.degToRad(this.pitch);
    u.d!.value = d;
    u.halfHeight!.value = Math.sin(half) / (Math.cos(half) + d);
    u.aspect!.value = this.camera.aspect;

    this.renderer.clear();
    this.renderer.render(this.backdrop, this.backdropCamera);

    // The perspective camera only drives overlays, so keep it inside its valid range.
    const yawRad = MathUtils.degToRad(this.yaw);
    const pitchRad = MathUtils.degToRad(this.pitch);
    const cosPitch = Math.cos(pitchRad);
    this.camera.fov = Math.min(fov, 170);
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(
      -Math.sin(yawRad) * cosPitch * 100,
      Math.sin(pitchRad) * 100,
      -Math.cos(yawRad) * cosPitch * 100,
    );
    this.scene.visible = this.isRectilinear;
    if (this.scene.visible) this.renderer.render(this.scene, this.camera);
    return true;
  }

  dispose(): void {
    this.detachVideo();
    this.material.dispose();
    this.renderer.dispose();
  }
}
