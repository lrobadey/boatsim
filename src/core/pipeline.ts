import * as THREE from 'three';
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  BloomEffect,
  ToneMappingEffect,
  ToneMappingMode,
  SMAAEffect,
  SMAAPreset,
  VignetteEffect,
  Effect,
  BlendFunction,
} from 'postprocessing';
import { Quality } from './quality';

export const LAYER_REFRACT = 1; // objects visible through the water surface (seabed, hull)
export const LAYER_NOREFLECT = 2; // drawn by the main camera but left out of the sea reflection (vegetation)

/** Exposure + colour grade applied in HDR before tone mapping ("postcard Aegean"). */
class GradeEffect extends Effect {
  constructor() {
    super(
      'GradeEffect',
      /* glsl */ `
      uniform float exposure;
      uniform float saturation;
      uniform float warmth;
      uniform float spyglass;
      uniform float nightTint;
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec3 c = inputColor.rgb * exposure;
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        // saturation, slightly stronger in mid tones
        float midW = smoothstep(0.0, 0.4, l) * (1.0 - smoothstep(1.5, 6.0, l));
        c = max(mix(vec3(l), c, saturation + 0.12 * midW), 0.0);
        // split tone: teal shadows, warm highlights
        vec3 shadowTint = vec3(0.93, 1.0, 1.06);
        vec3 hiTint = vec3(1.0 + 0.06 * warmth, 1.0 + 0.015 * warmth, 1.0 - 0.06 * warmth);
        c *= mix(shadowTint, hiTint, smoothstep(0.05, 1.2, l));
        // moonlit night: blue shift & desaturate (scotopic)
        float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(c, lum * vec3(0.62, 0.78, 1.12), nightTint * 0.55);
        // spyglass: circular mask
        if (spyglass > 0.0) {
          vec2 p = (uv - 0.5) * vec2(resolution.x / resolution.y, 1.0);
          float r = length(p);
          float mask = 1.0 - smoothstep(0.40, 0.44, r);
          c *= mix(1.0, mask, spyglass);
        }
        outputColor = vec4(c, inputColor.a);
      }`,
      {
        blendFunction: BlendFunction.SRC,
        uniforms: new Map<string, THREE.Uniform>([
          ['exposure', new THREE.Uniform(1)],
          ['saturation', new THREE.Uniform(1.12)],
          ['warmth', new THREE.Uniform(1)],
          ['spyglass', new THREE.Uniform(0)],
          ['nightTint', new THREE.Uniform(0)],
        ]),
      },
    );
  }
}

export class Pipeline {
  readonly renderer: THREE.WebGLRenderer;
  readonly composer: EffectComposer;
  readonly grade: GradeEffect;
  readonly bloom: BloomEffect;
  readonly refractTarget: THREE.WebGLRenderTarget;
  readonly reversedDepth: boolean;
  renderScale: number;
  private renderPass: RenderPass;
  private width = 1;
  private height = 1;
  // adaptive resolution
  private frameIntervals: number[] = [];
  private refreshMs = 1000 / 60;
  private missWindow: number[] = [];
  private adaptHold = 0;
  private goodTime = 0;
  adaptive = true;
  /** frame-rate cap: the game presents at most this often (a steady 60 beats a ragged 120) */
  targetFps = 60;
  // GPU frame timing (EXT_disjoint_timer_query_webgl2): lets the resolution adapt to real headroom
  // even while the frame rate is capped
  private timerExt: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
  private activeQuery: WebGLQuery | null = null;
  private pendingQueries: WebGLQuery[] = [];
  gpuMs = 0;
  private upBlockedAt = 0; // render scale that last overloaded the GPU (don't retry it for a while)
  private upBlockT = 0;

  constructor(canvas: HTMLCanvasElement, private scene: THREE.Scene, private camera: THREE.PerspectiveCamera, private quality: Quality) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: false,
      reversedDepthBuffer: true,
    });
    this.reversedDepth = this.renderer.capabilities.reversedDepthBuffer;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderScale = quality.renderScale;
    this.renderer.setPixelRatio(this.renderScale);

    this.composer = new EffectComposer(this.renderer, {
      frameBufferType: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    this.grade = new GradeEffect();
    this.bloom = new BloomEffect({
      mipmapBlur: true,
      luminanceThreshold: 3.2,
      luminanceSmoothing: 0.6,
      intensity: 0.45,
      radius: 0.62,
      levels: 8,
    });
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    const vignette = new VignetteEffect({ offset: 0.3, darkness: 0.42 });
    this.composer.addPass(new EffectPass(camera, this.grade, this.bloom, tone, vignette));
    this.composer.addPass(new EffectPass(camera, new SMAAEffect({ preset: SMAAPreset.HIGH })));

    // Refraction pre-pass target: colour + float depth of everything below the water surface
    const dt = new THREE.DepthTexture(1, 1, THREE.FloatType);
    dt.format = THREE.DepthFormat;
    this.refractTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      depthTexture: dt,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });

    this.timerExt = this.renderer.getContext().getExtension('EXT_disjoint_timer_query_webgl2');

    // measure the display refresh interval for adaptive resolution
    let last = performance.now();
    let n = 0;
    const probe = () => {
      const now = performance.now();
      this.frameIntervals.push(now - last);
      last = now;
      if (++n < 40) requestAnimationFrame(probe);
      else {
        const s = this.frameIntervals.slice(5).sort((a, b) => a - b);
        this.refreshMs = s[Math.floor(s.length / 2)];
      }
    };
    requestAnimationFrame(probe);
  }

  /** planar reflection target size for the current drawing buffer */
  get reflectSize() {
    const k = this.renderScale * (this.quality.reflectionScale || 0.5);
    return new THREE.Vector2(Math.max(1, Math.floor(this.width * k)), Math.max(1, Math.floor(this.height * k)));
  }

  get refreshRate() {
    return 1000 / this.refreshMs;
  }
  /** presented frame interval: the display refresh or the cap, whichever is slower */
  get frameBudgetMs() {
    return Math.max(this.refreshMs, 1000 / this.targetFps);
  }

  /** bracket all of a frame's GPU work */
  beginGpuTimer() {
    const ext = this.timerExt;
    if (!ext || this.activeQuery || this.pendingQueries.length > 4) return;
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const q = gl.createQuery();
    if (!q) return;
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    this.activeQuery = q;
  }
  endGpuTimer() {
    const ext = this.timerExt;
    if (!ext) return;
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (this.activeQuery) {
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      this.pendingQueries.push(this.activeQuery);
      this.activeQuery = null;
    }
    while (this.pendingQueries.length) {
      const q = this.pendingQueries[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
      if (!disjoint && ms > 0) this.gpuMs = this.gpuMs === 0 ? ms : this.gpuMs + (ms - this.gpuMs) * 0.08;
      gl.deleteQuery(q);
      this.pendingQueries.shift();
    }
  }

  setSize(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(this.renderScale);
    this.composer.setSize(w, h);
    const rs = this.quality.refractionScale;
    this.refractTarget.setSize(Math.max(1, Math.floor(w * this.renderScale * rs)), Math.max(1, Math.floor(h * this.renderScale * rs)));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setRenderScale(s: number) {
    s = Math.max(this.quality.minScale, Math.min(this.quality.maxScale, s));
    if (Math.abs(s - this.renderScale) < 0.01) return;
    this.renderScale = s;
    this.setSize(this.width, this.height);
  }

  /**
   * Adaptive resolution. With GPU timing: keep the frame's GPU time inside ~60-85% of the budget
   * (step down fast when over, creep up slowly when there's room, and don't retry a scale that
   * overloaded recently). Without it: fall back to counting missed frames.
   */
  adapt(frameMs: number, dt: number) {
    if (!this.adaptive) return;
    const budget = this.frameBudgetMs;
    this.adaptHold -= dt;
    this.upBlockT -= dt;
    if (this.gpuMs > 0) {
      if (this.adaptHold > 0) return;
      if (this.gpuMs > budget * 0.85) {
        this.upBlockedAt = this.renderScale;
        this.upBlockT = 45;
        this.setRenderScale(this.renderScale * Math.sqrt((budget * 0.72) / this.gpuMs));
        this.adaptHold = 1.5;
        this.goodTime = 0;
      } else if (this.gpuMs < budget * 0.6 && this.renderScale < this.quality.maxScale) {
        this.goodTime += dt;
        const next = Math.min(this.quality.maxScale, this.renderScale + 0.1);
        if (this.goodTime > 3 && !(this.upBlockT > 0 && next >= this.upBlockedAt - 0.01)) {
          this.setRenderScale(next);
          this.adaptHold = 2;
          this.goodTime = 0;
        }
      } else this.goodTime = 0;
      return;
    }
    this.missWindow.push(frameMs > budget * 1.35 ? 1 : 0);
    if (this.missWindow.length > 90) this.missWindow.shift();
    if (this.adaptHold > 0 || this.missWindow.length < 60) return;
    const misses = this.missWindow.reduce((a, b) => a + b, 0) / this.missWindow.length;
    if (misses > 0.12) {
      this.setRenderScale(this.renderScale - 0.15);
      this.adaptHold = 2.5;
      this.missWindow.length = 0;
      this.goodTime = 0;
    } else if (misses < 0.01) {
      this.goodTime += dt;
      if (this.goodTime > 6 && this.renderScale < this.quality.maxScale) {
        this.setRenderScale(this.renderScale + 0.1);
        this.adaptHold = 3;
        this.goodTime = 0;
        this.missWindow.length = 0;
      }
    } else this.goodTime = 0;
  }

  render(dt: number, prePass: () => void) {
    // 1. refraction pre-pass: only the layer of things seen under water
    const r = this.renderer;
    const mask = this.camera.layers.mask;
    this.camera.layers.set(LAYER_REFRACT);
    r.setRenderTarget(this.refractTarget);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, false);
    prePass();
    r.render(this.scene, this.camera);
    this.camera.layers.mask = mask;
    r.setRenderTarget(null);
    // 2. main render + post
    this.composer.render(dt);
  }
}
